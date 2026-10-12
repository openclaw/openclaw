import os from "node:os";
import type { SessionEntry } from "../config/sessions.js";
import { formatSqliteSessionFileMarker } from "../config/sessions/legacy-sqlite-marker.js";
import { preparePhysicalSessionStorePath } from "../config/sessions/session-store-path.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatDurationCompact } from "../infra/format-time/format-duration.ts";
import { withTimeout } from "../infra/fs-safe.js";
import { formatMissingCostEntries } from "../infra/session-cost-usage-totals.js";
import { loadSessionCostSummariesFromCache } from "../infra/session-cost-usage.js";
import { formatTokenCount, formatUsd } from "../utils/usage-format.js";

export function buildStatusUptimeValue(): string {
  const format = (ms: number) => formatDurationCompact(ms, { spaced: true }) ?? "0s";
  const gatewayMs = Math.max(0, Math.round(process.uptime() * 1000));
  const systemMs = Math.max(0, Math.round(os.uptime() * 1000));
  return `gateway ${format(gatewayMs)} · system ${format(systemMs)}`;
}

export async function appendSessionCostLine(
  usageLine: string | null,
  cfg: OpenClawConfig,
  agentId: string,
  sessionEntry?: SessionEntry,
  storePath?: string,
): Promise<string | null> {
  const sessionId = sessionEntry?.sessionId?.trim();
  if (!sessionId) {
    return usageLine;
  }
  let sessionFile: string;
  try {
    sessionFile = formatSqliteSessionFileMarker({
      sessionId,
      agentId,
      storePath: await preparePhysicalSessionStorePath(
        { agentId, ...(storePath ? { storePath } : {}) },
        cfg,
      ),
    });
  } catch {
    return usageLine;
  }
  const now = Date.now();
  const date = new Date(now);
  const startMs = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  try {
    const loaded = await withTimeout(
      loadSessionCostSummariesFromCache({
        sessions: [{ sessionId, sessionFile }],
        config: cfg,
        agentId,
        startMs,
        endMs: now,
        dayBucket: { mode: "utc-offset", utcOffsetMinutes: -date.getTimezoneOffset() },
        requestRefresh: false,
      }),
      3_500,
      { message: "session cost timeout" },
    );
    const summary = loaded.cacheStatus.status === "fresh" ? loaded.summaries[0] : null;
    if (!summary) {
      return usageLine;
    }
    const cost =
      summary.missingCostEntries > 0
        ? `missing cost: ${formatMissingCostEntries(summary)}`
        : formatUsd(summary.totalCost);
    const line = `💵 ${cost ? `${cost} · ` : ""}${formatTokenCount(summary.totalTokens)} tok (today)`;
    return [usageLine, line].filter(Boolean).join("\n");
  } catch {
    return usageLine;
  }
}
