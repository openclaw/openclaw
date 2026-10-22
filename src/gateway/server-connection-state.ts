import {
  GATEWAY_CLIENT_CAPS,
  hasGatewayClientCap,
} from "../../packages/gateway-protocol/src/client-info.js";
import type { GatewayScheduler } from "../infra/gateway-scheduler.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
// This state is transport-fed but can be constructed without HTTP or WebSocket servers.
import { createEventWebPushDelivery } from "./event-web-push.js";
import { createMentionInbox } from "./mention-inbox.js";
import { authorizeCurrentOperatorRoleScopes } from "./operator-role-policy.js";
import { createPresenceRecipientProjection } from "./presence-projection.js";
import { hasEventScope } from "./server-broadcast-scopes.js";
import { createGatewayBroadcaster } from "./server-broadcast.js";
import {
  createChatRunState,
  createSessionEventSubscriberRegistry,
  createSessionMessageSubscriberRegistry,
} from "./server-chat-state.js";
import { GatewayConnectionWork } from "./server-connection-work.js";
import { WEBSOCKET_OPEN_READY_STATE } from "./server-constants.js";
import type { GatewayClient } from "./server-methods/client-types.js";
import { createVisibleActiveSessionRunProjector } from "./server-methods/session-active-runs.js";
import type { GatewayContextResolver } from "./server-methods/types.js";
import { GatewayClientRegistry } from "./server/client-registry.js";
import type { GatewayWsClient } from "./server/ws-types.js";
import { ConnectionSessionRows } from "./session-ancestor-references.js";
import { prepareSessionEventProjection } from "./session-event-projection.js";
import { resolveSessionEventAgentScope } from "./session-request-agent.js";
import type { SessionRowProjection } from "./session-row-projection.js";
import type { SessionSharingTarget } from "./session-sharing-policy.js";
import { canReceiveSessionEvent, prepareProjectedSessionSharing } from "./session-sharing.js";
import type { SessionViewerPresenceDeclarations } from "./session-viewer-presence.js";

