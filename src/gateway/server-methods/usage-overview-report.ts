import { resolveRuntimeProcessEntrypointUrl } from "../../infra/runtime-process-url.js";
import { readUsageOverviewSortValue } from "../../infra/session-cost-usage-overview-batch.js";
import {
  buildUsageOverviewReport,
  readUsageOverviewPage,
  type UsageOverviewPackedUsage,
  type UsageOverviewReportInput,
  type UsageOverviewTask,
  type UsageOverviewTaskResult,
} from "../../infra/session-cost-usage-overview-report.js";
import type { UsageDailyBucket } from "../../infra/session-cost-usage.js";
import { WorkerTaskPool } from "../../infra/worker-task-pool.js";
import { getAsyncWorkSignal } from "../../shared/async-work-scope.js";
import {
  selectUsageModelCohorts,
  type UsageModelCohorts,
} from "../../shared/usage-model-cohorts.js";
import { usageOverviewPage } from "../../shared/usage-table-page.js";
import type {
  SessionUsageEntry,
  UsageOverviewOptions,
  UsageOverviewSlice,
} from "../../shared/usage-types.js";

/** Packed overview usage of one loaded snapshot; rows reference it by agent and key. */
export type UsageOverviewUsage = {
  packed: UsageOverviewPackedUsage[];
  refs: Map<string, readonly [number, number]>;
  /** Completed preparation follows this snapshot's existing cache lifetime. */
  prepared?: { members: string; cohorts: UsageModelCohorts };
};

export const usageOverviewRowKey = (row: Pick<SessionUsageEntry, "agentId" | "key">) =>
  `${row.agentId ?? ""}\u0000${row.key}`;

const pool = new WorkerTaskPool<UsageOverviewTask, UsageOverviewTaskResult>({
  workerClass: "compute",
  sharedCompute: true,
  workerUrl: resolveRuntimeProcessEntrypointUrl("usageOverview"),
});

type UsageOverviewReportParams = {
  usage: UsageOverviewUsage;
  options: UsageOverviewOptions;
  dayBucket: UsageDailyBucket;
};

/**
 * Report input for the visible rows. Rows carry only the fields the shared overview
 * owner reads; the Gateway restores full rows on the returned page.
 */
function usageOverviewReportInput(
  params: UsageOverviewReportParams & { rows: SessionUsageEntry[] },
): UsageOverviewReportInput {
  const rows = params.rows.map((row): UsageOverviewReportInput["rows"][number] => ({
    key: row.key,
    label: row.label,
    sessionId: row.sessionId,
    updatedAt: row.updatedAt,
    agentId: row.agentId,
    channel: row.channel,
    chatType: row.chatType,
    model: row.model,
    modelProvider: row.modelProvider,
    providerOverride: row.providerOverride,
    origin: row.origin?.provider ? { provider: row.origin.provider } : undefined,
    creatorKey: row.creatorKey,
    createdActor: row.createdActor,
    computing: row.computing,
    hasContextWeight: row.hasContextWeight,
    usage: row.usage,
    usageRef: params.usage.refs.get(usageOverviewRowKey(row)),
  }));
  return {
    packed: params.usage.packed,
    rows,
    options: params.options,
    dayBucket: params.dayBucket,
  };
}

// Membership includes context availability: query filters can read it.
const usageOverviewMembers = (rows: readonly SessionUsageEntry[]) =>
  rows.map((row) => `${usageOverviewRowKey(row)}\u0000${row.hasContextWeight ? 1 : 0}`).join("\n");

export async function prepareUsageOverviewUsage(params: {
  usage: UsageOverviewUsage;
  rows: SessionUsageEntry[];
  dayBucket: UsageDailyBucket;
}): Promise<void> {
  const input = usageOverviewReportInput({ ...params, options: {} });
  const result = await pool.run(
    { kind: "prepare", input },
    {
      signal: getAsyncWorkSignal(),
      inputBytes: usageOverviewInputBytes(params.usage, params.rows.length),
    },
  );
  if (result.kind !== "prepared") {
    throw new Error("Expected prepared Usage cohorts");
  }
  params.usage.prepared = { members: usageOverviewMembers(params.rows), cohorts: result.value };
}

function usageOverviewInputBytes(usage: UsageOverviewUsage, rows: number) {
  return usage.packed.reduce(
    (sum, { batch }) => sum + batch.values.byteLength + batch.offsets.byteLength,
    rows * 512,
  );
}

