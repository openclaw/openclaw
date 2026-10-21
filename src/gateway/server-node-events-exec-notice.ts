import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  resolveEventSessionKeyForPolicy,
  resolveEventSessionRoutingPolicy,
  scopedHeartbeatWakeOptionsForPolicy,
} from "../infra/event-session-routing.js";
import { requestHeartbeat } from "../infra/heartbeat-wake.js";
import { withSystemEventOwner } from "../infra/system-event-ownership.js";
import { enqueueSystemEvent } from "../infra/system-events.js";
import { isUnscopedSessionKeySentinel } from "../routing/session-key.js";
import type { NodeEventContext } from "./server-node-events-types.js";

/** One exec-notice handoff: validate authority, enqueue, then wake only its admitted scope. */
export function enqueueNodeExecNotice(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  agentId: string;
  authorization: ReturnType<NodeEventContext["authorizeNodeSystemRunEvent"]>;
  runId: string;
  text: string;
}): void {
  const { cfg, sessionKey, agentId, runId, text } = params;
  // The registry owns this snapshot; the terminal payload never supplies a route.
  // Legacy calls without a host-bound source retain the existing session fallback.
  const deliveryContext =
    typeof params.authorization === "object"
      ? params.authorization.invocationDeliveryContext
      : undefined;
  const policy = resolveEventSessionRoutingPolicy({ cfg, sessionKey });
  const queued = enqueueSystemEvent(
    text,
    withSystemEventOwner(
      {
        sessionKey: resolveEventSessionKeyForPolicy(sessionKey, policy),
        contextKey: runId ? "exec:" + runId : "exec",
        ...(deliveryContext ? { deliveryContext } : {}),
      },
      agentId,
    ),
  );
  if (queued) {
    requestHeartbeat(
      scopedHeartbeatWakeOptionsForPolicy(
        sessionKey,
        {
          source: "exec-event",
          intent: "event",
          reason: "exec-event",
          coalesceMs: 0,
          ...(isUnscopedSessionKeySentinel(sessionKey) ? { agentId } : {}),
        },
        policy,
      ),
    );
  }
}
