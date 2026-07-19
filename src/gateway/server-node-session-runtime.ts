import { getPairedDevice, resolveNodePairingGeneration } from "../infra/device-pairing.js";
// Gateway node session runtime factory.
// Creates node registry, subscription, and voice-wake fanout state.
import {
  NodeRegistry,
  type NodeRegistryOptions,
  type SerializedEventPayload,
} from "./node-registry.js";
import type {
  SessionEventSubscriberRegistry,
  SessionMessageSubscriberRegistry,
} from "./server-chat-state.js";
import { createNodeSubscriptionManager } from "./server-node-subscriptions.js";
import { hasConnectedTalkNode } from "./server-talk-nodes.js";

// Node session runtime owns connected node registry state, session event
// subscriptions, and voice-wake fanout helpers for the gateway process.
/** Creates node registry/subscription runtime state for a gateway server. */
export function createGatewayNodeSessionRuntime(params: {
  broadcast: (event: string, payload: unknown, opts?: { dropIfSlow?: boolean }) => void;
  listRegisteredNodePluginToolCommands?: NodeRegistryOptions["listRegisteredNodePluginToolCommands"];
  nodePluginToolsEnabled?: boolean;
  nodeSkillsEnabled?: boolean;
  resolveCurrentPairingGeneration?: NodeRegistryOptions["resolveCurrentPairingGeneration"];
  sessionEventSubscribers: SessionEventSubscriberRegistry;
  sessionMessageSubscribers: SessionMessageSubscriberRegistry;
}) {
  const nodeSubscriptions = createNodeSubscriptionManager();
  const nodeRegistry = new NodeRegistry({
    listRegisteredNodePluginToolCommands: params.listRegisteredNodePluginToolCommands,
    nodePluginToolsEnabled: params.nodePluginToolsEnabled,
    nodeSkillsEnabled: params.nodeSkillsEnabled,
    resolveCurrentPairingGeneration:
      params.resolveCurrentPairingGeneration ??
      (async (nodeId) => resolveNodePairingGeneration(await getPairedDevice(nodeId))?.key),
    onPairingGenerationChanged: (change) => {
      nodeSubscriptions.updatePairingGeneration({
        ...change,
        preserveSubscriptions: change.preserveSessionState,
      });
    },
  });
  const nodePresenceTimers = new Map<string, ReturnType<typeof setInterval>>();
  const sessionEventSubscribers = params.sessionEventSubscribers;
  const sessionMessageSubscribers = params.sessionMessageSubscribers;
  const nodeSendEvent = (opts: {
    nodeId: string;
    pairingGeneration: string;
    event: string;
    payloadJSON?: SerializedEventPayload | null;
  }) => {
    return nodeRegistry.sendEventRawForPairingGeneration(
      opts.nodeId,
      opts.pairingGeneration,
      opts.event,
      opts.payloadJSON ?? null,
    );
  };
  // Session fanout goes through the subscription manager so node reconnects and
  // explicit unsubscribes keep both node->session indexes in sync.
  const nodeSendToSession = (sessionKey: string, event: string, payload: unknown) =>
    nodeSubscriptions.sendToSession(sessionKey, event, payload, nodeSendEvent);
  const nodeSendToAllSubscribed = (event: string, payload: unknown) =>
    nodeSubscriptions.sendToAllSubscribed(event, payload, nodeSendEvent);
  const resolveSubscriptionGeneration = (nodeId: string, connId?: string) => {
    const node = nodeRegistry.get(nodeId);
    return connId && node?.connId === connId ? node.pairingGeneration : undefined;
  };
  const nodeSubscribe = (nodeId: string, sessionKey: string, connId?: string) => {
    const pairingGeneration = resolveSubscriptionGeneration(nodeId, connId);
    if (pairingGeneration) {
      nodeSubscriptions.subscribe(nodeId, pairingGeneration, sessionKey);
    }
  };
  const nodeUnsubscribe = (nodeId: string, sessionKey: string, connId?: string) => {
    const pairingGeneration = resolveSubscriptionGeneration(nodeId, connId);
    if (pairingGeneration) {
      nodeSubscriptions.unsubscribe(nodeId, pairingGeneration, sessionKey);
    }
  };
  const broadcastVoiceWakeChanged = (triggers: string[]) => {
    params.broadcast("voicewake.changed", { triggers }, { dropIfSlow: true });
  };
  const hasTalkNodeConnected = () => hasConnectedTalkNode(nodeRegistry);

  return {
    nodeRegistry,
    nodePresenceTimers,
    sessionEventSubscribers,
    sessionMessageSubscribers,
    nodeSendToSession,
    nodeSendToAllSubscribed,
    nodeSubscribe,
    nodeUnsubscribe,
    nodeUnsubscribeAll: nodeSubscriptions.unsubscribeAll,
    broadcastVoiceWakeChanged,
    hasTalkNodeConnected,
  };
}
