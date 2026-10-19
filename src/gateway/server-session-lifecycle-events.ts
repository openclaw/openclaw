// Projects session lifecycle updates to websocket subscribers.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { getRuntimeConfig } from "../config/io.js";
import type { SessionLifecycleEvent } from "../sessions/session-lifecycle-events.js";
import { runOutsideAsyncWorkScope } from "../shared/async-work-scope.js";
import type { GatewayBroadcastToConnIdsFn } from "./server-broadcast-types.js";
import type { SessionEventSubscriberRegistry } from "./server-chat-state.js";
import { resolveVisibleActiveSessionRunState } from "./server-methods/session-active-runs.js";
import type { GatewayContextResolver } from "./server-methods/types.js";
import { hasSessionChangeReceivers } from "./session-change-receivers.js";
import { buildGatewaySessionSnapshot } from "./session-event-payload.js";
import { withPreparedEventRow } from "./session-event-prepared-row.js";
import { prepareSessionEventProjection } from "./session-event-projection.js";
import {
  resolvePrivateSessionEventBroadcastScope,
  resolveSessionEventAgentScope,
} from "./session-request-agent.js";
import type { SessionRowProjection } from "./session-row-projection.js";
import { resolveSessionSubscriptionKeys } from "./session-subscription-keys.js";

type SessionEventSubscribers = Pick<SessionEventSubscriberRegistry, "getAll">;

/** Creates a lifecycle-event broadcaster for session list refreshes. */
export function createLifecycleEventBroadcastHandler(params: {
  broadcastToConnIds: GatewayBroadcastToConnIdsFn;
  sessionEventSubscribers: SessionEventSubscribers;
  getSessionRowProjection?: () => SessionRowProjection | undefined;
  resolveGatewayContext?: GatewayContextResolver;
}) {
  return async (emittedEvent: SessionLifecycleEvent): Promise<void> => {
    const connIds = params.sessionEventSubscribers.getAll();
    if (!hasSessionChangeReceivers(connIds)) {
      return;
    }
    const agentScope = resolveSessionEventAgentScope(
      getRuntimeConfig(),
      emittedEvent.sessionKey,
      normalizeOptionalString(emittedEvent.agentId),
      true,
    );
    if (!agentScope) {
      return;
    }
    const [eventAgentId, routingAgentId, compatibilityOwnerAgentId] = agentScope;
    const broadcastOptions = {
      ...resolvePrivateSessionEventBroadcastScope(emittedEvent.sessionKey, agentScope),
      sessionEventSubscriptionKeys: routingAgentId
        ? resolveSessionSubscriptionKeys(
            emittedEvent.sessionKey,
            routingAgentId,
            compatibilityOwnerAgentId,
          )
        : [emittedEvent.sessionKey],
      dropIfSlow: true,
    };
    // Key-only lifecycle deletes invalidate membership; a later row is not deletion evidence.
    if (
      emittedEvent.reason === "delete" ||
      !routingAgentId ||
      (!eventAgentId && !compatibilityOwnerAgentId)
    ) {
      params.broadcastToConnIds(
        "sessions.changed",
        {
          sessionKey: emittedEvent.sessionKey,
          ...(eventAgentId ? { agentId: eventAgentId } : {}),
          reason: emittedEvent.reason,
          ...(emittedEvent.catalogChanged ? { catalogChanged: true } : {}),
          ts: Date.now(),
        },
        connIds,
        broadcastOptions,
      );
      return;
    }
    const projection = params.getSessionRowProjection?.();
    const query = { key: emittedEvent.sessionKey, agentId: routingAgentId };
    const captured = projection?.capture(query);
    // Discovery has no original incarnation: publish current facts, not the old event's fields.
    const event: SessionLifecycleEvent =
      projection && !captured
        ? {
            sessionKey: emittedEvent.sessionKey,
            agentId: emittedEvent.agentId,
            reason: "updated",
            ...(emittedEvent.catalogChanged ? { catalogChanged: true } : {}),
          }
        : emittedEvent;
    const readActiveState = (session: { key: string; sessionId?: string }, storePath: string) =>
      resolveVisibleActiveSessionRunState({
        storePath,
        resolveGatewayContext: params.resolveGatewayContext,
        physicalPaths: projection?.physicalPaths,
        requestedKey: event.sessionKey,
        canonicalKey: session.key,
        sessionId: session.sessionId,
        agentId: routingAgentId,
        defaultAgentId: compatibilityOwnerAgentId,
        // Capacity transitions retain their synchronous memory edge before row preparation.
        projectedAgentRunIndex:
          event.reason === "run-capacity"
            ? undefined
            : projection?.state.rowContext.projectedAgentRuns,
      });
    // Capacity acquisition and release can both occur before row preparation settles.
    const capacityState =
      event.reason === "run-capacity" && projection
        ? readActiveState(
            {
              key: captured?.key ?? event.sessionKey,
              sessionId: captured?.entry?.sessionId,
            },
            captured?.storeTarget.storePath ??
              projection.state.scope({ agentId: routingAgentId }).path,
          )
        : undefined;
    // Committed lifecycle publications settle with the Gateway, not their producer's scope.
    await runOutsideAsyncWorkScope(() =>
      withPreparedEventRow(projection, query, (read, ancestors) => {
        const current = captured ?? projection?.capture(query);
        if (
          params.getSessionRowProjection?.() !== projection ||
          (projection && (!current || !projection.isCurrent(current)))
        ) {
          return;
        }
        const record = read?.describe(query);
        const sessionRow = record && read?.present(record);
        const activeRunState =
          capacityState ??
          (sessionRow && record ? readActiveState(sessionRow, record.storeTarget.storePath) : null);
        params.broadcastToConnIds(
          "sessions.changed",
          {
            sessionKey: event.sessionKey,
            ...(eventAgentId ? { agentId: eventAgentId } : {}),
            reason: event.reason,
            ...(event.catalogChanged ? { catalogChanged: true } : {}),
            parentSessionKey: event.parentSessionKey,
            label: event.label,
            displayName: event.displayName,
            ts: Date.now(),
            ...buildGatewaySessionSnapshot({
              sessionRow,
              includeSession: true,
              agentId: eventAgentId,
              label: event.label,
              displayName: event.displayName,
              parentSessionKey: event.parentSessionKey,
              activeRunState,
            }),
            ...(event.swarmGroupId
              ? {
                  swarmGroupId: event.swarmGroupId,
                  kind: event.kind,
                  text: event.text,
                }
              : {}),
          },
          connIds,
          {
            ...broadcastOptions,
            ...(read && projection
              ? {
                  prepareSessionProjection: prepareSessionEventProjection(projection, read, {
                    ancestors,
                  }),
                }
              : {}),
          },
        );
      }),
    );
  };
}
