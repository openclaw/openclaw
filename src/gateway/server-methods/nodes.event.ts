import { validateNodeEventParams } from "../../../packages/gateway-protocol/src/index.js";
import {
  captureNodePairingGeneration,
  isNodePairingGenerationCurrent,
  isPairedDeviceNodeBindingCurrent,
} from "../../infra/device-pairing-node-state.js";
import { recordPairedNodeHostStats } from "../../infra/device-pairing-node.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { ApnsRegistrationPairingChangedError } from "../../infra/push-apns-store.errors.js";
import type { NodeEventContext } from "../server-node-events-types.js";
import { resolveDispatchableNodeSession, respondPairingChanged } from "./nodes.shared.js";
import { respondUnavailableOnThrow } from "./response.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

export const nodeEventHandlers: GatewayRequestHandlers = {
  "node.event": async ({ params, respond, context, client }) => {
    if (!assertValidParams(params, validateNodeEventParams, "node.event", respond)) {
      return;
    }
    const p = params;
    const payloadJSON =
      p.payloadJSON ?? (p.payload !== undefined ? JSON.stringify(p.payload) : null);
    await respondUnavailableOnThrow(respond, async () => {
      const nodeId = client?.connect?.device?.id ?? client?.connect?.client?.id ?? "node";
      const nodeSession = context.nodeRegistry.get(nodeId);
      const eventConnId = client?.connId;
      const eventPairingGeneration = nodeSession?.pairingGeneration;
      const eventPairingIdentity = nodeSession?.pairingIdentity;
      const assertSessionEventCurrent = () => {
        const current = eventPairingGeneration
          ? resolveDispatchableNodeSession(
              context.nodeRegistry.getForPairingGeneration(nodeId, eventPairingGeneration),
            )
          : undefined;
        if (
          !current ||
          current !== nodeSession ||
          current.connId !== eventConnId ||
          current.client.invalidated === true ||
          !eventPairingIdentity ||
          !isPairedDeviceNodeBindingCurrent(nodeId, {
            identity: eventPairingIdentity,
            generation: eventPairingGeneration,
          })
        ) {
          throw new Error("Node pairing changed during session event admission");
        }
      };
      const sessionForGeneration = (generation: string) =>
        resolveDispatchableNodeSession(
          context.nodeRegistry.getForPairingGeneration(nodeId, generation),
        );
      const isEventConnectionCurrent = async (): Promise<boolean> => {
        if (!eventConnId || !eventPairingGeneration) {
          return false;
        }
        const before = sessionForGeneration(eventPairingGeneration);
        if (!before || before.connId !== eventConnId) {
          return false;
        }
        if (!(await context.nodeRegistry.isConnectionCurrentPairingState(eventConnId))) {
          return false;
        }
        return sessionForGeneration(eventPairingGeneration)?.connId === eventConnId;
      };
      const { handleNodeEvent } = await import("../server-node-events.js");
      const apnsGeneration =
        p.event === "push.apns.register" ? await captureNodePairingGeneration(nodeId) : null;
      const presenceAllowed =
        nodeSession !== undefined &&
        nodeSession.connId === client?.connId &&
        nodeSession.permissions?.accessibility === true;
      const bindSubscription =
        (method: "nodeSubscribe" | "nodeUnsubscribe"): NodeEventContext["nodeSubscribe"] =>
        async (subscriptionNodeId, sessionKey, subscriptionConnId) => {
          if (
            subscriptionNodeId !== nodeId ||
            !subscriptionConnId ||
            subscriptionConnId !== client?.connId ||
            !(await isEventConnectionCurrent())
          ) {
            return;
          }
          context[method](subscriptionNodeId, sessionKey, subscriptionConnId);
        };
      const nodeContext: NodeEventContext = {
        deps: context.deps,
        broadcast: context.broadcast,
        nodeSendToSession: context.nodeSendToSession,
        nodeSubscribe: bindSubscription("nodeSubscribe"),
        nodeUnsubscribe: bindSubscription("nodeUnsubscribe"),
        broadcastVoiceWakeChanged: context.broadcastVoiceWakeChanged,
        addChatRun: context.addChatRun,
        removeChatRun: context.removeChatRun,
        chatAbortControllers: context.chatAbortControllers,
        dedupe: context.dedupe,
        agentRunSeq: context.agentRunSeq,
        getHealthCache: context.getHealthCache,
        refreshHealthSnapshot: context.refreshHealthSnapshot,
        loadGatewayModelCatalog: context.loadGatewayModelCatalog,
        loadGatewayModelCatalogSnapshot: context.loadGatewayModelCatalogSnapshot,
        authorizeNodeSystemRunEvent: (eventParams) => {
          const authorization = context.nodeRegistry.authorizeSystemRunEventWithState({
            nodeId: eventParams.nodeId,
            connId: eventParams.connId,
            runId: eventParams.runId,
            sessionKey: eventParams.sessionKey,
            terminal: eventParams.event !== "exec.started",
          });
          return authorization ?? false;
        },
        updateNodePresenceActivity: (activity) => {
          const updated = context.nodeRegistry.updatePresenceActivity(activity);
          return updated?.lastActiveAtMs !== undefined && updated.presenceUpdatedAtMs !== undefined
            ? {
                lastActiveAtMs: updated.lastActiveAtMs,
                presenceUpdatedAtMs: updated.presenceUpdatedAtMs,
              }
            : null;
        },
        clearNodePresenceActivity: (activity) =>
          context.nodeRegistry.clearPresenceActivity(activity),
        updateNodeDesktopAvailability: (availability) =>
          context.nodeRegistry.updateDesktopAvailability(availability),
        updateNodeHostStats: (stats) => {
          const hostStats = context.nodeRegistry.updateHostStats(stats);
          if (hostStats && eventPairingGeneration) {
            // The 60 s reporting cadence costs one small JSON-column update per node per minute.
            void recordPairedNodeHostStats({
              nodeId,
              hostStats,
              expectedPairingGeneration: { nodeId, key: eventPairingGeneration },
            }).catch((error: unknown) =>
              context.logGateway.warn(
                `failed to persist node host stats for ${nodeId}: ${formatErrorMessage(error)}`,
              ),
            );
          }
          return hostStats;
        },
        logGateway: { warn: context.logGateway.warn },
      };
      const result = await handleNodeEvent(
        nodeContext,
        nodeId,
        {
          event: p.event,
          payloadJSON,
        },
        {
          connId: client?.connId,
          deviceId: client?.connect?.device?.id,
          pairingGeneration: eventPairingGeneration
            ? { nodeId, key: eventPairingGeneration }
            : undefined,
          presenceAllowed,
          isConnectionCurrent: isEventConnectionCurrent,
          assertSessionEventCurrent,
          assertApnsRegistrationCurrent: () => {
            const current = apnsGeneration
              ? context.nodeRegistry.getForPairingGeneration(nodeId, apnsGeneration.key)
              : undefined;
            if (
              !current ||
              current !== nodeSession ||
              current.connId !== eventConnId ||
              current.client.invalidated === true
            ) {
              throw new ApnsRegistrationPairingChangedError();
            }
          },
          resolveApnsRegistrationGeneration: async () => {
            if (!apnsGeneration || !client?.connId) {
              return null;
            }
            const before = sessionForGeneration(apnsGeneration.key);
            if (!before || before.connId !== client.connId) {
              return null;
            }
            if (!(await isNodePairingGenerationCurrent(apnsGeneration))) {
              return null;
            }
            return sessionForGeneration(apnsGeneration.key)?.connId === client.connId
              ? apnsGeneration.key
              : null;
          },
        },
      );
      if (result?.reason === "pairing_changed") {
        respondPairingChanged(respond);
        return;
      }
      respond(true, result ?? { ok: true }, undefined);
    });
  },
};
