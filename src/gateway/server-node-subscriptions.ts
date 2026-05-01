import { loadSessionEntry } from "./session-utils.js";

export type NodeSendEventFn = (opts: {
  nodeId: string;
  event: string;
  payloadJSON?: string | null;
}) => void;

export type NodeListConnectedFn = () => Array<{ nodeId: string }>;

export type NodeSubscriptionManager = {
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

export function createNodeSubscriptionManager(): NodeSubscriptionManager {
  const nodeSubscriptions = new Map<string, Set<string>>();
  const sessionSubscribers = new Map<string, Set<string>>();
  const spawnedBySubscriberCache = new Map<string, string | null>();

  const toPayloadJSON = (payload: unknown) => (payload ? JSON.stringify(payload) : null);

  const subscribe = (nodeId: string, sessionKey: string) => {
    const normalizedNodeId = nodeId.trim();
    const normalizedSessionKey = sessionKey.trim();
    if (!normalizedNodeId || !normalizedSessionKey) {
      return;
    }

    let nodeSet = nodeSubscriptions.get(normalizedNodeId);
    if (!nodeSet) {
      nodeSet = new Set<string>();
      nodeSubscriptions.set(normalizedNodeId, nodeSet);
    }
    if (nodeSet.has(normalizedSessionKey)) {
      return;
    }
    nodeSet.add(normalizedSessionKey);

    let sessionSet = sessionSubscribers.get(normalizedSessionKey);
    if (!sessionSet) {
      sessionSet = new Set<string>();
      sessionSubscribers.set(normalizedSessionKey, sessionSet);
    }
    sessionSet.add(normalizedNodeId);
    spawnedBySubscriberCache.clear();
  };

  const unsubscribe = (nodeId: string, sessionKey: string) => {
    const normalizedNodeId = nodeId.trim();
    const normalizedSessionKey = sessionKey.trim();
    if (!normalizedNodeId || !normalizedSessionKey) {
      return;
    }

    const nodeSet = nodeSubscriptions.get(normalizedNodeId);
    nodeSet?.delete(normalizedSessionKey);
    if (nodeSet?.size === 0) {
      nodeSubscriptions.delete(normalizedNodeId);
    }

    const sessionSet = sessionSubscribers.get(normalizedSessionKey);
    sessionSet?.delete(normalizedNodeId);
    if (sessionSet?.size === 0) {
      sessionSubscribers.delete(normalizedSessionKey);
    }
    spawnedBySubscriberCache.clear();
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
    spawnedBySubscriberCache.clear();
  };

  const resolveSessionSubscribers = (sessionKey: string): Set<string> | undefined => {
    const direct = sessionSubscribers.get(sessionKey);
    if (direct && direct.size > 0) {
      return direct;
    }

    const cachedAncestor = spawnedBySubscriberCache.get(sessionKey);
    if (cachedAncestor !== undefined) {
      return cachedAncestor ? sessionSubscribers.get(cachedAncestor) : undefined;
    }

    const visited = new Set<string>([sessionKey]);
    let current = sessionKey;
    for (let depth = 0; depth < 8; depth += 1) {
      let parentKey = "";
      try {
        const loaded = loadSessionEntry(current);
        parentKey =
          typeof loaded.entry?.spawnedBy === "string" ? loaded.entry.spawnedBy.trim() : "";
      } catch {
        parentKey = "";
      }
      if (!parentKey) {
        break;
      }

      const parentSubscribers = sessionSubscribers.get(parentKey);
      if (parentSubscribers && parentSubscribers.size > 0) {
        spawnedBySubscriberCache.set(sessionKey, parentKey);
        return parentSubscribers;
      }

      let canonicalParentKey = parentKey;
      try {
        canonicalParentKey = loadSessionEntry(parentKey).canonicalKey.trim() || parentKey;
      } catch {}

      const canonicalParentSubscribers = sessionSubscribers.get(canonicalParentKey);
      if (canonicalParentSubscribers && canonicalParentSubscribers.size > 0) {
        spawnedBySubscriberCache.set(sessionKey, canonicalParentKey);
        return canonicalParentSubscribers;
      }

      if (visited.has(parentKey) || visited.has(canonicalParentKey)) {
        break;
      }
      visited.add(parentKey);
      visited.add(canonicalParentKey);
      current = canonicalParentKey;
    }

    spawnedBySubscriberCache.set(sessionKey, null);
    return undefined;
  };

  const sendToSession = (
    sessionKey: string,
    event: string,
    payload: unknown,
    sendEvent?: NodeSendEventFn | null,
  ) => {
    const normalizedSessionKey = sessionKey.trim();
    if (!normalizedSessionKey || !sendEvent) {
      return;
    }
    const subs = resolveSessionSubscribers(normalizedSessionKey);
    if (!subs || subs.size === 0) {
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
    spawnedBySubscriberCache.clear();
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
