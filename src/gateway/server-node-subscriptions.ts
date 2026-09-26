// Gateway node subscription manager.
// Maintains bidirectional node/session fanout indexes.
import { isLiveTextAppend } from "./live-text-continuity.js";
import {
  serializeEventPayload,
  type NodeEventPayloadPreparation,
  type SerializedEventPayload,
} from "./node-registry.js";
import type { GatewayBroadcastOpts } from "./server-broadcast-types.js";

// Node subscription manager keeps bidirectional node/session indexes so gateway
// events can fan out by session and all node cleanup paths remove reverse links.
type NodeSendEventFn = (opts: {
  nodeId: string;
  pairingGeneration: string;
  event: string;
  payloadJSON?: SerializedEventPayload | null;
  preparePayload?: NodeEventPayloadPreparation;
}) => void | Promise<unknown>;

type NodeSubscriptionManager = {
  subscribe: (nodeId: string, pairingGeneration: string, sessionKey: string) => void;
  unsubscribe: (nodeId: string, pairingGeneration: string, sessionKey: string) => void;
  unsubscribeAll: (nodeId: string, pairingGeneration?: string) => void;
  hasSubscribers: (sessionKey: string) => boolean;
  updatePairingGeneration: (params: {
    nodeId: string;
    previousPairingGeneration: string;
    nextPairingGeneration: string;
    preserveSubscriptions: boolean;
  }) => void;
  sendToSession: (
    sessionKey: string,
    event: string,
    payload: unknown,
    sendEvent?: NodeSendEventFn | null,
    opts?: GatewayBroadcastOpts,
  ) => Promise<void>;
  sendToAllSubscribed: (
    event: string,
    payload: unknown,
    sendEvent?: NodeSendEventFn | null,
  ) => Promise<void>;
};

