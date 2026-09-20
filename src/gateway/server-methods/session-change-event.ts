import { createSubsystemLogger } from "../../logging/subsystem.js";
// Shared sessions.changed broadcaster for gateway RPC and chat-command mutations.
import { parseAgentSessionKey } from "../../routing/session-key.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { bumpGatewayAccessRevision } from "../gateway-access-revision.js";
import { hasSessionChangeReceivers } from "../session-change-receivers.js";
import { buildGatewaySessionSnapshot } from "../session-event-payload.js";
import {
  resolvePrivateSessionEventBroadcastScope,
  resolveSessionEventAgentScope,
  type SessionEventAgentScope,
} from "../session-request-agent.js";
import { getSessionRowProjection } from "../session-row-projection-access.js";
import { invalidateSessionSharingSnapshot } from "../session-sharing.js";
import { resolveVisibleActiveSessionRunState } from "./session-active-runs.js";
import type { GatewayRequestContext } from "./types.js";

type SessionChangedPayload = {
  sessionKey?: string;
  sessionId?: string;
  agentId?: string;
  reason: string;
  compacted?: boolean;
  catalogChanged?: true;
};

type SessionChangeContext = Pick<
  GatewayRequestContext,
  | "broadcastToConnIds"
  | "chatAbortControllers"
  | "getRuntimeConfig"
  | "sessionRowProjectionOwner"
  | "getSessionEventSubscriberConnIds"
  | "workerSessionPlacementService"
  | "mentionInbox"
>;

type PendingSessionChange = {
  context: SessionChangeContext;
  dirty: boolean;
  firstDeferredAt?: number;
  key: string;
  payload: SessionChangedPayload;
  scope: SessionEventAgentScope | null;
  timer: ReturnType<typeof setTimeout> | null;
  publication?: Promise<void>;
};

const SESSIONS_CHANGED_DEBOUNCE_MS = 100;
const SESSIONS_CHANGED_MAX_WAIT_MS = 500;
const log = createSubsystemLogger("gateway/session-events");
const pendingChangesByContext = new WeakMap<object, Map<string, PendingSessionChange>>();
const pendingSessionChanges = new Set<PendingSessionChange>();

function sessionChangeKey(payload: SessionChangedPayload, scope: SessionEventAgentScope | null) {
  return `${scope?.[1] ?? payload.agentId ?? ""}\0${payload.sessionKey ?? ""}`;
}

function snapshotTarget(payload: SessionChangedPayload, scope: SessionEventAgentScope | null) {
  return payload.reason !== "delete" &&
    payload.sessionKey &&
    scope?.[1] &&
    (scope[0] || scope[2] || parseAgentSessionKey(payload.sessionKey))
    ? { key: payload.sessionKey, agentId: scope[1] }
    : undefined;
}

function broadcastSessionsChanged(
  context: SessionChangeContext,
  payload: SessionChangedPayload,
  scope: SessionEventAgentScope | null,
): void {
  const connIds = context.getSessionEventSubscriberConnIds();
  if (!hasSessionChangeReceivers(connIds)) {
    return;
  }
  if (scope === null) {
    return;
  }
  const [eventAgentId, routingAgentId, compatibilityOwnerAgentId] = scope;
  const privateBroadcastScope = resolvePrivateSessionEventBroadcastScope(payload.sessionKey, scope);
  const broadcastAgentId = routingAgentId;
  const broadcastOptions = {
    ...(broadcastAgentId ? { agentId: broadcastAgentId } : {}),
    ...privateBroadcastScope,
    dropIfSlow: true,
  };
  const eventPayload = {
    ...payload,
    ...(eventAgentId ? { agentId: eventAgentId } : {}),
    ts: Date.now(),
  };
  // A deletion describes the removed generation, never the row now occupying its key.
  const query = snapshotTarget(payload, scope);
  if (!query) {
    context.broadcastToConnIds("sessions.changed", eventPayload, connIds, broadcastOptions);
    return;
  }
  const projection = getSessionRowProjection(context);
  const currentRow = projection?.snapshot(query).row;
  const sessionRow =
    payload.sessionId && payload.sessionId !== currentRow?.sessionId ? null : currentRow;
  const activeRunState =
    sessionRow && (sessionRow.key !== "global" || routingAgentId !== undefined)
      ? resolveVisibleActiveSessionRunState({
          context,
          requestedKey: payload.sessionKey ?? sessionRow.key,
          canonicalKey: sessionRow.key,
          sessionId: sessionRow.sessionId,
          agentId: routingAgentId,
          defaultAgentId: compatibilityOwnerAgentId,
          projectedAgentRunIndex: projection?.state.rowContext.projectedAgentRuns,
        })
      : null;
  context.broadcastToConnIds(
    "sessions.changed",
    {
      ...eventPayload,
      ...(sessionRow
        ? {
            ...buildGatewaySessionSnapshot({
              sessionRow,
              includeSession: true,
              agentId: eventAgentId,
              activeRunState,
            }),
            ...(context.workerSessionPlacementService
              ? {
                  placement: sessionRow.placement ?? null,
                  placementMove: sessionRow.placementMove ?? null,
                }
              : {}),
          }
        : {}),
    },
    connIds,
    {
      ...broadcastOptions,
      ...(sessionRow?.key ? { sessionKeys: [sessionRow.key] } : {}),
    },
  );
}

