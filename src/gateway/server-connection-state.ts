import type { GatewayScheduler } from "../infra/gateway-scheduler.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
// Gateway connection and run registries.
// This state is transport-fed but can be constructed without HTTP or WebSocket servers.
import type { ChatAbortControllerEntry } from "./chat-abort.js";
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
import { GatewayClientRegistry } from "./server/client-registry.js";
import { SessionAncestorReferences } from "./session-ancestor-references.js";
import { prepareSessionEventProjection } from "./session-event-projection.js";
import { resolveSessionEventAgentScope } from "./session-request-agent.js";
import type { SessionRowProjection } from "./session-row-projection.js";
import { canReceiveSessionEvent, prepareProjectedSessionSharing } from "./session-sharing.js";

/** Creates transport-independent connection, subscription, and run state. */
export function createGatewayConnectionState(params: {
  scheduler: GatewayScheduler;
  bootId: string;
  cfg: import("../config/config.js").OpenClawConfig;
  getRuntimeConfig?: () => import("../config/config.js").OpenClawConfig;
}) {
  const loadRuntimeConfig = params.getRuntimeConfig ?? (() => params.cfg);
  let sessionRowProjection: SessionRowProjection | undefined;
  let ancestorReferences = new WeakMap<GatewayClient, SessionAncestorReferences>();
  const clients = new GatewayClientRegistry(undefined, (client) => {
    ancestorReferences.delete(client);
  });
  const forgetConnectionAncestors = (connId: string) => {
    const client = clients.getByConnectionId(connId);
    if (client) {
      ancestorReferences.delete(client);
    }
  };
  const forgetAncestor = (key: string) => {
    for (const client of clients) {
      ancestorReferences.get(client)?.forget(key);
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
  const eventWebPush = createEventWebPushDelivery({ getRuntimeConfig: loadRuntimeConfig });
  const gatewayBroadcaster = createGatewayBroadcaster({
    clients,
    preparePresenceProjection: (presence) =>
      createPresenceRecipientProjection({
        cfg: loadRuntimeConfig(),
        presence,
        projection: sessionRowProjection,
      }),
    sessionMessageSubscribers,
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
        return canReceiveSessionEvent({
          cfg,
          policyConfig,
          client,
          sessionKeys,
          agentId,
          event,
          payload,
          ...(prepared ? { prepared } : {}),
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
      let projectedAgentRuns: SessionRowProjection["state"]["rowContext"]["projectedAgentRuns"];
      let registrations: (readonly [string, ChatAbortControllerEntry])[] = [];
      let projectRun: ReturnType<typeof createVisibleActiveSessionRunProjector> | undefined;
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
              ancestorReferences = new WeakMap();
            }
          },
          references: (client) => {
            let references = ancestorReferences.get(client);
            if (!references) {
              references = new SessionAncestorReferences();
              ancestorReferences.set(client, references);
            }
            return references;
          },
          forgetConnectionAncestors: (client) => ancestorReferences.delete(client),
          getRunProjector: () => {
            if (
              !projectRun ||
              registrations.length !== chatAbortControllers.size ||
              // Compare copied fields: registrations can mutate in place between recipients.
              registrations.some(([runId, previous]) => {
                const current = chatAbortControllers.get(runId);
                return (
                  !current ||
                  current.sessionKey !== previous.sessionKey ||
                  current.sessionId !== previous.sessionId ||
                  current.agentId !== previous.agentId ||
                  current.projectSessionActive !== previous.projectSessionActive ||
                  current.controlUiVisible !== previous.controlUiVisible
                );
              }) ||
              projectedAgentRuns !== projection.state.rowContext.projectedAgentRuns
            ) {
              registrations = Array.from(chatAbortControllers, ([runId, entry]) => [
                runId,
                { ...entry },
              ]);
              projectedAgentRuns = projection.state.rowContext.projectedAgentRuns;
              projectRun = createVisibleActiveSessionRunProjector(
                { chatAbortControllers: new Map(registrations) },
                projectedAgentRuns,
              );
            }
            return projectRun;
          },
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
  const chatAbortControllers = new Map<string, ChatAbortControllerEntry>();
  const chatQueuedTurns = new Map<string, import("./chat-queued-turns.js").QueuedChatTurnEntry>();
  const toolEventRecipients = chatRunState.toolEventRecipients;

  return {
    getSessionRowProjection: () => sessionRowProjection,
    attachSessionRowProjection(this: void, projection: SessionRowProjection) {
      sessionRowProjection = projection;
      ancestorReferences = new WeakMap();
      const unsubscribe = sessionChanges.subscribeFacts((change) => {
        if (!("all" in change) && change.scope === "acp") {
          return;
        }
        if ("all" in change) {
          ancestorReferences = new WeakMap();
        } else if (change.factsInvalidated || (change.facts && change.facts.kind !== "unchanged")) {
          forgetAncestor(change.sessionKey);
        }
      });
      return () => {
        unsubscribe();
        if (sessionRowProjection === projection) {
          sessionRowProjection = undefined;
          ancestorReferences = new WeakMap();
        }
      };
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
    chatAbortControllers,
    chatQueuedTurns,
    toolEventRecipients,
    sessionEventSubscribers,
    sessionMessageSubscribers,
  };
}
