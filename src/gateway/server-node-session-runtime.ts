import {
  isPairedDeviceNodeBindingCurrent,
  resolveCurrentPairedDeviceNodeBinding,
} from "../infra/device-pairing-node-state.js";
import type { VoiceWakeRoutingConfig } from "../infra/voicewake-routing.js";
import { GATEWAY_EVENT_NODE_RUNNER_INVENTORY_CHANGED } from "./events.js";
import { isLiveTextAppend } from "./live-text-continuity.js";
import {
  createNodeRegistryRuntime,
  setNodeRunnerStateChangedListener,
  type NodeRunnerStateChange,
} from "./node-registry-private.js";
import {
  NodeRegistry,
  serializeEventPayload,
  type NodeRegistryOptions,
  type NodeEventPayloadPreparation,
  type SerializedEventPayload,
} from "./node-registry.js";
import type { GatewayBroadcastOpts } from "./server-broadcast-types.js";
import type {
  SessionEventSubscriberRegistry,
  SessionMessageSubscriberRegistry,
} from "./server-chat-state.js";
import { hasConnectedTalkNode } from "./talk/nodes.js";

export function createGatewayNodeSessionRuntime(params: {
  broadcast: (event: string, payload: unknown, opts?: { dropIfSlow?: boolean }) => void;
  listRegisteredNodePluginToolCommands?: NodeRegistryOptions["listRegisteredNodePluginToolCommands"];
  getConfig?: NodeRegistryOptions["getConfig"];
  onRunnerStateChanged?: (nodeId: string, change: NodeRunnerStateChange) => void;
  resolveCurrentPairingState?: NodeRegistryOptions["resolveCurrentPairingState"];
  isPairingStateCurrent?: NodeRegistryOptions["isPairingStateCurrent"];
  onPairingInvalidated?: NodeRegistryOptions["onPairingInvalidated"];
  onPairingGenerationChanged?: NodeRegistryOptions["onPairingGenerationChanged"];
  sessionEventSubscribers: SessionEventSubscriberRegistry;
  sessionMessageSubscribers: SessionMessageSubscriberRegistry;
}) {
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
  const nodeSubscriptionIndex = new Map<
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
    createSend: (entry: Entry) => () => ReturnType<typeof nodeSendEvent>,
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

    let nodeEntry = nodeSubscriptionIndex.get(normalizedNodeId);
    if (nodeEntry?.pairingGeneration !== normalizedPairingGeneration) {
      unsubscribeAll(normalizedNodeId);
      nodeEntry = undefined;
    }
    if (!nodeEntry) {
      nodeEntry = {
        pairingGeneration: normalizedPairingGeneration,
        sessionKeys: new Map(),
      };
      nodeSubscriptionIndex.set(normalizedNodeId, nodeEntry);
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

    const nodeEntry = nodeSubscriptionIndex.get(normalizedNodeId);
    if (nodeEntry?.pairingGeneration !== normalizedPairingGeneration) {
      return;
    }
    nodeEntry.sessionKeys.delete(normalizedSessionKey);
    if (nodeEntry.sessionKeys.size === 0) {
      nodeSubscriptionIndex.delete(normalizedNodeId);
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
    const nodeEntry = nodeSubscriptionIndex.get(normalizedNodeId);
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
    nodeSubscriptionIndex.delete(normalizedNodeId);
  }

  const updatePairingGeneration = (change: {
    nodeId: string;
    previousPairingGeneration: string;
    nextPairingGeneration: string;
    preserveSubscriptions: boolean;
  }) => {
    const normalizedNodeId = change.nodeId.trim();
    const previousPairingGeneration = change.previousPairingGeneration.trim();
    const nextPairingGeneration = change.nextPairingGeneration.trim();
    const nodeEntry = nodeSubscriptionIndex.get(normalizedNodeId);
    if (
      !nodeEntry ||
      !previousPairingGeneration ||
      nodeEntry.pairingGeneration !== previousPairingGeneration
    ) {
      return;
    }
    if (!change.preserveSubscriptions || !nextPairingGeneration) {
      unsubscribeAll(normalizedNodeId, previousPairingGeneration);
      return;
    }
    nodeEntry.pairingGeneration = nextPairingGeneration;
    for (const subscription of nodeEntry.sessionKeys.values()) {
      subscription.pairingGeneration = nextPairingGeneration;
    }
  };

  const nodeSendToSession = async (
    sessionKey: string,
    event: string,
    payload: unknown,
    opts?: GatewayBroadcastOpts,
  ) => {
    const normalizedSessionKey = sessionKey.trim();
    if (!normalizedSessionKey) {
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
          nodeSendEvent({
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
          nodeSendEvent({
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

  const sendToAllSubscribed = async (event: string, payload: unknown) => {
    const payloadJSON = toPayloadJSON(payload);
    if (payloadJSON === undefined) {
      return;
    }
    await settleFanout(
      nodeSubscriptionIndex,
      ([nodeId, subscription]) =>
        () =>
          nodeSendEvent({
            nodeId,
            pairingGeneration: subscription.pairingGeneration,
            event,
            payloadJSON,
          }),
    );
  };
  const { nodeRegistry, nodeWorkerSupervisorTransport } = createNodeRegistryRuntime(
    () =>
      new NodeRegistry({
        listRegisteredNodePluginToolCommands: params.listRegisteredNodePluginToolCommands,
        getConfig: params.getConfig,
        resolveCurrentPairingState:
          params.resolveCurrentPairingState ?? resolveCurrentPairedDeviceNodeBinding,
        isPairingStateCurrent: params.isPairingStateCurrent ?? isPairedDeviceNodeBindingCurrent,
        onPairingInvalidated: params.onPairingInvalidated,
        onDesktopAvailabilityChanged: (nodeId) => {
          params.broadcast(
            GATEWAY_EVENT_NODE_RUNNER_INVENTORY_CHANGED,
            { nodeId },
            { dropIfSlow: true },
          );
        },
        onPairingGenerationChanged: (change) => {
          updatePairingGeneration({
            ...change,
            preserveSubscriptions: change.preserveSessionState,
          });
          params.onPairingGenerationChanged?.(change);
        },
      }),
  );
  setNodeRunnerStateChangedListener(nodeRegistry, (nodeId, change) => {
    // Lifecycle listeners advance the session-list cache fence before clients
    // can react to either broadcast and issue an immediate refresh.
    params.onRunnerStateChanged?.(nodeId, change);
    if (change.inventoryChanged || change.availabilityChanged) {
      params.broadcast(
        GATEWAY_EVENT_NODE_RUNNER_INVENTORY_CHANGED,
        { nodeId },
        { dropIfSlow: true },
      );
    }
  });
  const sessionEventSubscribers = params.sessionEventSubscribers;
  const sessionMessageSubscribers = params.sessionMessageSubscribers;
  const nodeSendEvent = (opts: {
    nodeId: string;
    pairingGeneration: string;
    event: string;
    payloadJSON?: SerializedEventPayload | null;
    preparePayload?: NodeEventPayloadPreparation;
  }) => {
    return nodeRegistry.sendEventRawForPairingGeneration(
      opts.nodeId,
      opts.pairingGeneration,
      opts.event,
      opts.payloadJSON ?? null,
      opts.preparePayload,
    );
  };
  const nodeSendToAllSubscribed = (event: string, payload: unknown) => {
    void sendToAllSubscribed(event, payload);
  };
  const resolveSubscriptionGeneration = (nodeId: string, connId?: string) => {
    const node = nodeRegistry.get(nodeId);
    return connId && node?.connId === connId ? node.pairingGeneration : undefined;
  };
  const nodeSubscribe = (nodeId: string, sessionKey: string, connId?: string) => {
    const pairingGeneration = resolveSubscriptionGeneration(nodeId, connId);
    if (pairingGeneration) {
      subscribe(nodeId, pairingGeneration, sessionKey);
    }
  };
  const nodeUnsubscribe = (nodeId: string, sessionKey: string, connId?: string) => {
    const pairingGeneration = resolveSubscriptionGeneration(nodeId, connId);
    if (pairingGeneration) {
      unsubscribe(nodeId, pairingGeneration, sessionKey);
    }
  };
  const sendVoiceWakeEventToCurrentNodes = (event: string, payload: unknown) => {
    const payloadJSON = serializeEventPayload(payload);
    for (const node of nodeRegistry.listConnected()) {
      const pairingGeneration = node.pairingGeneration;
      if (!pairingGeneration) {
        // Pending first-surface sessions have no command authority yet, but
        // their authenticated pairing identity still fences compatibility broadcasts.
        if (node.pairingIdentity) {
          void nodeRegistry
            .sendEventForPairingIdentity({
              nodeId: node.nodeId,
              connId: node.connId,
              pairingIdentity: node.pairingIdentity,
              event,
              payload,
            })
            .catch(() => undefined);
        }
        continue;
      }
      // Voice-wake broadcasts are fire-and-forget, but each node send still
      // resolves persistent generation before crossing its transport.
      void nodeRegistry
        .sendEventRawForPairingGeneration(node.nodeId, pairingGeneration, event, payloadJSON)
        .catch(() => undefined);
    }
  };
  const broadcastVoiceWakeChanged = (triggers: string[]) => {
    params.broadcast("voicewake.changed", { triggers }, { dropIfSlow: true });
    sendVoiceWakeEventToCurrentNodes("voicewake.changed", { triggers });
  };
  const broadcastVoiceWakeRoutingChanged = (config: VoiceWakeRoutingConfig) => {
    params.broadcast("voicewake.routing.changed", { config }, { dropIfSlow: true });
    sendVoiceWakeEventToCurrentNodes("voicewake.routing.changed", { config });
  };
  const hasTalkNodeConnected = () => hasConnectedTalkNode(nodeRegistry);

  return {
    nodeRegistry,
    nodeWorkerSupervisorTransport,
    sessionEventSubscribers,
    sessionMessageSubscribers,
    nodeHasSessionSubscribers: (sessionKey: string) => sessionSubscribers.has(sessionKey.trim()),
    nodeSendToSession,
    nodeSendToAllSubscribed,
    nodeSubscribe,
    nodeUnsubscribe,
    nodeUnsubscribeAll: unsubscribeAll,
    broadcastVoiceWakeChanged,
    broadcastVoiceWakeRoutingChanged,
    hasTalkNodeConnected,
  };
}
