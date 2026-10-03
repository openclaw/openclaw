import { drainFormattedSystemEvents } from "../auto-reply/reply/session-system-events.js";
import { getReplySystemEventContext } from "../auto-reply/reply/system-event-session-key.js";
import type { OpenClawConfig } from "../config/config.js";
import type { HeartbeatReplySpy } from "./heartbeat-runner.test-utils.js";

export function formatQueuedEvents(
  cfg: OpenClawConfig,
  ctx: Parameters<HeartbeatReplySpy>[0],
  options: Parameters<HeartbeatReplySpy>[1],
) {
  const event = getReplySystemEventContext(options);
  const sessionKey = event?.sessionKey ?? ctx.SessionKey;
  if (!sessionKey) {
    throw new Error("Expected the selected event queue");
  }
  return drainFormattedSystemEvents({
    cfg,
    agentId: "main",
    sessionKey,
    isMainSession: false,
    isNewSession: false,
    events: event?.events ?? [],
    deferredEventIds: event?.deferredEventIds,
  });
}
