import { formatTimeAgo } from "../infra/format-time/format-relative.js";
import type { HeartbeatEventPayload } from "../infra/heartbeat-events.js";

export function formatLastHeartbeatDetail(
  lastHeartbeat: HeartbeatEventPayload,
  nowMs = Date.now(),
): string {
  const age = formatTimeAgo(nowMs - lastHeartbeat.ts);
  const channel = lastHeartbeat.channel ?? null;
  const accountLabel = lastHeartbeat.accountId ? `account ${lastHeartbeat.accountId}` : null;
  return [lastHeartbeat.status, age, channel, accountLabel].filter(Boolean).join(" · ");
}
