import type { SessionToolDiscoveryCapture } from "../../config/sessions/tool-discovery.types.js";

const CHANNEL_HUMAN_TOOL_DISCOVERY_CAPTURE: SessionToolDiscoveryCapture = Object.freeze({
  kind: "clear",
  assertCurrent() {},
});

/**
 * Gateway ingress captures its own requester's presentation. A fresh human turn from a
 * channel has no Gateway profile, so it clears any saved presentation instead of
 * inheriting another requester's.
 */
export function replyToolDiscoveryCapture(
  opts:
    | { toolDiscoveryCapture?: SessionToolDiscoveryCapture; internalEventExecution?: unknown }
    | undefined,
  ctx: { GatewayClientScopes?: readonly string[] },
  freshChannelHumanTurn: boolean,
): { toolDiscoveryCapture?: SessionToolDiscoveryCapture } {
  if (opts?.toolDiscoveryCapture) {
    return { toolDiscoveryCapture: opts.toolDiscoveryCapture };
  }
  return freshChannelHumanTurn &&
    !Array.isArray(ctx.GatewayClientScopes) &&
    opts?.internalEventExecution === undefined
    ? { toolDiscoveryCapture: CHANNEL_HUMAN_TOOL_DISCOVERY_CAPTURE }
    : {};
}
