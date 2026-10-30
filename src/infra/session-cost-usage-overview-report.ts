import { buildUsageOverview } from "../shared/usage-overview.js";
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

/**
 * Build the Usage overview slice off the Gateway thread: expand the packed rows the
 * report needs, then run the shared overview owner over the visible rows.
 */
export function buildUsageOverviewReport(input: UsageOverviewReportInput): UsageOverviewSlice {
  const expanded = input.packed.map(({ batch, refreshing }) =>
    readUsageOverviewBatch(batch, refreshing),
  );
  const rows = input.rows.map(({ usageRef, ...row }): SessionUsageEntry => {
    if (usageRef) {
      const usage = expanded[usageRef[0]]?.[usageRef[1]] ?? null;
      if (usage) {
        usage.sessionId = row.sessionId;
      }
      row.usage = usage;
    }
    return row;
  });
  return buildUsageOverview({
    rows,
    options: input.options,
    dayBucket: input.dayBucket,
    compact: true,
  });
}
