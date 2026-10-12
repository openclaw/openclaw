import { validateNodeHostStatsPayload } from "../../packages/gateway-protocol/src/index.js";
import {
  NODE_COMMAND_FEATURES_EVENT,
  isNodeCommandFeaturesPayload,
} from "../shared/node-command-features.js";
import { NODE_HOST_STATS_EVENT } from "../shared/node-host-stats.js";
import type { NodeEventContext, NodeEventHandleResult } from "./server-node-events-types.js";

/** Publishes connection facts through the registry's current-session writers. */
export function publishNodeConnectionFacts(
  ctx: Pick<NodeEventContext, "updateNodeCommandFeatures" | "updateNodeHostStats" | "broadcast">,
  nodeId: string,
  event: typeof NODE_COMMAND_FEATURES_EVENT | typeof NODE_HOST_STATS_EVENT,
  payload: Record<string, unknown> | null,
  connId?: string,
): NodeEventHandleResult {
  if (event === NODE_COMMAND_FEATURES_EVENT) {
    if (!isNodeCommandFeaturesPayload(payload)) {
      return { ok: true, event, handled: false, reason: "invalid_payload" };
    }
    const published = ctx.updateNodeCommandFeatures?.({
      nodeId,
      connId,
      features: payload.features,
    });
    return {
      ok: true,
      event,
      handled: published != null,
      reason: published == null ? "stale_connection" : "updated",
    };
  }
  if (!payload || !validateNodeHostStatsPayload(payload)) {
    return { ok: true, event, handled: false, reason: "invalid_payload" };
  }
  const hostStats = ctx.updateNodeHostStats?.({ nodeId, connId, stats: payload });
  if (!hostStats) {
    return { ok: true, event, handled: false, reason: "stale_connection" };
  }
  ctx.broadcast("node.hostStats", { nodeId, hostStats }, { dropIfSlow: true });
  return { ok: true, event, handled: true, reason: "updated" };
}
