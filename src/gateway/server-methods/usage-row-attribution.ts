import type { SessionModelUsage } from "../../infra/session-cost-usage.types.js";
import type { SessionUsageEntry } from "../../shared/usage-types.js";

/** Fill response metadata only, after usage hydration, filtering, and aggregation. */
export function withUsageRowAttribution(row: SessionUsageEntry): SessionUsageEntry {
  if (row.modelProvider != null && row.model != null) {
    return row;
  }
  let dominant: SessionModelUsage | undefined;
  for (const entry of row.usage?.modelUsage ?? []) {
    if (
      (row.modelProvider != null && entry.provider !== row.modelProvider) ||
      (row.model != null && entry.model !== row.model)
    ) {
      continue;
    }
    if (!dominant || entry.totals.totalTokens > dominant.totals.totalTokens) {
      dominant = entry;
    }
  }
  if (!dominant) {
    return row;
  }
  // Mixed-provider rows get representative metadata, not per-token attribution.
  // Fill from one entry consistent with any stored field; ties keep the first.
  // Without a consistent entry, the missing field stays empty.
  return {
    ...row,
    modelProvider: row.modelProvider ?? dominant.provider,
    model: row.model ?? dominant.model,
  };
}
