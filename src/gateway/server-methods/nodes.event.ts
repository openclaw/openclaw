import { safeParseJson } from "@openclaw/normalization-core/json-coercion";
import { validateNodeEventParams } from "../../../packages/gateway-protocol/src/index.js";
import {
  captureNodePairingGeneration,
  isNodePairingGenerationCurrent,
} from "../../infra/device-pairing-node-state.js";
import { NODE_MCP_TOOLS_CALL_COMMAND } from "../../infra/node-commands.js";
import { ApnsRegistrationPairingChangedError } from "../../infra/push-apns-store.errors.js";
import { NodeWorkerProcessesChangedSchema } from "../../worker/worker-process-observation.js";
import type { NodeEventContext, NodeEventHandleResult } from "../server-node-events-types.js";
import { resolveDispatchableNodeSession, respondPairingChanged } from "./nodes.shared.js";
import { respondUnavailableOnThrow } from "./response.js";
import type { GatewayRequestHandlers, RespondFn } from "./types.js";
import { assertValidParams } from "./validation.js";

export const nodeEventHandlers: GatewayRequestHandlers = {
  "node.event": async ({ params, respond: sendResponse, context, client }) => {
    let responded = false;
    const respond: RespondFn = (...args) => {
      if (responded) {
        if (!args[0]) {
          context.logGateway.warn("node.event failed after its result was sent");
        }
        return;
      }
      responded = true;
      sendResponse(...args);
    };
    const publishResult = (result: NodeEventHandleResult) => {
      if (result.reason === "pairing_changed") {
        respondPairingChanged(respond);
      } else {
        respond(true, result, undefined);
      }
    };
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
      if (p.event === "mcp.elicitation") {
        if (!nodeSession || !eventConnId || nodeSession.connId !== eventConnId) {
          respondPairingChanged(respond);
          return;
        }
        const result = await context.nodeRegistry.mcpElicitation.receive(
          nodeSession,
          safeParseJson(payloadJSON ?? ""),
          async () =>
            (await isEventConnectionCurrent()) &&
            context.getRuntimeConfig().mcp?.apps?.enabled === true &&
            nodeSession.commands.includes(NODE_MCP_TOOLS_CALL_COMMAND),
        );
        respond(true, result, undefined);
        return;
      }
      if (p.event === "worker.processes.changed") {
        const change = NodeWorkerProcessesChangedSchema.safeParse(safeParseJson(payloadJSON ?? ""));
        let handled = false;
        if (change.success && (await isEventConnectionCurrent())) {
          const input = change.data;
          const observation = await context.workerSessionPlacementService?.prepareRuntimeRefresh?.(
            input.sessionId,
          );
          try {
            if (observation && (await isEventConnectionCurrent())) {
              observation.assertCurrent();
              const placement = observation.placement;
              const environment = context.workerEnvironmentService?.get(input.environmentId);
              if (
                !observation.move &&
                !observation.pendingResult &&
                placement?.state === "active" &&
                placement.executionMode === "worker-turn" &&
                placement.environmentId === input.environmentId &&
                placement.activeOwnerEpoch === input.ownerEpoch &&
                placement.generation === input.placementGeneration &&
                environment?.nodeDeviceId === nodeId &&
                environment.ownerEpoch === input.ownerEpoch &&
                environment.destroyRequestedAtMs === null &&
                ["ready", "idle", "attached"].includes(environment.state)
              ) {
                const { sessionKey, agentId } = placement;
                context.broadcast(
                  "sessions.processes.changed",
                  { sessionKey, agentId },
                  { sessionKeys: [sessionKey], agentId, dropIfSlow: true },
                );
                handled = true;
              }
            }
          } finally {
            observation?.release();
          }
        }
        respond(true, { ok: true, event: p.event, handled }, undefined);
        return;
      }
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
        updateNodeHostStats: (stats) => context.nodeRegistry.updateHostStats(stats),
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
          onResult: publishResult,
          connId: client?.connId,
          deviceId: client?.connect?.device?.id,
          pairingGeneration: eventPairingGeneration
            ? { nodeId, key: eventPairingGeneration }
            : undefined,
          presenceAllowed,
          isConnectionCurrent: isEventConnectionCurrent,
          assertSessionEventCurrent: () => {
            const current = eventPairingGeneration
              ? sessionForGeneration(eventPairingGeneration)
              : undefined;
            if (
              !eventConnId ||
              !current ||
              current !== nodeSession ||
              current.connId !== eventConnId ||
              current.client.invalidated === true
            ) {
              throw new Error("Node event connection changed during preparation");
            }
          },
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
      if (result) {
        publishResult(result);
      } else {
        respond(true, { ok: true }, undefined);
      }
    });
  },
};
