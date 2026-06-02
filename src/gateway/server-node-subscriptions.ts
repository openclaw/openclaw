import { serializeEventPayload, type SerializedEventPayload } from "./node-registry.js";

type NodeSendEventFn = (opts: {
  nodeId: string;
  event: string;
  payloadJSON?: SerializedEventPayload | null;
}) => void;

type NodeListConnectedFn = () => Array<{ nodeId: string }>;

type NodeSubscriptionManagerOptions = {
  canonicalizeSessionKey?: (sessionKey: string) => string;
};

type NodeSubscriptionManager = {
  subscribe: (nodeId: string, sessionKey: string) => void;
  unsubscribe: (nodeId: string, sessionKey: string) => void;
  unsubscribeAll: (nodeId: string) => void;
  sendToSession: (
    sessionKey: string,
    event: string,
    payload: unknown,
    sendEvent?: NodeSendEventFn | null,
  ) => void;
  sendToAllSubscribed: (
    event: string,
    payload: unknown,
    sendEvent?: NodeSendEventFn | null,
  ) => void;
  sendToAllConnected: (
    event: string,
    payload: unknown,
    listConnected?: NodeListConnectedFn | null,
    sendEvent?: NodeSendEventFn | null,
  ) => void;
  clear: () => void;
};

export function createNodeSubscriptionManager(
  options: NodeSubscriptionManagerOptions = {},
): NodeSubscriptionManager {
  const nodeSubscriptions = new Map<string, Set<string>>();
  const sessionSubscribers = new Map<string, Set<string>>();

  const toPayloadJSON = (payload: unknown) => serializeEventPayload(payload);
  const canonicalizeSessionKey = (sessionKey: string): string => {
    const normalizedSessionKey = sessionKey.trim();
    if (!normalizedSessionKey) {
      return "";
    }
    try {
      return options.canonicalizeSessionKey?.(normalizedSessionKey).trim() || normalizedSessionKey;
    } catch {
      return normalizedSessionKey;
    }
  };
  const addSubscription = (nodeId: string, sessionKey: string) => {
    let nodeSet = nodeSubscriptions.get(nodeId);
    if (!nodeSet) {
      nodeSet = new Set<string>();
      nodeSubscriptions.set(nodeId, nodeSet);
    }
    if (nodeSet.has(sessionKey)) {
      return;
    }
    nodeSet.add(sessionKey);

    let sessionSet = sessionSubscribers.get(sessionKey);
    if (!sessionSet) {
      sessionSet = new Set<string>();
      sessionSubscribers.set(sessionKey, sessionSet);
    }
    sessionSet.add(nodeId);
  };
  const removeSubscription = (nodeId: string, sessionKey: string) => {
    const nodeSet = nodeSubscriptions.get(nodeId);
    nodeSet?.delete(sessionKey);
    if (nodeSet?.size === 0) {
      nodeSubscriptions.delete(nodeId);
    }

    const sessionSet = sessionSubscribers.get(sessionKey);
    sessionSet?.delete(nodeId);
    if (sessionSet?.size === 0) {
      sessionSubscribers.delete(sessionKey);
    }
  };
  const equivalentSessionKeys = (sessionKey: string): string[] => {
    const normalizedSessionKey = sessionKey.trim();
    const canonicalSessionKey = canonicalizeSessionKey(normalizedSessionKey);
    if (!canonicalSessionKey) {
      return [];
    }
    const keys = new Set<string>([canonicalSessionKey]);
    if (normalizedSessionKey && normalizedSessionKey !== canonicalSessionKey) {
      keys.add(normalizedSessionKey);
    }
    if (options.canonicalizeSessionKey) {
      for (const existingSessionKey of sessionSubscribers.keys()) {
        if (canonicalizeSessionKey(existingSessionKey) === canonicalSessionKey) {
          keys.add(existingSessionKey);
        }
      }
    }
    return [...keys];
  };
  const migrateEquivalentSessionKeys = (sessionKey: string): Set<string> => {
    const [canonicalSessionKey, ...aliasKeys] = equivalentSessionKeys(sessionKey);
    if (!canonicalSessionKey) {
      return new Set<string>();
    }
    const subscribers = new Set(sessionSubscribers.get(canonicalSessionKey) ?? []);
    for (const aliasKey of aliasKeys) {
      const aliasSubscribers = sessionSubscribers.get(aliasKey);
      if (!aliasSubscribers) {
        continue;
      }
      for (const nodeId of aliasSubscribers) {
        subscribers.add(nodeId);
        addSubscription(nodeId, canonicalSessionKey);
        removeSubscription(nodeId, aliasKey);
      }
    }
    return subscribers;
  };

  const subscribe = (nodeId: string, sessionKey: string) => {
    const normalizedNodeId = nodeId.trim();
    const canonicalSessionKey = canonicalizeSessionKey(sessionKey);
    if (!normalizedNodeId || !canonicalSessionKey) {
      return;
    }
    addSubscription(normalizedNodeId, canonicalSessionKey);
  };

  const unsubscribe = (nodeId: string, sessionKey: string) => {
    const normalizedNodeId = nodeId.trim();
    if (!normalizedNodeId) {
      return;
    }
    for (const sessionKeyCandidate of equivalentSessionKeys(sessionKey)) {
      removeSubscription(normalizedNodeId, sessionKeyCandidate);
    }
  };

  const unsubscribeAll = (nodeId: string) => {
    const normalizedNodeId = nodeId.trim();
    const nodeSet = nodeSubscriptions.get(normalizedNodeId);
    if (!nodeSet) {
      return;
    }
    for (const sessionKey of nodeSet) {
      const sessionSet = sessionSubscribers.get(sessionKey);
      sessionSet?.delete(normalizedNodeId);
      if (sessionSet?.size === 0) {
        sessionSubscribers.delete(sessionKey);
      }
    }
    nodeSubscriptions.delete(normalizedNodeId);
  };

  const sendToSession = (
    sessionKey: string,
    event: string,
    payload: unknown,
    sendEvent?: NodeSendEventFn | null,
  ) => {
    if (!sessionKey.trim() || !sendEvent) {
      return;
    }
    const subs = migrateEquivalentSessionKeys(sessionKey);
    if (subs.size === 0) {
      return;
    }

    const payloadJSON = toPayloadJSON(payload);
    for (const nodeId of subs) {
      sendEvent({ nodeId, event, payloadJSON });
    }
  };

  const sendToAllSubscribed = (
    event: string,
    payload: unknown,
    sendEvent?: NodeSendEventFn | null,
  ) => {
    if (!sendEvent) {
      return;
    }
    const payloadJSON = toPayloadJSON(payload);
    for (const nodeId of nodeSubscriptions.keys()) {
      sendEvent({ nodeId, event, payloadJSON });
    }
  };

  const sendToAllConnected = (
    event: string,
    payload: unknown,
    listConnected?: NodeListConnectedFn | null,
    sendEvent?: NodeSendEventFn | null,
  ) => {
    if (!sendEvent || !listConnected) {
      return;
    }
    const payloadJSON = toPayloadJSON(payload);
    for (const node of listConnected()) {
      sendEvent({ nodeId: node.nodeId, event, payloadJSON });
    }
  };

  const clear = () => {
    nodeSubscriptions.clear();
    sessionSubscribers.clear();
  };

  return {
    subscribe,
    unsubscribe,
    unsubscribeAll,
    sendToSession,
    sendToAllSubscribed,
    sendToAllConnected,
    clear,
  };
}
