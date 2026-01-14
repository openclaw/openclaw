export type BridgeSendEventFn = (opts: {
  nodeId: string;
  event: string;
  payloadJSON?: string | null;
}) => void;

export type BridgeListConnectedFn = () => Array<{ nodeId: string }>;

export type BridgeSubscriptionManager = {
  subscribe: (nodeId: string, sessionKey: string) => void;
  unsubscribe: (nodeId: string, sessionKey: string) => void;
  unsubscribeAll: (nodeId: string) => void;
  sendToSession: (
    sessionKey: string,
    event: string,
    payload: unknown,
    sendEvent?: BridgeSendEventFn | null,
  ) => void;
  sendToAllSubscribed: (
    event: string,
    payload: unknown,
    sendEvent?: BridgeSendEventFn | null,
  ) => void;
  sendToAllConnected: (
    event: string,
    payload: unknown,
    listConnected?: BridgeListConnectedFn | null,
    sendEvent?: BridgeSendEventFn | null,
  ) => void;
  clear: () => void;
};

export function createBridgeSubscriptionManager(): BridgeSubscriptionManager {
  const bridgeNodeSubscriptions = new Map<string, Set<string>>();
  const bridgeSessionSubscribers = new Map<string, Set<string>>();

  const toPayloadJSON = (payload: unknown) => (payload ? JSON.stringify(payload) : null);

  const subscribe = (nodeId: string, sessionKey: string) => {
    const normalizedNodeId = nodeId.trim();
    const normalizedSessionKey = sessionKey.trim();
    if (!normalizedNodeId || !normalizedSessionKey) return;

    let nodeSet = bridgeNodeSubscriptions.get(normalizedNodeId);
    if (!nodeSet) {
      nodeSet = new Set<string>();
      bridgeNodeSubscriptions.set(normalizedNodeId, nodeSet);
    }
    if (nodeSet.has(normalizedSessionKey)) return;
    nodeSet.add(normalizedSessionKey);

    let sessionSet = bridgeSessionSubscribers.get(normalizedSessionKey);
    if (!sessionSet) {
      sessionSet = new Set<string>();
      bridgeSessionSubscribers.set(normalizedSessionKey, sessionSet);
    }
    sessionSet.add(normalizedNodeId);
  };

  const unsubscribe = (nodeId: string, sessionKey: string) => {
    const normalizedNodeId = nodeId.trim();
    const normalizedSessionKey = sessionKey.trim();
    if (!normalizedNodeId || !normalizedSessionKey) return;

    const nodeSet = bridgeNodeSubscriptions.get(normalizedNodeId);
    nodeSet?.delete(normalizedSessionKey);
    if (nodeSet?.size === 0) bridgeNodeSubscriptions.delete(normalizedNodeId);

    const sessionSet = bridgeSessionSubscribers.get(normalizedSessionKey);
    sessionSet?.delete(normalizedNodeId);
    if (sessionSet?.size === 0) bridgeSessionSubscribers.delete(normalizedSessionKey);
  };

  const unsubscribeAll = (nodeId: string) => {
    const normalizedNodeId = nodeId.trim();
    const nodeSet = bridgeNodeSubscriptions.get(normalizedNodeId);
    if (!nodeSet) return;
    for (const sessionKey of nodeSet) {
      const sessionSet = bridgeSessionSubscribers.get(sessionKey);
      sessionSet?.delete(normalizedNodeId);
      if (sessionSet?.size === 0) bridgeSessionSubscribers.delete(sessionKey);
    }
    bridgeNodeSubscriptions.delete(normalizedNodeId);
  };

  const sendToSession = (
    sessionKey: string,
    event: string,
    payload: unknown,
    sendEvent?: BridgeSendEventFn | null,
  ) => {
    const normalizedSessionKey = sessionKey.trim();
    if (!normalizedSessionKey || !sendEvent) return;
    const subs = bridgeSessionSubscribers.get(normalizedSessionKey);
    if (!subs || subs.size === 0) return;

    const payloadJSON = toPayloadJSON(payload);
    for (const nodeId of subs) {
      sendEvent({ nodeId, event, payloadJSON });
    }
  };

  const sendToAllSubscribed = (
    event: string,
    payload: unknown,
    sendEvent?: BridgeSendEventFn | null,
  ) => {
    if (!sendEvent) return;
    const payloadJSON = toPayloadJSON(payload);
    for (const nodeId of bridgeNodeSubscriptions.keys()) {
      sendEvent({ nodeId, event, payloadJSON });
    }
  };

  const sendToAllConnected = (
    event: string,
    payload: unknown,
    listConnected?: BridgeListConnectedFn | null,
    sendEvent?: BridgeSendEventFn | null,
  ) => {
    if (!sendEvent || !listConnected) return;
    const payloadJSON = toPayloadJSON(payload);
    for (const node of listConnected()) {
      sendEvent({ nodeId: node.nodeId, event, payloadJSON });
    }
  };

  const clear = () => {
    bridgeNodeSubscriptions.clear();
    bridgeSessionSubscribers.clear();
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
