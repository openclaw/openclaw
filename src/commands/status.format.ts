import { formatDurationPrecise } from "../infra/format-time/format-duration.ts";
import { formatRuntimeStatusWithDetails } from "../infra/runtime-status.ts";
import type { SessionStatus } from "./status.types.js";
export { shortenText } from "./text-format.js";

export const formatKTokens = (value: number) =>
  `${(value / 1000).toFixed(value >= 10_000 ? 0 : 1)}k`;

export const formatDuration = (ms: number | null | undefined) => {
  if (ms == null || !Number.isFinite(ms)) {
    return "unknown";
  }
  return formatDurationPrecise(ms, { decimals: 1 });
};

export const formatTokensCompact = (
  sess: Pick<
    SessionStatus,
    "totalTokens" | "contextTokens" | "percentUsed" | "cacheRead" | "cacheWrite" | "inputTokens"
  >,
) => {
  const used = sess.totalTokens;
  const ctx = sess.contextTokens;
  const cacheRead = sess.cacheRead;
  const cacheWrite = sess.cacheWrite;

  let result = "";
  if (used == null) {
    result = ctx ? `unknown/${formatKTokens(ctx)} (?%)` : "unknown used";
  } else if (!ctx) {
    result = `${formatKTokens(used)} used`;
  } else {
    const pctLabel = sess.percentUsed != null ? `${sess.percentUsed}%` : "?%";
    result = `${formatKTokens(used)}/${formatKTokens(ctx)} (${pctLabel})`;
  }

  // Add cache hit rate if there are cached reads.
  // The denominator must be the total *input* volume (fresh input + cache reads),
  // not the session's net token spend.  Using totalTokens (which includes output
  // tokens) produces rates above 100% when cache reads are large relative to
  // fresh input — e.g. a long-running cron session that re-reads the same
  // context repeatedly can show "199% cached".
  if (typeof cacheRead === "number" && cacheRead > 0) {
    const inputTokens = sess.inputTokens;
    const denominator =
      typeof inputTokens === "number" && inputTokens > 0
        ? inputTokens // preferred: fresh+cached input
        : cacheRead + (typeof cacheWrite === "number" ? cacheWrite : 0); // fallback: cache tokens only
    const hitRate = Math.min(100, Math.round((cacheRead / denominator) * 100));
    result += ` · 🗄️ ${hitRate}% cached`;
  }

  return result;
};

export const formatDaemonRuntimeShort = (runtime?: {
  status?: string;
  pid?: number;
  state?: string;
  detail?: string;
  missingUnit?: boolean;
}) => {
  if (!runtime) {
    return null;
  }
  const details: string[] = [];
  const detail = runtime.detail?.replace(/\s+/g, " ").trim() || "";
  const noisyLaunchctlDetail =
    runtime.missingUnit === true && detail.toLowerCase().includes("could not find service");
  if (detail && !noisyLaunchctlDetail) {
    details.push(detail);
  }
  return formatRuntimeStatusWithDetails({
    status: runtime.status,
    pid: runtime.pid,
    state: runtime.state,
    details,
  });
};
