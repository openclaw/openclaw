import type { SessionStatus } from "./status.types.js";
import { formatDurationPrecise } from "../infra/format-time/format-duration.ts";

export const formatKTokens = (value: number) =>
  `${(value / 1000).toFixed(value >= 10_000 ? 0 : 1)}k`;

export const formatDuration = (ms: number | null | undefined) => {
  if (ms == null || !Number.isFinite(ms)) {
    return "unknown";
  }
  return formatDurationPrecise(ms, { decimals: 1 });
};

export const shortenText = (value: string, maxLen: number) => {
  const chars = Array.from(value);
  if (chars.length <= maxLen) {
    return value;
  }
  return `${chars.slice(0, Math.max(0, maxLen - 1)).join("")}…`;
};

export const formatTokensCompact = (
  sess: Pick<SessionStatus, "totalTokens" | "contextTokens" | "percentUsed">,
) => {
  const used = sess.totalTokens ?? 0;
  const ctx = sess.contextTokens;
  if (!ctx) {
    return `${formatKTokens(used)} used`;
  }
  const pctLabel = sess.percentUsed != null ? `${sess.percentUsed}%` : "?%";
  return `${formatKTokens(used)}/${formatKTokens(ctx)} (${pctLabel})`;
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
  const status = runtime.status ?? "unknown";
  const details: string[] = [];
  if (runtime.pid) {
    details.push(`pid ${runtime.pid}`);
  }
  if (runtime.state && runtime.state.toLowerCase() !== status) {
    details.push(`state ${runtime.state}`);
  }
  const detail = runtime.detail?.replace(/\s+/g, " ").trim() || "";
  const noisyLaunchctlDetail =
    runtime.missingUnit === true && detail.toLowerCase().includes("could not find service");
  if (detail && !noisyLaunchctlDetail) {
    details.push(detail);
  }
  return details.length > 0 ? `${status} (${details.join(", ")})` : status;
};
