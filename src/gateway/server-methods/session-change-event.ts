import type { OpenClawConfig } from "../../config/types.openclaw.js";
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
import type { SessionRowProjection } from "../session-row-projection.js";
import { invalidateSessionSharingSnapshot } from "../session-sharing.js";
import { resolveSessionStoreKey } from "../session-store-key.js";
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

type SessionChange = {
  key: string;
  payload: SessionChangedPayload;
  scope: SessionEventAgentScope | null;
  captured?: ReturnType<SessionRowProjection["capture"]>;
  captureFailed?: true;
};

type SessionChangeOwner = {
  pending: Map<string, PendingSessionChange>;
  registerStop?: () => () => void;
  unregister?: () => void;
};

type PendingSessionChange = {
  context: SessionChangeContext;
  owner: SessionChangeOwner;
  key: string;
  scope: SessionEventAgentScope | null;
  oldestTombstone?: SessionChange;
  latest?: SessionChange;
  refresh: boolean;
  catalogChanged: boolean;
  due: boolean;
  firstDeferredAt?: number;
  timer: ReturnType<typeof setTimeout> | null;
  work?: Promise<void>;
};

const SESSIONS_CHANGED_DEBOUNCE_MS = 100;
const SESSIONS_CHANGED_MAX_WAIT_MS = 500;
const log = createSubsystemLogger("gateway/session-events");
const sessionChangeOwners = new WeakMap<object, SessionChangeOwner>();
const pendingSessionChanges = new Set<PendingSessionChange>();

function ownerFor(context: object): SessionChangeOwner {
  let owner = sessionChangeOwners.get(context);
  if (!owner) {
    owner = { pending: new Map() };
    sessionChangeOwners.set(context, owner);
  }
  return owner;
}

function registerPendingLifetime(owner: SessionChangeOwner): void {
  owner.unregister ??= owner.registerStop?.();
}

/** The Gateway sidecar owner admits late work until its existing shutdown seal. */
export function attachSessionChangeEventLifetime(
  context: object,
  registerStop: () => () => void,
): void {
  const owner = ownerFor(context);
  if (owner.registerStop && owner.registerStop !== registerStop) {
    throw new Error("Session changes already belong to a Gateway lifetime");
  }
  owner.registerStop = registerStop;
  if (owner.pending.size > 0) {
    registerPendingLifetime(owner);
  }
}

