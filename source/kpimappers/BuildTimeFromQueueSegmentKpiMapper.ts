import * as moment from "moment"
import { KpiMapper } from "./KpiMapper"
import { IKpiState } from "./IKpiState"
import { SimpleMovingAveragePeriod } from "./SimpleMovingAveragePeriod"
import { Plotly } from "./Plotly"
const config = require("../../config/config")

/**
 * BuildTimeFromQueueSegmentKpiMapper with simple moving average.
 * 
 * Days with no data will not be plotted (ignored).
 */
export abstract class BuildTimeFromQueueSegmentKpiMapper extends KpiMapper
{
    // SQL GROUP data by this column
    protected abstract groupByColumn: string;

    // Data is filtered by the column name and value (empty string = no filter)
    // e.g. a table with columns DATE, CYCLE, DESCRIPTION
    //      if filterColumn = CYCLE
    //         filterValue = 'S2018A'
    //      only the S2018A cycle data will be returned
    protected abstract filterColumn: string;
    protected abstract filterValue: string;

    private _yAxisTitle: string = "Minutes (lower is better)";

    // Target and stretch goals
    private _targetGoal: number = config.kpi.goals.build_time_from_queue.target_minutes;
    private _stretchGoal: number = config.kpi.goals.build_time_from_queue.stretch_minutes;

    /**
     * Returns the query for the earliest start date of available data for this KPI Mapper.
     * @returns SQL query as string
     */
    protected getStartDateQuery(): string
    {
        return `
            SELECT MIN(BUILD_COMPLETED_DATE) AS 'DATE'
            FROM ${config.db.tablename.qa_builds_and_runs_from_bamboo};
        `;
    }

    /**
     * Returns the query for the latest end date of available data for this KPI Mapper.
     * @returns SQL query as string
     */
    protected getEndDateQuery(): string
    {
        return `
            SELECT MAX(BUILD_COMPLETED_DATE) AS 'DATE'
            FROM ${config.db.tablename.qa_builds_and_runs_from_bamboo};
        `;
    }

    /**
     * Returns an array of SQL query strings given a date range.
     * @param {string} from date
     * @param {string} to date
     * @param {number} dateRange between from and to dates
     * @returns {string[]} an array of one or more SQL query string
     * @override
     */
    protected getQueryStrings(from: string, to: string, dateRange: number): string[]
    {
        var movingAveragePeriod: number = SimpleMovingAveragePeriod.GetPeriod(dateRange);
        var minPrevDayData: number = Math.floor(movingAveragePeriod / 2);
        var nPrevDays: number = movingAveragePeriod - 1;
        var filterCondition: string = (!this.filterColumn || !this.filterValue)
            ? ""
            : `AND ${this.filterColumn} = ${this.filterValue}`;
        var dailyAvgBuildTimeSubquery: string =
        `(
            SELECT BUILD_COMPLETED_DATE AS 'BUILD_DATE'
                  ,AVG(MINUTES_TOTAL_QUEUE_AND_BUILD) AS 'AVG_BUILD_TIME'
            FROM ${config.db.tablename.qa_builds_and_runs_from_bamboo}
            WHERE (BUILD_COMPLETED_DATE BETWEEN
                  DATE_SUB('${from}', INTERVAL ${nPrevDays} DAY) AND '${to}')
              ${filterCondition}
            GROUP BY BUILD_DATE
        )`;
        var dailyAvgBuildTimeGroupedSubquery: string =
        `(
            SELECT BUILD_COMPLETED_DATE AS 'BUILD_DATE'
                  ,AVG(MINUTES_TOTAL_QUEUE_AND_BUILD) AS 'AVG_BUILD_TIME'
                  ,${this.groupByColumn}
            FROM ${config.db.tablename.qa_builds_and_runs_from_bamboo}
            WHERE (BUILD_COMPLETED_DATE BETWEEN
                  DATE_SUB('${from}', INTERVAL ${nPrevDays} DAY) AND '${to}')
              ${filterCondition}
            GROUP BY BUILD_DATE, ${this.groupByColumn}
        )`;
        return [
            // Overall
            `
                SELECT T1.BUILD_DATE AS 'DATE'
                      ,AVG(T2.AVG_BUILD_TIME) AS 'AVG_BUILD_TIME'
                FROM ${dailyAvgBuildTimeSubquery} T1
                LEFT JOIN ${dailyAvgBuildTimeSubquery} T2
                  ON T2.BUILD_DATE BETWEEN
                     DATE_SUB(T1.BUILD_DATE, INTERVAL ${nPrevDays} DAY) AND T1.BUILD_DATE
                WHERE T1.BUILD_DATE BETWEEN '${from}' AND '${to}'
                GROUP BY DATE
                ORDER BY DATE ASC
            `,
            // Segment split by this.groupByColumn
            `
                SELECT T1.BUILD_DATE AS 'DATE'
                      ,CASE WHEN COUNT(T2.BUILD_DATE) < ${minPrevDayData}
                            THEN NULL
                            ELSE AVG(T2.AVG_BUILD_TIME)
                            END AS 'AVG_BUILD_TIME'
                      ,T1.${this.groupByColumn} AS '${this.groupByColumn}'
                FROM ${dailyAvgBuildTimeGroupedSubquery} T1
                LEFT JOIN ${dailyAvgBuildTimeGroupedSubquery} T2
                  ON
                    (
                        T2.BUILD_DATE BETWEEN
                        DATE_SUB(T1.BUILD_DATE, INTERVAL ${nPrevDays} DAY) AND T1.BUILD_DATE
                    )
                    AND
                    (
                        T2.${this.groupByColumn} = T1.${this.groupByColumn}
                    )
                WHERE T1.BUILD_DATE BETWEEN '${from}' AND '${to}'
                GROUP BY DATE, ${this.groupByColumn}
                ORDER BY ${this.groupByColumn} ASC, DATE ASC
            `
        ];
    }