/** Manages node subscriptions to gateway session events. */
export function createNodeSubscriptionManager(): NodeSubscriptionManager {
  type Subscription = { pairingGeneration: string };
  type Recipient = { pairingGeneration: string; subscriptions: Map<string, Subscription> };
  type Publication = {
    sourceEpoch?: object;
    text?: string;
    version: unknown;
    sessionKeys: string[];
    isCurrent?: () => boolean;
    settled: boolean;
  };
  type Receipt = { connId: string; publication: Publication };
  const nodeSubscriptions = new Map<
    string,
    { pairingGeneration: string; sessionKeys: Map<string, Subscription> }
  >();
  const sessionSubscribers = new Map<string, Map<string, Subscription>>();
  const liveTextGroups = new WeakMap<
    AbortSignal,
    {
      publications: Map<string, Publication>;
      receipts: WeakMap<Subscription, Map<string, Receipt>>;
      pending: Set<Publication>;
    }
  >();

  const isPublicationCurrent = (publication: Publication) => {
    try {
      return publication.isCurrent?.() !== false;
    } catch {
      return false;
    }
  };

  const currentSubscription = (nodeId: string, recipient: Recipient) => {
    for (const [key, subscription] of recipient.subscriptions) {
      if (
        sessionSubscribers.get(key)?.get(nodeId) === subscription &&
        subscription.pairingGeneration === recipient.pairingGeneration
      ) {
        return subscription;
      }
    }
    return undefined;
  };

  const toPayloadJSON = (payload: unknown): SerializedEventPayload | null | undefined => {
    try {
      return serializeEventPayload(payload);
    } catch {
      return undefined;
    }
  };

  const settleFanout = async <Entry>(
    entries: Iterable<Entry>,
    createSend: (entry: Entry) => () => ReturnType<NodeSendEventFn>,
  ): Promise<void> => {
    // Build sender closures before yielding without retaining iterator tuples.
    // Settle failures because public Gateway callers fire-and-forget this fanout.
    await Promise.allSettled(
      Array.from(entries, (entry) => Promise.resolve().then(createSend(entry))),
    );
  };

  const subscribe = (nodeId: string, pairingGeneration: string, sessionKey: string) => {
    const normalizedNodeId = nodeId.trim();
    const normalizedPairingGeneration = pairingGeneration.trim();
    const normalizedSessionKey = sessionKey.trim();
    if (!normalizedNodeId || !normalizedPairingGeneration || !normalizedSessionKey) {
      return;
    }

    let nodeEntry = nodeSubscriptions.get(normalizedNodeId);
    if (nodeEntry?.pairingGeneration !== normalizedPairingGeneration) {
      unsubscribeAll(normalizedNodeId);
      nodeEntry = undefined;
    }
    if (!nodeEntry) {
      nodeEntry = {
        pairingGeneration: normalizedPairingGeneration,
        sessionKeys: new Map(),
      };
      nodeSubscriptions.set(normalizedNodeId, nodeEntry);
    }
    if (nodeEntry.sessionKeys.has(normalizedSessionKey)) {
      return;
    }
    const subscription = { pairingGeneration: normalizedPairingGeneration };
    nodeEntry.sessionKeys.set(normalizedSessionKey, subscription);

    let sessionMap = sessionSubscribers.get(normalizedSessionKey);
    if (!sessionMap) {
      sessionMap = new Map();
      sessionSubscribers.set(normalizedSessionKey, sessionMap);
    }
    sessionMap.set(normalizedNodeId, subscription);
  };

  const unsubscribe = (nodeId: string, pairingGeneration: string, sessionKey: string) => {
    const normalizedNodeId = nodeId.trim();
    const normalizedPairingGeneration = pairingGeneration.trim();
    const normalizedSessionKey = sessionKey.trim();
    if (!normalizedNodeId || !normalizedPairingGeneration || !normalizedSessionKey) {
      return;
    }

    const nodeEntry = nodeSubscriptions.get(normalizedNodeId);
    if (nodeEntry?.pairingGeneration !== normalizedPairingGeneration) {
      return;
    }
    nodeEntry.sessionKeys.delete(normalizedSessionKey);
    if (nodeEntry.sessionKeys.size === 0) {
      nodeSubscriptions.delete(normalizedNodeId);
    }

    const sessionMap = sessionSubscribers.get(normalizedSessionKey);
    if (sessionMap?.get(normalizedNodeId)?.pairingGeneration === normalizedPairingGeneration) {
      sessionMap.delete(normalizedNodeId);
    }
    if (sessionMap?.size === 0) {
      sessionSubscribers.delete(normalizedSessionKey);
    }
  };

  function unsubscribeAll(nodeId: string, pairingGeneration?: string) {
    const normalizedNodeId = nodeId.trim();
    const nodeEntry = nodeSubscriptions.get(normalizedNodeId);
    if (
      !nodeEntry ||
      (pairingGeneration !== undefined && nodeEntry.pairingGeneration !== pairingGeneration.trim())
    ) {
      return;
    }
    // Remove reverse session indexes before deleting the node index so session
    // fanout cannot retain disconnected node ids.
    for (const sessionKey of nodeEntry.sessionKeys.keys()) {
      const sessionMap = sessionSubscribers.get(sessionKey);
      if (sessionMap?.get(normalizedNodeId)?.pairingGeneration === nodeEntry.pairingGeneration) {
        sessionMap.delete(normalizedNodeId);
      }
      if (sessionMap?.size === 0) {
        sessionSubscribers.delete(sessionKey);
      }
    }
    nodeSubscriptions.delete(normalizedNodeId);
  }

  const updatePairingGeneration = (params: {
    nodeId: string;
    previousPairingGeneration: string;
    nextPairingGeneration: string;
    preserveSubscriptions: boolean;
  }) => {
    const normalizedNodeId = params.nodeId.trim();
    const previousPairingGeneration = params.previousPairingGeneration.trim();
    const nextPairingGeneration = params.nextPairingGeneration.trim();
    const nodeEntry = nodeSubscriptions.get(normalizedNodeId);
    if (
      !nodeEntry ||
      !previousPairingGeneration ||
      nodeEntry.pairingGeneration !== previousPairingGeneration
    ) {
      return;
    }
    if (!params.preserveSubscriptions || !nextPairingGeneration) {
      unsubscribeAll(normalizedNodeId, previousPairingGeneration);
      return;
    }
    nodeEntry.pairingGeneration = nextPairingGeneration;
    for (const subscription of nodeEntry.sessionKeys.values()) {
      subscription.pairingGeneration = nextPairingGeneration;
    }
  };

  const sendToSession = async (
    sessionKey: string,
    event: string,
    payload: unknown,
    sendEvent?: NodeSendEventFn | null,
    opts?: GatewayBroadcastOpts,
  ) => {
    const normalizedSessionKey = sessionKey.trim();
    if (!normalizedSessionKey || !sendEvent) {
      return;
    }
    const sessionKeys = [
      ...new Set(
        (opts?.sessionKeys ?? [normalizedSessionKey]).map((key) => key.trim()).filter(Boolean),
      ),
    ];
    const subscribers = new Map<string, Recipient>();
    for (const key of sessionKeys) {
      for (const [nodeId, subscription] of sessionSubscribers.get(key) ?? []) {
        let recipient = subscribers.get(nodeId);
        if (!recipient) {
          recipient = {
            pairingGeneration: subscription.pairingGeneration,
            subscriptions: new Map(),
          };
          subscribers.set(nodeId, recipient);
        }
        recipient.subscriptions.set(key, subscription);
      }
    }
    const liveText = opts?.liveText;
    if (liveText?.settle && !liveText.group.aborted) {
      for (const publication of liveTextGroups.get(liveText.group)?.pending ?? []) {
        if (
          sessionKeys.some((key) => publication.sessionKeys.includes(key)) &&
          isPublicationCurrent(publication)
        ) {
          publication.settled = true;
        }
      }
    }
    if (!subscribers.size) {
      return;
    }
    if (!liveText?.projection) {
      const payloadJSON = toPayloadJSON(payload);
      if (payloadJSON === undefined) {
        return;
      }
      return settleFanout(subscribers, ([nodeId, recipient]) => {
        return () =>
          sendEvent({
            nodeId,
            pairingGeneration: recipient.pairingGeneration,
            event,
            payloadJSON,
            preparePayload: () =>
              currentSubscription(nodeId, recipient) ? { payloadJSON } : undefined,
          });
      });
    }
    if (liveText.group.aborted) {
      return;
    }
    const projection = liveText.projection;
    const streamKey = projection.key;
    let group = liveTextGroups.get(liveText.group);
    if (!group) {
      group = { publications: new Map(), receipts: new WeakMap(), pending: new Set() };
      liveTextGroups.set(liveText.group, group);
      const retiredGroup = group;
      liveText.group.addEventListener(
        "abort",
        () => {
          retiredGroup.publications.clear();
          if (retiredGroup.pending.size === 0) {
            retiredGroup.receipts = new WeakMap();
          }
          liveTextGroups.delete(liveText.group);
        },
        { once: true },
      );
    }
    const latest = group.publications.get(streamKey);
    const previousPublication = latest?.sourceEpoch === liveText.sourceEpoch ? latest : undefined;
    const publication: Publication = {
      sourceEpoch: liveText.sourceEpoch,
      text: projection.text?.snapshot,
      version: projection.version,
      sessionKeys,
      isCurrent: liveText.isCurrent,
      settled: false,
    };
    group.publications.set(streamKey, publication);
    const snapshot =
      projection.snapshot ||
      (projection.text !== undefined &&
        !isLiveTextAppend(previousPublication?.text, projection.text));

    // Each representation is serialized only if a current recipient needs it.
    let snapshotJSON: SerializedEventPayload | null | undefined;
    let deltaJSON: SerializedEventPayload | null | undefined;
    group.pending.add(publication);
    try {
      await settleFanout(subscribers, ([nodeId, recipient]) => {
        return () =>
          sendEvent({
            nodeId,
            pairingGeneration: recipient.pairingGeneration,
            event,
            preparePayload: (connId) => {
              const subscription = currentSubscription(nodeId, recipient);
              if (
                !subscription ||
                (!publication.settled &&
                  (liveText.group.aborted || !isPublicationCurrent(publication)))
              ) {
                return undefined;
              }
              const receipt = group.receipts.get(subscription)?.get(streamKey);
              const append =
                !snapshot &&
                receipt?.connId === connId &&
                receipt.publication === previousPublication &&
                Object.is(previousPublication?.version, publication.version);
              const payloadJSON = append
                ? (deltaJSON ??= toPayloadJSON(projection.delta(payload)))
                : (snapshotJSON ??= toPayloadJSON(payload));
              if (payloadJSON === undefined) {
                return undefined;
              }
              return {
                payloadJSON,
                onSent: () => {
                  if (!liveText.group.aborted || publication.settled) {
                    let receipts = group.receipts.get(subscription);
                    if (!receipts) {
                      receipts = new Map();
                      group.receipts.set(subscription, receipts);
                    }
                    receipts.set(streamKey, { connId, publication });
                  }
                },
              };
            },
          });
      });
    } finally {
      group.pending.delete(publication);
      if (liveText.group.aborted && group.pending.size === 0) {
        group.receipts = new WeakMap();
      }
    }
  };

  const sendToAllSubscribed = async (
    event: string,
    payload: unknown,
    sendEvent?: NodeSendEventFn | null,
  ) => {
    if (!sendEvent) {
      return;
    }
    const payloadJSON = toPayloadJSON(payload);
    if (payloadJSON === undefined) {
      return;
    }
    await settleFanout(
      nodeSubscriptions,
      ([nodeId, subscription]) =>
        () =>
          sendEvent({
            nodeId,
            pairingGeneration: subscription.pairingGeneration,
            event,
            payloadJSON,
          }),
    );
  };

  return {
    subscribe,
    unsubscribe,
    unsubscribeAll,
    hasSubscribers: (sessionKey) => sessionSubscribers.has(sessionKey.trim()),
    updatePairingGeneration,
    sendToSession,
    sendToAllSubscribed,
  };
}
