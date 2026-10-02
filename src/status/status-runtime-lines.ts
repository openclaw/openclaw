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

async function resolveSessionCostLine(params: {
  cfg: OpenClawConfig;
  agentId: string;
  sessionEntry?: SessionEntry;
  storePath?: string;
}): Promise<string | undefined> {
  const sessionId = params.sessionEntry?.sessionId?.trim();
  if (!sessionId) {
    return undefined;
  }
  let sessionFile: string | undefined;
  try {
    sessionFile = formatSqliteSessionFileMarker({
      sessionId,
      agentId: params.agentId,
      storePath: await preparePhysicalSessionStorePath(params, params.cfg),
    });
  } catch {
    return undefined;
  }
  if (!sessionFile) {
    return undefined;
  }
  const now = Date.now();
  const date = new Date(now);
  const startMs = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  try {
    const loaded = await withTimeout(
      loadSessionCostSummariesFromCache({
        sessions: [{ sessionId, sessionFile }],
        config: params.cfg,
        agentId: params.agentId,
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
      return undefined;
    }
    const cost =
      summary.missingCostEntries > 0
        ? `missing cost: ${formatMissingCostEntries(summary)}`
        : formatUsd(summary.totalCost);
    return `💵 ${cost ? `${cost} · ` : ""}${formatTokenCount(summary.totalTokens)} tok (today)`;
  } catch {
    return undefined;
  }
}

export async function appendSessionCostLine(
  usageLine: string | null,
  cfg: OpenClawConfig,
  agentId: string,
  sessionEntry?: SessionEntry,
  storePath?: string,
): Promise<string | null> {
  const line = await resolveSessionCostLine({
    cfg,
    agentId,
    ...(sessionEntry ? { sessionEntry } : {}),
    ...(storePath ? { storePath } : {}),
  });
  return line ? [usageLine, line].filter(Boolean).join("\n") : usageLine;
}