function publish(pending: PendingSessionChange): Promise<void> {
  if (pending.publication) {
    return pending.publication;
  }
  pending.dirty = false;
  pending.firstDeferredAt = undefined;
  const { context, payload, scope } = pending;
  const projection = getSessionRowProjection(context);
  const query = snapshotTarget(payload, scope);
  const captured = query ? projection?.capture(query) : undefined;
  return (pending.publication = Promise.resolve().then(async () => {
    try {
      if (query && projection) {
        do {
          await projection.ensureMaterialized();
        } while (projection.needsMaterialization);
      }
      if (!captured || projection?.isCurrent(captured)) {
        broadcastSessionsChanged(context, payload, scope);
      }
    } catch (error) {
      log.warn("Session change publication failed", { error });
    } finally {
      pending.publication = undefined;
      if (!pending.timer) {
        await finishPendingSessionChange(pending);
      }
    }
  }));
}

function finishPendingSessionChange(pending: PendingSessionChange): Promise<void> | undefined {
  if (pending.timer) {
    clearTimeout(pending.timer);
    pending.timer = null;
  }
  if (pending.dirty) {
    return publish(pending);
  }
  if (pending.publication) {
    return pending.publication;
  }
  pendingSessionChanges.delete(pending);
  pendingChangesByContext.get(pending.context)?.delete(pending.key);
  return undefined;
}

/** Flush trailing notifications and join publications before gateway shutdown. */
export async function flushPendingSessionsChangedEvents(context?: object): Promise<void> {
  await Promise.all(
    [...pendingSessionChanges]
      .filter((pending) => !context || pending.context === context)
      .flatMap((pending) => {
        const publication = finishPendingSessionChange(pending);
        return publication ? [publication] : [];
      }),
  );
}

export function emitSessionsChanged(
  context: SessionChangeContext,
  payload: SessionChangedPayload,
  options: { accessChanged?: boolean; preparedPublication?: boolean; catalogOnly?: boolean } = {},
): void {
  // Catalog absorption changes no session facts. Rename/delete callers retain
  // normal invalidation because their sweeps can have committed member changes.
  const catalogOnly = options.catalogOnly && payload.reason === "groups" && !payload.sessionKey;
  if (!options.preparedPublication && !catalogOnly) {
    sessionChanges.emit(
      payload.sessionKey
        ? {
            sessionKey: payload.sessionKey,
            ...(payload.agentId ? { agentId: payload.agentId } : {}),
          }
        : { all: true, scope: "sessions" },
    );
  }
  // Only a committed producer may certify unchanged access; unknown changes stay conservative.
  if (!catalogOnly && options.accessChanged !== false) {
    bumpGatewayAccessRevision();
  }
  if (!catalogOnly) {
    invalidateSessionSharingSnapshot(payload.sessionKey);
    // Inbox subscriptions are independent of session-list subscriptions, including a closed sidebar.
    context.mentionInbox?.invalidate();
  }
  const connIds = context.getSessionEventSubscriberConnIds();
  if (!hasSessionChangeReceivers(connIds)) {
    return;
  }
  const scope: SessionEventAgentScope | null = payload.sessionKey
    ? resolveSessionEventAgentScope(context.getRuntimeConfig(), payload.sessionKey, payload.agentId)
    : [payload.agentId, payload.agentId, undefined];
  if (options.preparedPublication) {
    return broadcastSessionsChanged(context, payload, scope);
  }
  const key = sessionChangeKey(payload, scope);
  const byKey = pendingChangesByContext.get(context) ?? new Map<string, PendingSessionChange>();
  pendingChangesByContext.set(context, byKey);
  const pending = byKey.get(key);
  if (pending) {
    pending.payload = {
      ...payload,
      ...(pending.payload.catalogChanged ? { catalogChanged: true } : {}),
    };
    pending.scope = scope;
    pending.dirty = true;
    pending.firstDeferredAt ??= Date.now();
    if (pending.timer) {
      clearTimeout(pending.timer);
    }
    // Keep resetting for a quiet-period trailing emit without letting a sustained
    // mutation stream postpone the authoritative row forever.
    const maxWaitRemaining = pending.firstDeferredAt + SESSIONS_CHANGED_MAX_WAIT_MS - Date.now();
    pending.timer = setTimeout(
      () => {
        void finishPendingSessionChange(pending);
      },
      Math.max(0, Math.min(SESSIONS_CHANGED_DEBOUNCE_MS, maxWaitRemaining)),
    );
    pending.timer.unref?.();
    return;
  }

  // Lead after a quiet period for responsive UI, then coalesce a burst into one trailing
  // rebuild. The trailing row is loaded only when emitted, so it reflects the newest state.
  const next: PendingSessionChange = {
    context,
    dirty: false,
    key,
    payload,
    scope,
    timer: null,
  };
  next.timer = setTimeout(() => {
    void finishPendingSessionChange(next);
  }, SESSIONS_CHANGED_DEBOUNCE_MS);
  next.timer.unref?.();
  byKey.set(key, next);
  pendingSessionChanges.add(next);
  void publish(next);
}

export function emitSessionArchived(
  context: SessionChangeContext,
  sessionKey: string | undefined,
  agentId?: string,
): void {
  if (!sessionKey) {
    return;
  }
  emitSessionsChanged(context, {
    sessionKey,
    ...(agentId ? { agentId } : {}),
    reason: "archive",
  });
}
