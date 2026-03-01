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
    "totalTokens" | "contextTokens" | "percentUsed" | "cacheRead" | "cacheWrite"
  >,
) => {
  const used =
    typeof sess.totalTokens === "number" &&
    Number.isFinite(sess.totalTokens) &&
    sess.totalTokens >= 0
      ? sess.totalTokens
      : null;
  const ctx =
    typeof sess.contextTokens === "number" &&
    Number.isFinite(sess.contextTokens) &&
    sess.contextTokens > 0
      ? sess.contextTokens
      : null;
  const cacheRead =
    typeof sess.cacheRead === "number" && Number.isFinite(sess.cacheRead) && sess.cacheRead >= 0
      ? sess.cacheRead
      : 0;
  const cacheWrite =
    typeof sess.cacheWrite === "number" && Number.isFinite(sess.cacheWrite) && sess.cacheWrite >= 0
      ? sess.cacheWrite
      : 0;

  let result = "";
  if (used == null) {
    result = ctx ? `unknown/${formatKTokens(ctx)} (?%)` : "unknown used";
  } else if (!ctx) {
    result = `${formatKTokens(used)} used`;
  } else {
    const pctLabel = sess.percentUsed != null ? `${sess.percentUsed}%` : "?%";
    result = `${formatKTokens(used)}/${formatKTokens(ctx)} (${pctLabel})`;
  }

  // Add cache hit rate if there are cached reads
  if (cacheRead > 0) {
    const total = used ?? cacheRead + cacheWrite;
    const rawHitRate = total > 0 ? Math.round((cacheRead / total) * 100) : 0;
    const hitRate = Math.max(0, Math.min(100, rawHitRate));
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