    /**
     * Returns a KpiState given multiple JSON arrays containing queried data.
     * @param {Array<any>[]} jsonArrays One or more JSON array results (potentially empty arrays)
     * @returns {IKpiState|null} IKpiState object or null when insufficient data
     * @override
     */
    protected mapToKpiStateOrNull(jsonArrays: Array<any>[]): IKpiState|null
    {
        // Invalid; Requires at least 2 data points
        if (jsonArrays[0].length < 2 || jsonArrays[1].length < 6)
        {
            return null;
        }

        // map chart data
        var traceLines: any = [];
        for (let i in jsonArrays)
        {
            // insufficient data, ignore trace line
            if (jsonArrays[i].length < 2)
            {
                continue;
            }

            // add each results of trace line into chart data
            for (let result of jsonArrays[i])
            {
                // Only the overall build line does not have property [this.groupByColumn]
                if (!result[this.groupByColumn])
                {
                    result[this.groupByColumn] = "Overall";
                }

                // create new trace line based on [this.groupByColumn] if non-existent
                if (!traceLines[result[this.groupByColumn]])
                {
                    traceLines[result[this.groupByColumn]] = Plotly.GetTraceLineData
                    (
                        result[this.groupByColumn],                         // title
                        [],                                                 // empty array
                        [],                                                 // empty array
                        (result[this.groupByColumn] == "Overall") ? 3 : 1   // width of trace line
                    );
                }

                // map x and y values of trace line
                traceLines[result[this.groupByColumn]].x.push(result.DATE);
                traceLines[result[this.groupByColumn]].y.push(result.AVG_BUILD_TIME);
            }
        }

        // add all trace lines to Plotly data object
        var data: any = [];
        for (let splitColumn in traceLines)
        {
            data.push(traceLines[splitColumn]);
        }

        // Return Plotly.js consumable
        return {
            data: data,
            layout: {
                title: this.Title,
                showlegend: true,
                legend: Plotly.GetLegendInfo(),
                xaxis: Plotly.GetDateXAxis(this.chartFromDate, this.chartToDate),
                yaxis: Plotly.GetYAxis(this._yAxisTitle),
                shapes: Plotly.GetShapesFromGoals(this._targetGoal, this._stretchGoal)
            },
            frames: [],
            config: {
                displayModeBar: false
            }
        };
    }
}