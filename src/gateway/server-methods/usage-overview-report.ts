import { resolveRuntimeProcessEntrypointUrl } from "../../infra/runtime-process-url.js";
import {
  buildUsageOverviewReport,
  type UsageOverviewPackedUsage,
  type UsageOverviewReportInput,
} from "../../infra/session-cost-usage-overview-report.js";
import type { UsageDailyBucket } from "../../infra/session-cost-usage.js";
import { WorkerTaskPool } from "../../infra/worker-task-pool.js";
import { getAsyncWorkSignal } from "../../shared/async-work-scope.js";
import type {
  SessionUsageEntry,
  UsageOverviewOptions,
  UsageOverviewSlice,
} from "../../shared/usage-types.js";

/** Packed overview usage of one loaded snapshot; rows reference it by agent and key. */
export type UsageOverviewUsage = {
  packed: UsageOverviewPackedUsage[];
  refs: Map<string, readonly [number, number]>;
};

export const usageOverviewRowKey = (row: Pick<SessionUsageEntry, "agentId" | "key">) =>
  `${row.agentId ?? ""}\u0000${row.key}`;

const pool = new WorkerTaskPool<UsageOverviewReportInput, UsageOverviewSlice>({
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
  let report: { members: string; slice: Promise<UsageOverviewSlice> } | undefined;
  return {
    run(rows) {
      const members = usageOverviewMembers(rows);
      if (report?.members !== members) {
        const input = usageOverviewReportInput({ rows, usage, options, dayBucket });
        const packedBytes = usage.packed.reduce(
          (sum, { batch }) => sum + batch.values.byteLength + batch.offsets.byteLength,
          0,
        );
        report = {
          members,
          slice: pool.run(input, {
            signal: getAsyncWorkSignal(),
            inputBytes: packedBytes + input.rows.length * 512,
          }),
        };
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
  const byKey = new Map(visible.map((row) => [usageOverviewRowKey(row), row]));
  const restore = (row: SessionUsageEntry): SessionUsageEntry =>
    Object.assign({}, byKey.get(usageOverviewRowKey(row)) ?? row, { usage: row.usage });
  slice.sessions = slice.sessions.map(restore);
  slice.overview.selectedRows = slice.overview.selectedRows.map(restore);
  return slice;
}
