import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { parseAgentSessionKey } from "../routing/session-key.js";
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
import { resolveVisibleActiveSessionRunState } from "./server-methods/session-active-runs.js";
import { GatewayClientRegistry } from "./server/client-registry.js";
import { buildGatewaySessionSnapshot } from "./session-event-payload.js";
import { resolveSessionEventAgentScope } from "./session-request-agent.js";
import { prepareProjectedSessionPresentation } from "./session-row-presentation.js";
import type { SessionRowProjection } from "./session-row-projection.js";
import { canReceiveSessionEvent, prepareProjectedSessionSharing } from "./session-sharing.js";

/** Creates transport-independent connection, subscription, and run state. */
export function createGatewayConnectionState(params: {
  bootId: string;
  cfg: import("../config/config.js").OpenClawConfig;
  getRuntimeConfig?: () => import("../config/config.js").OpenClawConfig;
}) {
  const loadRuntimeConfig = params.getRuntimeConfig ?? (() => params.cfg);
  let sessionRowProjection: SessionRowProjection | undefined;
  const clients = new GatewayClientRegistry();
  // RPCs survive ordinary disconnects, so connection-owned projections still
  // validate the live transport before publishing into a retired connection.
  const isConnectionActive = (connId: string) => {
    const client = clients.getByConnectionId(connId);
    return Boolean(client && !client.invalidated);
  };
  const sessionEventSubscribers = createSessionEventSubscriberRegistry(isConnectionActive);
  const sessionMessageSubscribers = createSessionMessageSubscriberRegistry(isConnectionActive);
  const eventWebPush = createEventWebPushDelivery({ getRuntimeConfig: loadRuntimeConfig });
  const gatewayBroadcaster = createGatewayBroadcaster({
    clients,
    preparePresenceProjection: (presence) =>
      createPresenceRecipientProjection({ cfg: loadRuntimeConfig(), presence }),
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
      if (
        !projection ||
        (event !== "sessions.changed" && event !== "session.message") ||
        !isRecord(payload)
      ) {
        return undefined;
      }
      const source = payload;
      if (source.reason === "delete" || typeof source.sessionKey !== "string") {
        return undefined;
      }
      const scope = resolveSessionEventAgentScope(
        loadRuntimeConfig(),
        source.sessionKey,
        typeof source.agentId === "string" ? source.agentId : eventScope.agentId,
      );
      if (!scope?.[1] || (!scope[0] && !scope[2] && !parseAgentSessionKey(source.sessionKey))) {
        return undefined;
      }
      const query = { key: source.sessionKey, agentId: scope[1] };
      const record = projection.describe(query);
      if (
        !record ||
        (typeof source.sessionId === "string" && source.sessionId !== record.entry.sessionId)
      ) {
        return () => undefined;
      }
      const base = isRecord(source.session)
        ? source
        : {
            ...buildGatewaySessionSnapshot({
              sessionRow: projection.snapshot(query).row,
              agentId: scope[0],
              includeSession: true,
            }),
            ...source,
          };
      const sourceRow = base.session;
      if (
        !isRecord(sourceRow) ||
        sourceRow.sessionId !== record.entry.sessionId ||
        (sourceRow.lifecycleRevision !== undefined &&
          sourceRow.lifecycleRevision !== record.entry.lifecycleRevision)
      ) {
        return () => undefined;
      }
      const now = Date.now();
      const ancestors = projection.ancestorRows(record);
      return (client) => {
        if (!projection.isCurrent(record)) {
          return undefined;
        }
        const { projectedAgentRuns } = projection.state.rowContext;
        const presentation = prepareProjectedSessionPresentation(
          projection,
          client,
          now,
          (selection) =>
            resolveVisibleActiveSessionRunState({
              ...selection,
              context: { chatAbortControllers },
              projectedAgentRunIndex: projectedAgentRuns,
            }),
        );
        const enrichment = { includeDerivedTitles: true, includeLastMessage: true };
        const { row } = presentation.snapshot(query, enrichment);
        if (!row) {
          return undefined;
        }
        const projected: Record<string, unknown> = {
          ...base,
          session: row,
          ancestorSessions: ancestors?.every((ancestor) => projection.isCurrent(ancestor))
            ? ancestors.flatMap((ancestor) => {
                if (presentation.sharing.entryFilter?.(ancestor.key, ancestor.entry) === false) {
                  return [];
                }
                const presented = presentation.present(ancestor, enrichment);
                return presented ? [presented] : [];
              })
            : undefined,
          visibility: row.visibility,
          sharingRole: row.sharingRole,
          ...(isRecord(base.activitySummary) && row.activitySummary
            ? {
                activitySummary: {
                  ...base.activitySummary,
                  canEnsure: row.activitySummary.canEnsure,
                },
              }
            : {}),
        };
        if (Object.hasOwn(projected, "childSessions")) {
          projected.childSessions = row.childSessions;
        }
        return projected;
      };
    },
    onBroadcast: (event, payload, opts) => eventWebPush.handleEvent(event, payload, opts),
  });
  const mentionInbox = createMentionInbox({
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
  const chatRunState = createChatRunState();
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
      return () => {
        if (sessionRowProjection === projection) {
          sessionRowProjection = undefined;
        }
      };
    },
    clients,
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
