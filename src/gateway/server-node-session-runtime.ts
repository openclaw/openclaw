import { NodeRegistry, type SerializedEventPayload } from "./node-registry.js";
import {
  createSessionEventSubscriberRegistry,
  createSessionMessageSubscriberRegistry,
} from "./server-chat-state.js";
import { createNodeSubscriptionManager } from "./server-node-subscriptions.js";
import { hasConnectedTalkNode } from "./server-talk-nodes.js";

/** Creates the node/session registries shared by Gateway RPC, node events, and Talk presence. */
export function createGatewayNodeSessionRuntime(params: {
  broadcast: (event: string, payload: unknown, opts?: { dropIfSlow?: boolean }) => void;
}) {
  const nodeRegistry = new NodeRegistry();
  const nodePresenceTimers = new Map<string, ReturnType<typeof setInterval>>();
  const nodeSubscriptions = createNodeSubscriptionManager();
  const sessionEventSubscribers = createSessionEventSubscriberRegistry();
  const sessionMessageSubscribers = createSessionMessageSubscriberRegistry();
  const nodeSendEvent = (opts: {
    nodeId: string;
    event: string;
    payloadJSON?: SerializedEventPayload | null;
  }) => {
    nodeRegistry.sendEventRaw(opts.nodeId, opts.event, opts.payloadJSON ?? null);
  };
  // Session subscriptions route by session key but deliver over node ids; keep
  // the raw node send adapter local so subscription code never owns registry IO.
  const nodeSendToSession = (sessionKey: string, event: string, payload: unknown) =>
    nodeSubscriptions.sendToSession(sessionKey, event, payload, nodeSendEvent);
  const nodeSendToAllSubscribed = (event: string, payload: unknown) =>
    nodeSubscriptions.sendToAllSubscribed(event, payload, nodeSendEvent);
  const broadcastVoiceWakeChanged = (triggers: string[]) => {
    params.broadcast("voicewake.changed", { triggers }, { dropIfSlow: true });
  };
  // Talk only needs a boolean presence snapshot; the node registry keeps the
  // richer session metadata for targeted node RPC delivery.
  const hasTalkNodeConnected = () => hasConnectedTalkNode(nodeRegistry);

  return {
    nodeRegistry,
    nodePresenceTimers,
    sessionEventSubscribers,
    sessionMessageSubscribers,
    nodeSendToSession,
    nodeSendToAllSubscribed,
    nodeSubscribe: nodeSubscriptions.subscribe,
    nodeUnsubscribe: nodeSubscriptions.unsubscribe,
    nodeUnsubscribeAll: nodeSubscriptions.unsubscribeAll,
    broadcastVoiceWakeChanged,
    hasTalkNodeConnected,
  };
}