/** Creates transport-independent connection, subscription, and run state. */
export function createGatewayConnectionState(params: {
  scheduler: GatewayScheduler;
  bootId: string;
  resolveGatewayContext?: GatewayContextResolver;
  cfg: import("../config/config.js").OpenClawConfig;
  getRuntimeConfig?: () => import("../config/config.js").OpenClawConfig;
}) {
  const loadRuntimeConfig = params.getRuntimeConfig ?? (() => params.cfg);
  let sessionRowProjection: SessionRowProjection | undefined;
  const connectionRows = new WeakMap<GatewayClient, ConnectionSessionRows>();
  const clients = new GatewayClientRegistry(undefined, (client) => {
    connectionRows.get(client)?.clear("close");
    connectionRows.delete(client);
    client.presenceSnapshot = undefined;
  });
  // Subscription changes revoke ancestor certification, not socket-held wire rows.
  const forgetConnectionAncestors = (connId: string) => {
    const client = clients.getByConnectionId(connId);
    if (client) {
      connectionRows.get(client)?.clearAncestors();
    }
  };
  const clearConnectionRows = () => {
    const histories = new Map<object, object>();
    for (const client of clients) {
      connectionRows.get(client)?.clear("projection", histories);
    }
  };
  const clearAncestors = () => {
    const histories = new Map<object, object>();
    for (const client of clients) {
      connectionRows.get(client)?.clearAncestors(histories);
    }
  };
  const forgetAncestor = (key: string) => {
    const histories = new Map<object, object>();
    for (const client of clients) {
      connectionRows.get(client)?.forget(key, histories);
    }
  };
  // RPCs survive ordinary disconnects, so connection-owned projections still
  // validate the live transport before publishing into a retired connection.
  const isConnectionActive = (connId: string) => {
    const client = clients.getByConnectionId(connId);
    return Boolean(client && !client.invalidated && !client.connectionSignal?.aborted);
  };
  const sessionEventSubscribers = createSessionEventSubscriberRegistry(
    isConnectionActive,
    forgetConnectionAncestors,
  );
  const sessionMessageSubscribers = createSessionMessageSubscriberRegistry(
    isConnectionActive,
    forgetConnectionAncestors,
  );
  // Lifecycle owns viewer declarations; agent-finished pushes fail open until it attaches them.
  let sessionViewers: SessionViewerPresenceDeclarations | undefined;
  const eventWebPush = createEventWebPushDelivery(
    loadRuntimeConfig,
    {
      isViewedOnDevice: (deviceId, sessionKey) =>
        sessionViewers?.isViewedOnDevice(deviceId, sessionKey) === true,
    },
    () => sessionRowProjection,
  );
  // Only this connection owner can admit its one synchronous access notification.
  const accessPublications = new WeakMap<
    object,
    {
      client: GatewayClient;
      agentId: string;
      sessionKey: string;
      isCurrent: () => boolean;
    }
  >();
  const gatewayBroadcaster = createGatewayBroadcaster({
    clients,
    preparePresenceProjection: (presence) =>
      createPresenceRecipientProjection({
        cfg: loadRuntimeConfig(),
        presence,
        projection: sessionRowProjection,
      }),
    sessionMessageSubscribers,
    onSessionDeliveryLost: (client) => {
      if (hasGatewayClientCap(client.connect.caps, GATEWAY_CLIENT_CAPS.SESSION_ROW_DELTAS)) {
        connectionRows.get(client)?.clear("delivery-lost");
      }
    },
    canReceiveSessionEvent: (client, sessionKeys, agentId, event, payload) => {
      if (event === "session.access.changed") {
        const proof =
          payload && typeof payload === "object" ? accessPublications.get(payload) : undefined;
        return (
          proof?.client === client &&
          proof.agentId === agentId &&
          sessionKeys.length === 1 &&
          sessionKeys[0] === proof.sessionKey &&
          proof.isCurrent()
        );
      }
      try {
        const projection = sessionRowProjection;
        const cfg = loadRuntimeConfig();
        const policyConfig = projection?.getPolicyConfig() ?? cfg;
        const prepared = projection
          ? {
              sharing: prepareProjectedSessionSharing({
                cfg: policyConfig,
                client,
                isMember: (target, identity) =>
                  projection.hasMembership(target.storePath, target.storeKey, identity),
              }),
              target: (key: string, owner?: string) => {
                const scope = resolveSessionEventAgentScope(cfg, key, owner);
                return scope?.[1] ? projection.sharingTarget({ key, agentId: scope[1] }) : null;
              },
            }
          : undefined;
        if (!prepared) {
          return false;
        }
        return canReceiveSessionEvent({
          cfg,
          policyConfig,
          client,
          sessionKeys,
          agentId,
          event,
          payload,
          prepared,
        });
      } catch {
        return false;
      }
    },
    prepareSessionEventProjection(event, payload, eventScope) {
      const projection = sessionRowProjection;
      if (!projection) {
        return undefined;
      }
      return (eventScope.prepareSessionProjection ?? prepareSessionEventProjection(projection))(
        event,
        payload,
        eventScope,
        {
          isCurrentProjection: (owner) => owner === sessionRowProjection,
          resolveAgentScope: (key, agentId) =>
            resolveSessionEventAgentScope(loadRuntimeConfig(), key, agentId),
          forgetAncestors: (key) => {
            if (key !== undefined) {
              forgetAncestor(key);
            } else {
              clearAncestors();
            }
          },
          references: (client) => {
            let references = connectionRows.get(client);
            if (!references) {
              references = new ConnectionSessionRows();
              connectionRows.set(client, references);
            }
            return references;
          },
          createRunProjector: () =>
            createVisibleActiveSessionRunProjector(
              projection.state.rowContext.projectedAgentRuns,
              undefined,
              params.resolveGatewayContext,
              projection.physicalPaths,
            ),
        },
      );
    },
    onBroadcast: (event, payload, opts) =>
      eventWebPush.handleEvent(
        event,
        payload,
        opts ? { agentId: opts.agentId, sessionKeys: opts.sessionKeys } : undefined,
      ),
  });
  function prepareSessionAccessChange(selected: SessionSharingTarget): () => void {
    const projection = sessionRowProjection;
    const query = { key: selected.canonicalKey, agentId: selected.agentId };
    const initialState = projection?.sharingTargetState(query);
    if (!projection || initialState?.status !== "ready") {
      return () => {};
    }
    const initial = initialState.target;
    if (
      initial.storePath !== selected.storePath ||
      initial.storeKey !== selected.storeKey ||
      initial.entry.sessionId !== selected.entry.sessionId ||
      initial.entry.lifecycleRevision !== selected.entry.lifecycleRevision
    ) {
      return () => {};
    }
    const source = projection.readSource({ ...query, storePath: initial.storePath });
    const currentTarget = () => {
      if (projection !== sessionRowProjection) {
        return undefined;
      }
      const state = projection.sharingTargetState(query);
      if (state.status !== "ready") {
        return undefined;
      }
      const target = state.target;
      const currentSource = projection.readSource({ ...query, storePath: target.storePath });
      return target.generation === initial.generation &&
        target.storePath === initial.storePath &&
        target.storeKey === initial.storeKey &&
        target.entry.sessionId === initial.entry.sessionId &&
        target.entry.lifecycleRevision === initial.entry.lifecycleRevision &&
        source &&
        currentSource?.path === source.path &&
        currentSource.databaseIdentity === source.databaseIdentity &&
        currentSource.databaseBirthtime === source.databaseBirthtime
        ? target
        : undefined;
    };
    const readAccess = (client: GatewayWsClient) => {
      try {
        if (
          !clients.has(client) ||
          client.invalidated ||
          client.connectionSignal?.aborted ||
          !hasEventScope(client, "session.access.changed", undefined, false, () => true)
        ) {
          return undefined;
        }
        const target = currentTarget();
        if (!target) {
          return undefined;
        }
        const cfg = loadRuntimeConfig();
        const policyConfig = projection.getPolicyConfig() ?? cfg;
        if (authorizeCurrentOperatorRoleScopes(client, policyConfig)) {
          return undefined;
        }
        const sharing = prepareProjectedSessionSharing({
          cfg: policyConfig,
          client,
          isMember: (candidate, identity) =>
            projection.hasMembership(candidate.storePath, candidate.storeKey, identity),
        });
        const readable = canReceiveSessionEvent({
          cfg,
          policyConfig,
          client,
          sessionKeys: [target.canonicalKey],
          agentId: target.agentId,
          prepared: { sharing, target: () => target },
        });
        const access = !readable
          ? ("revoked" as const)
          : sharing.authorizeTarget(target)
            ? ("read-only" as const)
            : ("read-write" as const);
        return { access, cacheKey: sharing.getCacheKey() };
      } catch {
        // Unavailable facts are not an observed revocation.
        return undefined;
      }
    };
    const recipients = [...clients].flatMap((client) => {
      const before = readAccess(client);
      return before ? [{ client, before }] : [];
    });
    let published = false;
    return () => {
      if (published) {
        return;
      }
      published = true;
      for (const { client, before } of recipients) {
        const after = readAccess(client);
        if (!after || after.cacheKey !== before.cacheKey || after.access === before.access) {
          continue;
        }
        const payload = Object.freeze({
          agentId: initial.agentId,
          sessionKey: initial.canonicalKey,
          sessionId: initial.entry.sessionId,
          access: after.access,
        });
        accessPublications.set(payload, {
          client,
          agentId: initial.agentId,
          sessionKey: initial.canonicalKey,
          isCurrent: () => {
            const current = readAccess(client);
            return current?.cacheKey === before.cacheKey && current.access === after.access;
          },
        });
        try {
          gatewayBroadcaster.broadcastToConnIds(
            "session.access.changed",
            payload,
            new Set([client.connId]),
            { agentId: initial.agentId, sessionKeys: [initial.canonicalKey] },
          );
        } finally {
          accessPublications.delete(payload);
        }
      }
    };
  }
  const mentionInbox = createMentionInbox({
    scheduler: params.scheduler,
    gatewayInstanceId: params.bootId,
    getRuntimeConfig: loadRuntimeConfig,
    *getClients() {
      // Draining connections remain registered, but no longer count as online recipients.
      for (const client of clients) {
        if (
          !client.invalidated &&
          client.socket.readyState === WEBSOCKET_OPEN_READY_STATE &&
          (client.connect.role ?? "operator") === "operator"
        ) {
          yield client;
        }
      }
    },
    broadcastToConnIds: gatewayBroadcaster.broadcastToConnIds,
    // Targeted websocket invalidations do not enter the global Web Push event hook.
    onMentionCreated: eventWebPush.deliverMention,
  });
  const agentRunSeq = new Map<string, number>();
  const dedupe = new Map<string, import("./server-shared.js").DedupeEntry>();
  const chatRunState = createChatRunState(isConnectionActive);
  const chatRunRegistry = chatRunState.registry;
  const addChatRun = chatRunRegistry.add;
  const removeChatRun = chatRunRegistry.remove;
  const toolEventRecipients = chatRunState.toolEventRecipients;

  return {
    getSessionRowProjection: () => sessionRowProjection,
    attachSessionRowProjection(this: void, projection: SessionRowProjection) {
      sessionRowProjection = projection;
      clearConnectionRows();
      const unsubscribe = sessionChanges.subscribeFacts((change) => {
        if (!("all" in change) && change.scope === "acp") {
          return;
        }
        if ("all" in change) {
          clearAncestors();
        } else if (change.factsInvalidated || (change.facts && change.facts.kind !== "unchanged")) {
          forgetAncestor(change.sessionKey);
        }
      });
      return () => {
        unsubscribe();
        if (sessionRowProjection === projection) {
          sessionRowProjection = undefined;
          clearConnectionRows();
        }
      };
    },
    attachSessionViewerPresence(this: void, declarations: SessionViewerPresenceDeclarations) {
      sessionViewers = declarations;
    },
    clients,
    prepareSessionAccessChange,
    forgetConnectionAncestors,
    connectionWork: new GatewayConnectionWork(),
    mentionInbox,
    isConnectionActive,
    ...gatewayBroadcaster,
    agentRunSeq,
    dedupe,
    chatRunState,
    addChatRun,
    removeChatRun,
    toolEventRecipients,
    sessionEventSubscribers,
    sessionMessageSubscribers,
  };
}
