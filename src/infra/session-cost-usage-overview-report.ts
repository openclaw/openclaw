import {
  buildUsageModelCohortReport,
  prepareUsageModelCohorts,
  type UsageModelCohortQuery,
  type UsageModelCohorts,
} from "../shared/usage-model-cohorts.js";
import { buildUsageOverview, compactUsageOverviewSession } from "../shared/usage-overview.js";
import type {
  SessionUsageEntry,
  UsageOverviewOptions,
  UsageOverviewSlice,
} from "../shared/usage-types.js";
import {
  readUsageOverviewBatch,
  type UsageOverviewBatch,
} from "./session-cost-usage-overview-batch.js";
import type { UsageDailyBucket } from "./session-cost-usage.types.js";

/** Packed per-agent fold output; `refreshing` marks stale rows whose refresh is scheduled. */
export type UsageOverviewPackedUsage = { batch: UsageOverviewBatch; refreshing: boolean };

export type UsageOverviewReportInput = {
  packed: UsageOverviewPackedUsage[];
  /**
   * Visible rows after selection, reduced to the fields the overview reads. A row with
   * `usageRef` reads its usage from `packed[usageRef[0]]` row `usageRef[1]`; other rows
   * carry their usage inline.
   */
  rows: Array<SessionUsageEntry & { usageRef?: readonly [number, number] }>;
  options: UsageOverviewOptions;
  dayBucket: UsageDailyBucket;
};

export type UsageOverviewTask =
  | { kind: "report"; input: UsageOverviewReportInput }
  | { kind: "prepare"; input: UsageOverviewReportInput }
  | {
      kind: "cohorts";
      input: UsageModelCohortQuery & { rows: SessionUsageEntry[] };
      options: UsageOverviewOptions;
      dayBucket: UsageDailyBucket;
    };

export type UsageOverviewTaskResult =
  | { kind: "report"; value: UsageOverviewSlice }
  | { kind: "prepared"; value: UsageModelCohorts };

/**
 * Build the Usage overview slice off the Gateway thread: expand the packed rows the
 * report needs, then run the shared overview owner over the visible rows.
 */
function expandUsageOverviewRows(input: UsageOverviewReportInput): SessionUsageEntry[] {
  const expanded = input.packed.map(({ batch, refreshing }) =>
    readUsageOverviewBatch(batch, refreshing),
  );
  return input.rows.map(({ usageRef, ...row }): SessionUsageEntry => {
    if (usageRef) {
      const usage = expanded[usageRef[0]]?.[usageRef[1]] ?? null;
      if (usage) {
        usage.sessionId = row.sessionId;
      }
      row.usage = usage;
    }
    return row;
  });
}

/** Decode only the requested page from the snapshot; never retain another population. */
export function readUsageOverviewPage(input: UsageOverviewReportInput): SessionUsageEntry[] {
  const rows = input.rows.map(({ usageRef: _usageRef, ...row }) => row);
  input.packed.forEach(({ batch, refreshing }, batchIndex) => {
    const positions: number[] = [];
    const indices: number[] = [];
    input.rows.forEach(({ usageRef }, index) => {
      if (usageRef?.[0] === batchIndex) {
        positions.push(index);
        indices.push(usageRef[1]);
      }
    });
    const summaries = readUsageOverviewBatch(batch, refreshing, indices);
    positions.forEach((position, index) => {
      const row = rows[position]!;
      const usage = summaries[index]!;
      if (usage) {
        usage.sessionId = row.sessionId;
      }
      row.usage = usage;
    });
  });
  const days = new Set<string>();
  return rows.map((row) => compactUsageOverviewSession(row, days));
}

export function buildUsageOverviewReport(input: UsageOverviewReportInput): UsageOverviewSlice {
  return buildUsageOverview({
    rows: expandUsageOverviewRows(input),
    options: input.options,
    dayBucket: input.dayBucket,
    compact: true,
  });
}

export function runUsageOverviewTask(task: UsageOverviewTask): UsageOverviewTaskResult {
  if (task.kind === "prepare") {
    return {
      kind: "prepared",
      value: prepareUsageModelCohorts(expandUsageOverviewRows(task.input), task.input.dayBucket),
    };
  }
  return {
    kind: "report",
    value:
      task.kind === "cohorts"
        ? buildUsageModelCohortReport(task.input, task.options, task.dayBucket, task.input.rows)
        : buildUsageOverviewReport(task.input),
  };
}
