// Shared sessions.changed broadcaster for gateway RPC and chat-command mutations.
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import { createDeferredCore, type Deferred } from "../../shared/deferred.js";
import { bumpGatewayAccessRevision } from "../gateway-access-revision.js";
import { hasSessionChangeReceivers } from "../session-change-receivers.js";
import { buildGatewaySessionSnapshot } from "../session-event-payload.js";
import {
  resolvePrivateSessionEventBroadcastScope,
  resolveSessionEventAgentScope,
  type SessionEventAgentScope,
} from "../session-request-agent.js";
import { invalidateSessionSharingSnapshot } from "../session-sharing.js";
import { resolveSessionStoreKey } from "../session-store-key.js";
import { loadGatewaySessionRow } from "../session-utils.js";
import { resolveVisibleActiveSessionRunState } from "./session-active-runs.js";
import {
  readSessionPlacementFields,
  type SessionPlacementReadContext,
} from "./session-placement-read-projection.js";
import type { GatewayRequestContext } from "./types.js";

type SessionChangedPayload = {
  sessionKey?: string;
  sessionId?: string;
  agentId?: string;
  reason: string;
  compacted?: boolean;
};

type SessionChangeContext = SessionPlacementReadContext &
  Pick<
    GatewayRequestContext,
    | "broadcastToConnIds"
    | "chatAbortControllers"
    | "getRuntimeConfig"
    | "getSessionEventSubscriberConnIds"
    | "mentionInbox"
  >;

type SessionChangePublication = {
  revision: number;
  pendingCount: number;
  work?: Promise<void>;
};

type SessionChangeOwner = {
  pending: Map<string, PendingSessionChange>;
  pendingCount: number;
  publications: Map<string, SessionChangePublication>;
  registerStop?: () => () => void;
  unregister?: () => void;
};

type DeferredSessionChange = { ready: Deferred; due: boolean; firstDeferredAt: number };

type PendingSessionChange = {
  context: SessionChangeContext;
  owner: SessionChangeOwner;
  trailing?: DeferredSessionChange;
  key: string;
  publicationKey: string;
  publication: SessionChangePublication;
  payload: SessionChangedPayload;
  scope: SessionEventAgentScope | null;
  timer: ReturnType<typeof setTimeout> | null;
  work?: Promise<void>;
};

const SESSIONS_CHANGED_DEBOUNCE_MS = 100;
const SESSIONS_CHANGED_MAX_WAIT_MS = 500;
const sessionsMutationVersions = new WeakMap<object, number>();
const sessionChangeOwners = new WeakMap<object, SessionChangeOwner>();
const pendingSessionChanges = new Set<PendingSessionChange>();
const log = createSubsystemLogger("gateway/session-changes");

export function readSessionsMutationVersion(context: object): number {
  return sessionsMutationVersions.get(context) ?? 0;
}

function ownerFor(context: object): SessionChangeOwner {
  let owner = sessionChangeOwners.get(context);
  if (!owner) {
    owner = { pending: new Map(), pendingCount: 0, publications: new Map() };
    sessionChangeOwners.set(context, owner);
  }
  return owner;
}

function registerPendingLifetime(owner: SessionChangeOwner): void {
  if (!owner.unregister) {
    owner.unregister = owner.registerStop?.();
  }
}

