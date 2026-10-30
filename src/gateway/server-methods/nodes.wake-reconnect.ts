import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { NodePairingGeneration } from "../../infra/device-pairing-node-state.js";
import { ABSOLUTE_DEADLINE_EXPIRED, awaitWithinDeadline } from "../../utils/absolute-deadline.js";
import type { NodeWakeAttempt } from "../node-wake-state-store.js";
import {
  NODE_WAKE_RECONNECT_RETRY_WAIT_MS,
  NODE_WAKE_RECONNECT_WAIT_MS,
  type NodeWakeLifecycle,
} from "../node-wake-state.js";
import { maybeWakeNodeWithApns, waitForNodeReconnect } from "./nodes.wake.js";
import type { GatewayRequestContext } from "./types.js";

type NodeReconnectWakeParams = {
  nodeId: string;
  context: Pick<GatewayRequestContext, "nodeRegistry" | "logGateway">;
  cfg: OpenClawConfig;
  generation: NodePairingGeneration;
  lifecycle: NodeWakeLifecycle;
  requestId: string;
  source: "invoke" | "pending";
  force: boolean;
  deadlineAtMs?: number;
};

export function wakeNodeForReconnect(
  params: NodeReconnectWakeParams & { deadlineAtMs?: undefined },
): Promise<NodeWakeAttempt>;
export function wakeNodeForReconnect(
  params: NodeReconnectWakeParams,
): Promise<NodeWakeAttempt | typeof ABSOLUTE_DEADLINE_EXPIRED>;
/** One wake stage owns its push deadline and bounded reconnect wait; callers retain pairing custody. */
export async function wakeNodeForReconnect(
  params: NodeReconnectWakeParams,
): Promise<NodeWakeAttempt | typeof ABSOLUTE_DEADLINE_EXPIRED> {
  const { nodeId, context, cfg, generation, lifecycle, force, deadlineAtMs } = params;
  const wake = await awaitWithinDeadline(
    () =>
      maybeWakeNodeWithApns(nodeId, {
        ...(force ? { force: true } : {}),
        ...(params.source === "pending" ? { wakeReason: "node.pending" } : {}),
        cfg,
        lifecycle,
        generation,
      }),
    deadlineAtMs,
    () => performance.now(),
  );
  if (wake === ABSOLUTE_DEADLINE_EXPIRED) {
    return wake;
  }
  const prefix = params.source === "invoke" ? "node wake" : "node pending wake";
  const stage = force ? 2 : 1;
  context.logGateway.info(
    `${prefix} stage=wake${stage} node=${nodeId} req=${params.requestId}${force ? " force=true" : ""} ` +
      `available=${wake.available} throttled=${wake.throttled} ` +
      `path=${wake.path} durationMs=${wake.durationMs} ` +
      `apnsStatus=${wake.apnsStatus ?? -1} apnsReason=${wake.apnsReason ?? "-"}`,
  );
  if (deadlineAtMs !== undefined && performance.now() >= deadlineAtMs) {
    return ABSOLUTE_DEADLINE_EXPIRED;
  }
  if (wake.available) {
    const waitStartedAtMs = Date.now();
    const reconnectWaitMs = force ? NODE_WAKE_RECONNECT_RETRY_WAIT_MS : NODE_WAKE_RECONNECT_WAIT_MS;
    const timeoutMs =
      deadlineAtMs === undefined
        ? reconnectWaitMs
        : Math.min(reconnectWaitMs, Math.max(0, deadlineAtMs - performance.now()));
    const reconnected = await waitForNodeReconnect({
      nodeId,
      context,
      timeoutMs,
      lifecycle,
      pairingGeneration: generation.key,
    });
    const duration =
      params.source === "invoke" ? ` durationMs=${Math.max(0, Date.now() - waitStartedAtMs)}` : "";
    context.logGateway.info(
      `${prefix} stage=wait${stage} node=${nodeId} req=${params.requestId} ` +
        `reconnected=${reconnected} timeoutMs=${timeoutMs}${duration}`,
    );
  }
  return wake;
}