/** Overview report runner for one request; `undefined` when it has no packed overview. */
export type UsageOverviewReporter = {
  /** Aggregate off the Gateway thread; repeated rows reuse the running report. */
  run: (rows: SessionUsageEntry[]) => Promise<UsageOverviewSlice>;
  /** True when the last `run` covered exactly these rows. */
  covers: (rows: readonly SessionUsageEntry[]) => boolean;
  /** Aggregate on the calling thread without an await. */
  local: (rows: SessionUsageEntry[]) => UsageOverviewSlice;
};

export function createUsageOverviewReporter(params: {
  usage: UsageOverviewUsage | undefined;
  options: UsageOverviewOptions | undefined;
  dayBucket: UsageDailyBucket;
}): UsageOverviewReporter | undefined {
  const { usage, options, dayBucket } = params;
  if (!usage || !options) {
    return undefined;
  }
  let report:
    | {
        members: string;
        rows: SessionUsageEntry[];
        cohort: boolean;
        slice: Promise<UsageOverviewSlice>;
      }
    | undefined;
  return {
    run(rows) {
      const members = usageOverviewMembers(rows);
      if (report?.members !== members) {
        const previous = report;
        // This request's context hydration clones rows without changing model usage.
        if (
          previous?.cohort &&
          rows.length === previous.rows.length &&
          rows.every((row, index) => {
            const source = previous.rows[index]!;
            return (
              row.key === source.key &&
              row.agentId === source.agentId &&
              row.sessionId === source.sessionId &&
              row.usage === source.usage
            );
          })
        ) {
          report = {
            ...previous,
            members,
            rows,
            slice: previous.slice.then((slice) => withVisibleUsageOverviewRows(slice, rows)),
          };
        } else {
          const prepared = usage.prepared;
          const selection =
            prepared?.members === members
              ? selectUsageModelCohorts(prepared.cohorts, options)
              : undefined;
          let task: UsageOverviewTask;
          if (selection) {
            const { indices, ...query } = selection;
            const page = usageOverviewPage(
              indices.map((index) => rows[index]!),
              options,
              options.sort && options.sort !== "recent"
                ? (row) => {
                    const ref = usage.refs.get(usageOverviewRowKey(row));
                    return ref
                      ? readUsageOverviewSortValue(
                          usage.packed[ref[0]]!.batch,
                          ref[1],
                          options.sort,
                        )
                      : undefined;
                  }
                : undefined,
            );
            task = {
              kind: "cohorts",
              input: {
                ...query,
                rows: readUsageOverviewPage(
                  usageOverviewReportInput({ rows: page, usage, options, dayBucket }),
                ),
              },
              options,
              dayBucket,
            };
          } else {
            task = {
              kind: "report",
              input: usageOverviewReportInput({ rows, usage, options, dayBucket }),
            };
          }
          report = {
            members,
            rows,
            cohort: Boolean(selection),
            slice: pool
              .run(task, {
                signal: getAsyncWorkSignal(),
                // Admission conservatively charges the request snapshot retained until completion.
                inputBytes: usageOverviewInputBytes(usage, rows.length),
              })
              .then((result) => {
                if (result.kind !== "report") {
                  throw new Error("Expected Usage report");
                }
                return result.value;
              }),
          };
        }
      }
      return report.slice;
    },
    covers: (rows) => report?.members === usageOverviewMembers(rows),
    local: (rows) =>
      buildUsageOverviewReport(usageOverviewReportInput({ rows, usage, options, dayBucket })),
  };
}

/** Report rows as the final visible rows, carrying the report's compact usage. */
export function withVisibleUsageOverviewRows(
  slice: UsageOverviewSlice,
  visible: readonly SessionUsageEntry[],
): UsageOverviewSlice {
  const requestedKeys = new Set([
    ...slice.sessions.map((row) => row.key),
    ...slice.overview.selectedRows.map((row) => row.key),
  ]);
  const byKey = new Map<string, SessionUsageEntry>();
  // Only index returned rows, but visit every duplicate so the last one still wins.
  for (const row of visible) {
    if (requestedKeys.has(row.key)) {
      byKey.set(usageOverviewRowKey(row), row);
    }
  }
  const restore = (row: SessionUsageEntry): SessionUsageEntry =>
    Object.assign({}, byKey.get(usageOverviewRowKey(row)) ?? row, { usage: row.usage });
  slice.sessions = slice.sessions.map(restore);
  slice.overview.selectedRows = slice.overview.selectedRows.map(restore);
  return slice;
}
