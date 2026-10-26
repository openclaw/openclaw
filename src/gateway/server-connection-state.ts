import {
  GATEWAY_CLIENT_CAPS,
  hasGatewayClientCap,
} from "../../packages/gateway-protocol/src/client-info.js";
import type { GatewayScheduler } from "../infra/gateway-scheduler.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
// This state is transport-fed but can be constructed without HTTP or WebSocket servers.
import { createEventWebPushDelivery } from "./event-web-push.js";
import { createMentionInbox } from "./mention-inbox.js";
import { createPresenceRecipientProjection } from "./presence-projection.js";
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
import { ConnectionSessionRows } from "./session-ancestor-references.js";
import { prepareSessionEventProjection } from "./session-event-projection.js";
import { resolveSessionEventAgentScope } from "./session-request-agent.js";
import type { SessionRowProjection } from "./session-row-projection.js";
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
  const eventWebPush = createEventWebPushDelivery(loadRuntimeConfig, {
    isViewedOnDevice: (deviceId, sessionKey) =>
      sessionViewers?.isViewedOnDevice(deviceId, sessionKey) === true,
  });
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
