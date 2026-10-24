import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { GatewayWsSessionEventAttribution } from "../infra/diagnostic-rpc-types.js";
import type { SessionMessageSubscriberRegistry } from "./server-chat-state.js";

// Producer reasons are open strings; only these fixed operational buckets reach exporters.
const sessionChangeReasons = new Set([
  "abort",
  "activity-summary",
  "agent.input.settled",
  "agent.run.started",
  "archive",
  "board",
  "branch-switch",
  "chat.dispatch-error",
  "chat.title",
  "cleanup",
  "compact",
  "create",
  "cron-continuation",
  "delete",
  "dispatch",
  "fork",
  "github-publication",
  "goal",
  "groups",
  "involvement",
  "move",
  "new",
  "owner",
  "participants",
  "patch",
  "placement",
  "plugin-patch",
  "progress-card-reset",
  "project",
  "reclaim",
  "recovery",
  "reset",
  "rewind",
  "run-capacity",
  "send",
  "sharing",
  "steer",
  "subagent-status",
  "swarm-note",
  "title",
  "unarchive",
  "update",
  "updated",
  "worker-disk-space",
  "worker-runtime-install",
]);
const lifecyclePhases = new Set(["start", "model", "end", "error", "message"]);
const messageRoles = new Set(["user", "assistant", "system", "developer", "tool", "toolResult"]);

function gatewaySessionEventReason(event: string, payload: unknown): string | undefined {
  if (event !== "sessions.changed" && event !== "session.message") {
    return undefined;
  }
  const source = isRecord(payload) ? payload : undefined;
  if (event === "session.message") {
    const role = isRecord(source?.message) ? source.message.role : undefined;
    return role === undefined
      ? "message"
      : typeof role === "string" && messageRoles.has(role)
        ? role
        : "other";
  }
  const reason = source?.reason ?? source?.phase;
  return typeof reason === "string" &&
    (source?.reason !== undefined ? sessionChangeReasons.has(reason) : lifecyclePhases.has(reason))
    ? reason
    : "other";
}

/** Resolve label values and subscription sets once; every recipient reuses the same two facts. */
export function prepareSessionEventMetrics(
  event: string,
  payload: unknown,
  sessionKeys: readonly string[],
  subscribers: SessionMessageSubscriberRegistry | undefined,
): ((connId: string) => GatewayWsSessionEventAttribution) | undefined {
  const reason = gatewaySessionEventReason(event, payload);
  if (reason === undefined) {
    return undefined;
  }
  const memberships = sessionKeys.map((key) => subscribers?.get(key));
  const subscribed: GatewayWsSessionEventAttribution = { reason, delivery: "subscribed" };
  const roster: GatewayWsSessionEventAttribution = { reason, delivery: "roster" };
  return (connId) => (memberships.some((members) => members?.has(connId)) ? subscribed : roster);
}