function sessionChangeKey(
  cfg: OpenClawConfig,
  payload: SessionChangedPayload,
  scope: SessionEventAgentScope | null,
) {
  const routingAgentId = scope?.[1];
  const key =
    payload.sessionKey && routingAgentId
      ? resolveSessionStoreKey({
          cfg,
          sessionKey: payload.sessionKey,
          storeAgentId: routingAgentId,
        })
      : (payload.sessionKey ?? "");
  return `${routingAgentId ?? payload.agentId ?? ""}\0${key}`;
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
  includeSnapshot = true,
): void {
  const connIds = context.getSessionEventSubscriberConnIds();
  if (!hasSessionChangeReceivers(connIds)) {
    return;
  }
  if (scope === null) {
    return;
  }
  const [eventAgentId, routingAgentId, compatibilityOwnerAgentId] = scope;
  const routingOptions = {
    ...(routingAgentId ? { agentId: routingAgentId } : {}),
    dropIfSlow: true,
  };
  const eventPayload = {
    ...payload,
    ...(eventAgentId ? { agentId: eventAgentId } : {}),
    ts: Date.now(),
  };
  if (!includeSnapshot) {
    // Native plugins need the keyed notice, but a keyed WebSocket payload would
    // ask recipient projection to read the unavailable row again.
    if (payload.sessionKey) {
      context.broadcastToConnIds(
        "sessions.changed",
        {
          ...eventPayload,
          ...(routingAgentId
            ? {
                sessionKey: resolveSessionStoreKey({
                  cfg: context.getRuntimeConfig(),
                  sessionKey: payload.sessionKey,
                  storeAgentId: routingAgentId,
                }),
                agentId: routingAgentId,
              }
            : {}),
        },
        new Set<string>(),
        routingOptions,
      );
    }
    context.broadcastToConnIds(
      "sessions.changed",
      {
        reason: "update",
        ...(routingAgentId ? { agentId: routingAgentId } : {}),
        ...(payload.catalogChanged ? { catalogChanged: true } : {}),
        ts: eventPayload.ts,
      },
      connIds,
      routingOptions,
    );
    return;
  }
  const broadcastOptions = {
    ...routingOptions,
    ...resolvePrivateSessionEventBroadcastScope(payload.sessionKey, scope),
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

function releasePendingSessionChange(pending: PendingSessionChange): void {
  pendingSessionChanges.delete(pending);
  pending.owner.pending.delete(pending.key);
  if (pending.owner.pending.size === 0) {
    pending.owner.unregister?.();
    pending.owner.unregister = undefined;
  }
}

function captureSessionChange(
  context: SessionChangeContext,
  payload: SessionChangedPayload,
  scope: SessionEventAgentScope | null,
  key: string,
): SessionChange {
  const change: SessionChange = { key, payload, scope };
  const query = snapshotTarget(payload, scope);
  try {
    change.captured = query ? getSessionRowProjection(context)?.capture(query) : undefined;
  } catch (error) {
    change.captureFailed = true;
    log.warn("Session change capture failed", { error });
  }
  return change;
}

async function publishSessionChange(context: SessionChangeContext, change: SessionChange) {
  const { payload, scope, captured } = change;
  const projection = getSessionRowProjection(context);
  const query = snapshotTarget(payload, scope);
  let publicationStarted = false;
  const broadcast = (includeSnapshot = true) => {
    publicationStarted = true;
    broadcastSessionsChanged(context, payload, scope, includeSnapshot);
  };
  try {
    if (change.captureFailed) {
      broadcast(false);
    } else if (query && projection) {
      const prepared = await projection.withPreparedExactRows(
        () => [query],
        () => {
          broadcast(!captured || projection.isCurrent(captured));
        },
        { includeAncestors: true },
      );
      if (prepared.kind !== "complete") {
        broadcast(false);
      }
    } else {
      broadcast();
    }
  } catch (error) {
    if (publicationStarted) {
      throw error;
    }
    log.warn("Session change preparation failed", { error });
    broadcast(false);
  }
}

function startPendingSessionChange(pending: PendingSessionChange, leading?: SessionChange): void {
  if (pending.work) {
    return;
  }
  pending.work = Promise.resolve()
    .then(async () => {
      if (leading) {
        await publishSessionChange(pending.context, leading);
      }
      while (pending.due) {
        const next = pending.oldestTombstone ?? pending.latest;
        if (next) {
          if (pending.oldestTombstone === next) {
            pending.oldestTombstone = undefined;
          }
          if (pending.latest === next) {
            pending.latest = undefined;
          }
          await publishSessionChange(pending.context, next);
        } else if (pending.refresh) {
          pending.refresh = false;
          // Condensed generations need an authoritative roster read; the latest keyed
          // notice above also reaches plugin subscribers that ignore broad invalidations.
          broadcastSessionsChanged(
            pending.context,
            {
              reason: "update",
              ...(pending.catalogChanged ? { catalogChanged: true } : {}),
            },
            pending.scope,
            false,
          );
        } else {
          break;
        }
      }
    })
    .catch((error: unknown) => {
      log.warn("Session change publication failed", { error });
    })
    .then(() => {
      pending.work = undefined;
      if (pending.due && (pending.oldestTombstone || pending.latest || pending.refresh)) {
        startPendingSessionChange(pending);
      } else if (!pending.timer) {
        releasePendingSessionChange(pending);
      }
    });
}

function finishPendingSessionChange(pending: PendingSessionChange): void {
  if (pending.timer) {
    clearTimeout(pending.timer);
    pending.timer = null;
  }
  pending.due = true;
  if (pending.oldestTombstone || pending.latest || pending.refresh) {
    startPendingSessionChange(pending);
  } else if (!pending.work) {
    releasePendingSessionChange(pending);
  }
}

/** Flush timers and join publications, including work admitted during the drain. */
export async function flushPendingSessionsChangedEvents(context?: object): Promise<void> {
  for (;;) {
    const pending = [...pendingSessionChanges].filter(
      (entry) => !context || entry.context === context,
    );
    if (!pending.length) {
      return;
    }
    pending.forEach(finishPendingSessionChange);
    await Promise.all(pending.flatMap((entry) => (entry.work ? [entry.work] : [])));
  }
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
    context.mentionInbox?.invalidate(payload.sessionKey);
  }
  const connIds = context.getSessionEventSubscriberConnIds();
  if (!hasSessionChangeReceivers(connIds)) {
    return;
  }
  const cfg = context.getRuntimeConfig();
  const scope: SessionEventAgentScope | null = payload.sessionKey
    ? resolveSessionEventAgentScope(cfg, payload.sessionKey, payload.agentId)
    : [payload.agentId, payload.agentId, undefined];
  if (options.preparedPublication) {
    return broadcastSessionsChanged(context, payload, scope);
  }
  const publicationKey = sessionChangeKey(cfg, payload, scope);
  const key = JSON.stringify([
    scope,
    payload.reason === "delete",
    payload.sessionId,
    payload.compacted,
  ]);
  const owner = ownerFor(context);
  const pending = owner.pending.get(publicationKey);
  if (pending) {
    pending.scope = scope;
    pending.catalogChanged ||= payload.catalogChanged === true;
    const latestPayload = {
      ...payload,
      ...(pending.catalogChanged ? { catalogChanged: true as const } : {}),
    };
    if (pending.latest?.key === key) {
      pending.latest.payload = latestPayload;
      pending.latest.scope = scope;
    } else {
      const next = captureSessionChange(context, latestPayload, scope, key);
      // Retain the first deletion and newest notice. Intermediate unpublished
      // generations collapse to a broad refresh instead of an unbounded FIFO.
      if (pending.latest && pending.latest !== pending.oldestTombstone) {
        pending.refresh = true;
      }
      if (payload.reason === "delete") {
        pending.oldestTombstone ??= next;
      }
      pending.latest = next;
    }
    if (pending.due) {
      startPendingSessionChange(pending);
      return;
    }
    pending.firstDeferredAt ??= Date.now();
    if (pending.timer) {
      clearTimeout(pending.timer);
    }
    const maxWaitRemaining = pending.firstDeferredAt + SESSIONS_CHANGED_MAX_WAIT_MS - Date.now();
    pending.timer = setTimeout(
      () => finishPendingSessionChange(pending),
      Math.max(0, Math.min(SESSIONS_CHANGED_DEBOUNCE_MS, maxWaitRemaining)),
    );
    pending.timer.unref?.();
    return;
  }
  try {
    registerPendingLifetime(owner);
  } catch (error) {
    log.warn("Session change was not admitted", { error });
    return;
  }
  const next: PendingSessionChange = {
    context,
    owner,
    key: publicationKey,
    scope,
    refresh: false,
    catalogChanged: payload.catalogChanged === true,
    due: false,
    timer: null,
  };
  owner.pending.set(publicationKey, next);
  pendingSessionChanges.add(next);
  next.timer = setTimeout(() => finishPendingSessionChange(next), SESSIONS_CHANGED_DEBOUNCE_MS);
  next.timer.unref?.();
  startPendingSessionChange(next, captureSessionChange(context, payload, scope, key));
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
