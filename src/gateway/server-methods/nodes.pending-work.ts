// Node pending methods queue and drain work for paired nodes that may reconnect
// later, with optional APNs wake nudges.
import {
  ErrorCodes,
  errorShape,
  validateNodePendingDrainParams,
  validateNodePendingEnqueueParams,
} from "../../../packages/gateway-protocol/src/index.js";
import {
  captureNodePairingGeneration,
  isNodePairingGenerationCurrent,
} from "../../infra/device-pairing-node-state.js";
import {
  drainNodePendingWork,
  enqueueNodePendingWork,
  removeNodePendingWorkItem,
  type NodePendingWorkPriority,
  type NodePendingWorkType,
} from "../node-pending-work.js";
import { captureNodeWakeLifecycle, releaseNodeWakeLifecycle } from "../node-wake-state.js";
import { isNodePairingWorkCurrent } from "./nodes.shared.js";
import { wakeNodeForReconnect } from "./nodes.wake-reconnect.js";
import { maybeSendNodeWakeNudge } from "./nodes.wake.js";
import { respondUnavailableOnThrow } from "./response.js";
import type { RespondFn } from "./shared-types.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

function respondPairingChanged(respond: RespondFn) {
  respond(
    false,
    undefined,
    errorShape(ErrorCodes.UNAVAILABLE, "node pairing changed while pending work was active", {
      retryable: true,
      details: { code: "PAIRING_CHANGED" },
    }),
  );
}

function resolveClientNodeId(
  client: { connect?: { device?: { id?: string }; client?: { id?: string } } } | null,
): string | null {
  const nodeId = client?.connect?.device?.id ?? client?.connect?.client?.id ?? "";
  const trimmed = nodeId.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Gateway handlers for queueing work until a paired node reconnects. */
export const nodePendingWorkHandlers: GatewayRequestHandlers = {
  "node.pending.drain": async ({ params, respond, client, context }) => {
    if (!assertValidParams(params, validateNodePendingDrainParams, "node.pending.drain", respond)) {
      return;
    }
    const nodeId = resolveClientNodeId(client);
    if (!nodeId) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "node.pending.drain requires a connected device identity",
        ),
      );
      return;
    }
    await respondUnavailableOnThrow(respond, async () => {
      const generation = await captureNodePairingGeneration(nodeId);
      if (!generation || !(await isNodePairingGenerationCurrent(generation))) {
        respondPairingChanged(respond);
        return;
      }
      // Draining deletes work, so the authenticated caller must still be the
      // registry session that owns the persisted generation.
      const session = context.nodeRegistry.getForPairingGeneration(nodeId, generation.key);
      if (!client?.connId || session?.connId !== client.connId) {
        respondPairingChanged(respond);
        return;
      }
      const p = params;
      const drained = drainNodePendingWork(nodeId, {
        maxItems: p.maxItems,
        includeDefaultStatus: true,
        pairingGeneration: generation.key,
      });
      respond(true, { nodeId, ...drained }, undefined);
    });
  },
  "node.pending.enqueue": async ({ params, respond, context }) => {
    if (
      !assertValidParams(params, validateNodePendingEnqueueParams, "node.pending.enqueue", respond)
    ) {
      return;
    }
    const p = params as {
      nodeId: string;
      type: NodePendingWorkType;
      priority?: NodePendingWorkPriority;
      expiresInMs?: number;
      wake?: boolean;
    };
    await respondUnavailableOnThrow(respond, async () => {
      const nodeId = p.nodeId.trim();
      const generation = await captureNodePairingGeneration(nodeId);
      if (!generation) {
        respondPairingChanged(respond);
        return;
      }
      const wakeLifecycle = captureNodeWakeLifecycle(nodeId, generation.key);
      try {
        if (!(await isNodePairingWorkCurrent({ nodeId, generation, lifecycle: wakeLifecycle }))) {
          respondPairingChanged(respond);
          return;
        }
        const queued = enqueueNodePendingWork({
          nodeId,
          type: p.type,
          priority: p.priority,
          expiresInMs: p.expiresInMs,
          pairingGeneration: generation.key,
        });
        let wakeTriggered = false;
        if (
          p.wake !== false &&
          !queued.deduped &&
          !context.nodeRegistry.getForPairingGeneration(nodeId, generation.key)
        ) {
          const wakeReqId = queued.item.id;
          context.logGateway.info(
            `node pending wake start node=${nodeId} req=${wakeReqId} type=${queued.item.type}`,
          );
          const cfg = context.getRuntimeConfig();
          for (const force of [false, true]) {
            const wake = await wakeNodeForReconnect({
              nodeId,
              context,
              cfg,
              generation,
              lifecycle: wakeLifecycle,
              requestId: wakeReqId,
              source: "pending",
              force,
            });
            if (force) {
              break;
            }
            wakeTriggered = wake.available;
            if (
              !(await isNodePairingWorkCurrent({ nodeId, generation, lifecycle: wakeLifecycle })) ||
              context.nodeRegistry.getForPairingGeneration(nodeId, generation.key) ||
              !wake.available
            ) {
              break;
            }
          }
          if (
            (await isNodePairingWorkCurrent({
              nodeId,
              generation,
              lifecycle: wakeLifecycle,
            })) &&
            !context.nodeRegistry.getForPairingGeneration(nodeId, generation.key)
          ) {
            const nudge = await maybeSendNodeWakeNudge(nodeId, {
              cfg,
              lifecycle: wakeLifecycle,
              generation,
            });
            context.logGateway.info(
              `node pending wake nudge node=${nodeId} req=${wakeReqId} sent=${nudge.sent} ` +
                `throttled=${nudge.throttled} reason=${nudge.reason} durationMs=${nudge.durationMs} ` +
                `apnsStatus=${nudge.apnsStatus ?? -1} apnsReason=${nudge.apnsReason ?? "-"}`,
            );
            context.logGateway.warn(
              `node pending wake done node=${nodeId} req=${wakeReqId} connected=false reason=not_connected`,
            );
          } else if (
            await isNodePairingWorkCurrent({
              nodeId,
              generation,
              lifecycle: wakeLifecycle,
            })
          ) {
            context.logGateway.info(
              `node pending wake done node=${nodeId} req=${wakeReqId} connected=true`,
            );
          }
        }
        if (!(await isNodePairingWorkCurrent({ nodeId, generation, lifecycle: wakeLifecycle }))) {
          if (!queued.deduped) {
            removeNodePendingWorkItem({
              nodeId,
              itemId: queued.item.id,
              pairingGeneration: generation.key,
            });
          }
          respondPairingChanged(respond);
          return;
        }
        respond(
          true,
          {
            nodeId,
            revision: queued.revision,
            queued: queued.item,
            wakeTriggered,
          },
          undefined,
        );
      } finally {
        releaseNodeWakeLifecycle(nodeId, wakeLifecycle);
      }
    });
  },
};