/** The Gateway's sidecar owner admits late work and rejects it after its shutdown seal. */
export function attachSessionChangeEventLifetime(
  context: object,
  registerStop: () => () => void,
): void {
  const owner = ownerFor(context);
  if (owner.registerStop && owner.registerStop !== registerStop) {
    throw new Error("Session changes already belong to a Gateway lifetime");
  }
  owner.registerStop = registerStop;
  if (owner.pendingCount > 0) {
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

async function broadcastSessionsChanged(
  context: SessionChangeContext,
  payload: SessionChangedPayload,
  scope: SessionEventAgentScope | null,
  isCurrent: () => boolean,
): Promise<void> {
  if (scope === null) {
    return;
  }
  const [eventAgentId, routingAgentId, compatibilityOwnerAgentId] = scope;
  const privateBroadcastScope = resolvePrivateSessionEventBroadcastScope(payload.sessionKey, scope);
  const broadcastOptions = {
    ...(routingAgentId ? { agentId: routingAgentId } : {}),
    ...privateBroadcastScope,
    dropIfSlow: true,
  };
  const eventPayload = {
    ...payload,
    ...(eventAgentId ? { agentId: eventAgentId } : {}),
    ts: Date.now(),
  };
  const publishInvalidation = () => {
    const connIds = context.getSessionEventSubscriberConnIds();
    if (hasSessionChangeReceivers(connIds)) {
      context.broadcastToConnIds("sessions.changed", eventPayload, connIds, broadcastOptions);
    }
  };
  // A deletion describes the removed generation, never the row now occupying its key.
  if (
    payload.reason === "delete" ||
    !payload.sessionKey ||
    !routingAgentId ||
    (!eventAgentId && !compatibilityOwnerAgentId && !parseAgentSessionKey(payload.sessionKey))
  ) {
    publishInvalidation();
    return;
  }
  let sessionRow: ReturnType<typeof loadGatewaySessionRow>;
  let placement: Awaited<ReturnType<typeof readSessionPlacementFields>> | undefined;
  try {
    sessionRow = loadGatewaySessionRow(payload.sessionKey, { agentId: routingAgentId });
    if (context.workerSessionPlacementService && sessionRow?.sessionId) {
      const capturedRow = sessionRow;
      placement = await readSessionPlacementFields(context, capturedRow.sessionId);
      if (!isCurrent()) {
        publishInvalidation();
        return;
      }
      sessionRow = loadGatewaySessionRow(payload.sessionKey, { agentId: routingAgentId });
      const currentScope = resolveSessionEventAgentScope(
        context.getRuntimeConfig(),
        payload.sessionKey,
        payload.agentId,
      );
      if (
        !sessionRow ||
        sessionRow.key !== capturedRow.key ||
        sessionRow.sessionId !== capturedRow.sessionId ||
        !currentScope ||
        currentScope.some((part, index) => part !== scope[index])
      ) {
        publishInvalidation();
        return;
      }
    }
  } catch (error) {
    log.warn(`Session change preparation failed: ${formatErrorMessage(error)}`);
    publishInvalidation();
    return;
  }
  const connIds = context.getSessionEventSubscriberConnIds();
  if (!hasSessionChangeReceivers(connIds)) {
    return;
  }
  const activeRunState =
    sessionRow && (sessionRow.key !== "global" || routingAgentId !== undefined)
      ? resolveVisibleActiveSessionRunState({
          context,
          requestedKey: payload.sessionKey ?? sessionRow.key,
          canonicalKey: sessionRow.key,
          sessionId: sessionRow.sessionId,
          agentId: routingAgentId,
          defaultAgentId: compatibilityOwnerAgentId,
        })
      : null;
  context.broadcastToConnIds(
    "sessions.changed",
    {
      ...eventPayload,
      ...(sessionRow
        ? buildGatewaySessionSnapshot({ sessionRow, agentId: eventAgentId, activeRunState })
        : {}),
      ...(placement
        ? { placement: placement.placement ?? null, placementMove: placement.placementMove ?? null }
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
  if (!pendingSessionChanges.delete(pending)) {
    return;
  }
  pending.publication.pendingCount -= 1;
  pending.owner.pendingCount -= 1;
  if (pending.publication.pendingCount === 0 && !pending.publication.work) {
    pending.owner.publications.delete(pending.publicationKey);
  }
  if (pending.owner.pending.get(pending.publicationKey) === pending) {
    pending.owner.pending.delete(pending.publicationKey);
  }
  if (pending.owner.pendingCount === 0) {
    pending.owner.unregister?.();
    pending.owner.unregister = undefined;
  }
}

function startPendingSessionChange(
  pending: PendingSessionChange,
  trailing?: DeferredSessionChange,
): void {
  const { context, payload, scope, publication } = pending;
  const previous = publication.work ?? Promise.resolve();
  const work = previous
    .then(async () => {
      if (trailing) {
        await trailing.ready.promise;
        pending.trailing = undefined;
      }
      const revision = publication.revision;
      return broadcastSessionsChanged(
        context,
        trailing ? pending.payload : payload,
        trailing ? pending.scope : scope,
        () => publication.revision === revision,
      );
    })
    .catch((error: unknown) => {
      log.warn(`Session change publication failed: ${formatErrorMessage(error)}`);
    })
    .then(() => {
      if (pending.work === work) {
        pending.work = undefined;
      }
      if (publication.work === work) {
        publication.work = undefined;
      }
      if (!pending.timer && !pending.work) {
        releasePendingSessionChange(pending);
      }
    });
  pending.work = work;
  publication.work = work;
}

function finishPendingSessionChange(pending: PendingSessionChange): void {
  if (pending.timer) {
    clearTimeout(pending.timer);
    pending.timer = null;
  }
  if (pending.trailing) {
    pending.trailing.due = true;
    pending.trailing.ready.resolve();
  } else if (!pending.work) {
    releasePendingSessionChange(pending);
  }
}

/** Flush timers and join every admitted preparation, including work admitted during the drain. */
export async function flushPendingSessionsChangedEvents(context?: object): Promise<void> {
  for (;;) {
    const pending = [...pendingSessionChanges].filter(
      (entry) => !context || entry.context === context,
    );
    if (!pending.length) {
      return;
    }
    for (const entry of pending) {
      finishPendingSessionChange(entry);
    }
    await Promise.all(pending.flatMap((entry) => (entry.work ? [entry.work] : [])));
  }
}

export function emitSessionsChanged(
  context: SessionChangeContext,
  payload: SessionChangedPayload,
  options: { accessChanged?: boolean } = {},
): void {
  // This fence advances synchronously, before asynchronous event preparation.
  sessionsMutationVersions.set(context, readSessionsMutationVersion(context) + 1);
  if (options.accessChanged !== false) {
    bumpGatewayAccessRevision();
  }
  invalidateSessionSharingSnapshot(payload.sessionKey);
  context.mentionInbox?.invalidate();
  const cfg = context.getRuntimeConfig();
  const scope: SessionEventAgentScope | null = payload.sessionKey
    ? resolveSessionEventAgentScope(cfg, payload.sessionKey, payload.agentId)
    : [payload.agentId, payload.agentId, undefined];
  const publicationKey = sessionChangeKey(cfg, payload, scope);
  if (!hasSessionChangeReceivers(context.getSessionEventSubscriberConnIds())) {
    const publication = sessionChangeOwners.get(context)?.publications.get(publicationKey);
    if (publication) {
      publication.revision += 1;
    }
    return;
  }
  // Tombstones keep their removed generation; ordinary notifications describe the latest row.
  const key = JSON.stringify([
    publicationKey,
    scope,
    payload.reason === "delete",
    payload.sessionId ?? null,
    payload.compacted ?? false,
  ]);
  const owner = ownerFor(context);
  const pending = owner.pending.get(publicationKey);
  if (pending?.key === key) {
    pending.publication.revision += 1;
    pending.payload = payload;
    pending.scope = scope;
    if (!pending.trailing) {
      pending.trailing = { ready: createDeferredCore(), due: false, firstDeferredAt: Date.now() };
      // Reserve FIFO position at admission, before a different generation can be queued.
      startPendingSessionChange(pending, pending.trailing);
    }
    if (pending.trailing.due) {
      return;
    }
    if (pending.timer) {
      clearTimeout(pending.timer);
    }
    const maxWaitRemaining =
      pending.trailing.firstDeferredAt + SESSIONS_CHANGED_MAX_WAIT_MS - Date.now();
    pending.timer = setTimeout(
      () => finishPendingSessionChange(pending),
      Math.max(0, Math.min(SESSIONS_CHANGED_DEBOUNCE_MS, maxWaitRemaining)),
    );
    pending.timer.unref?.();
    return;
  }
  if (pending) {
    finishPendingSessionChange(pending);
  }
  const publication = owner.publications.get(publicationKey) ?? { revision: 0, pendingCount: 0 };
  const next: PendingSessionChange = {
    context,
    owner,
    key,
    publicationKey,
    publication,
    payload,
    scope,
    timer: null,
  };
  try {
    registerPendingLifetime(owner);
  } catch (error) {
    log.warn(`Session change was not admitted: ${formatErrorMessage(error)}`);
    return;
  }
  publication.revision += 1;
  publication.pendingCount += 1;
  owner.pendingCount += 1;
  owner.publications.set(publicationKey, publication);
  owner.pending.set(publicationKey, next);
  pendingSessionChanges.add(next);
  next.timer = setTimeout(() => finishPendingSessionChange(next), SESSIONS_CHANGED_DEBOUNCE_MS);
  next.timer.unref?.();
  startPendingSessionChange(next);
}

export function emitSessionArchived(
  context: SessionChangeContext,
  sessionKey: string | undefined,
  agentId?: string,
): void {
  if (sessionKey) {
    emitSessionsChanged(context, {
      sessionKey,
      ...(agentId ? { agentId } : {}),
      reason: "archive",
    });
  }
}
