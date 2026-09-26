// Gateway session event broadcaster.
// Projects transcript and lifecycle updates to websocket subscribers.
import path from "node:path";
import { asPositiveSafeInteger } from "@openclaw/normalization-core/number-coercion";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  readTranscriptDisplayPosition,
  type TranscriptDisplayPosition,
} from "../chat/transcript-display-position.js";
import { getRuntimeConfig } from "../config/io.js";
import { parseSqliteSessionFileMarker } from "../config/sessions/legacy-sqlite-marker.js";
import { isSessionTranscriptProjectionUnavailableError } from "../config/sessions/session-transcript-projection-error.js";
import { WorkerTaskError } from "../infra/worker-task-pool.js";
import { normalizeAgentId, parseAgentSessionKey } from "../routing/session-key.js";
import type { SessionLifecycleEvent } from "../sessions/session-lifecycle-events.js";
import type { InternalSessionTranscriptUpdate } from "../sessions/transcript-events.js";
import { createDeferredCore } from "../shared/deferred.js";
import type { ChatAbortControllerEntry } from "./chat-abort.js";
import { projectChatDisplayMessage } from "./chat-display-projection.js";
import type { GatewayBroadcastToConnIdsFn } from "./server-broadcast-types.js";
import type {
  SessionEventSubscriberRegistry,
  SessionMessageSubscriberRegistry,
} from "./server-chat.js";
import { resolveVisibleActiveSessionRunState } from "./server-methods/session-active-runs.js";
import { hasSessionChangeReceivers } from "./session-change-receivers.js";
import { buildGatewaySessionSnapshot } from "./session-event-payload.js";
import { sessionEventPublicationRows } from "./session-event-prepared-row.js";
import {
  resolvePrivateSessionEventBroadcastScope,
  resolveSessionEventAgentScope,
  type SessionEventAgentScope,
} from "./session-request-agent.js";
import type { SessionRowProjection } from "./session-row-projection.js";
import {
  resolveSessionSubscriptionKey,
  resolveSessionSubscriptionKeys,
} from "./session-subscription-keys.js";
import { projectSessionMessagePayload } from "./session-transcript-message.js";
import {
  readSessionMessageByIdAsync,
  readSessionMessageCountAsync,
} from "./session-transcript-readers.js";

type SessionEventSubscribers = Pick<SessionEventSubscriberRegistry, "getAll">;
type SessionMessageSubscribers = Pick<SessionMessageSubscriberRegistry, "get">;
type GenerationObservation = ReturnType<SessionRowProjection["observeGeneration"]>;

function hasCompleteTranscriptTarget(update: InternalSessionTranscriptUpdate): boolean {
  return Boolean(
    normalizeOptionalString(update.target?.agentId) &&
    normalizeOptionalString(update.target?.sessionId) &&
    normalizeOptionalString(update.target?.sessionKey) &&
    normalizeOptionalString(update.target?.storePath),
  );
}

async function withPreparedEventRow(
  projection: SessionRowProjection | undefined,
  query: { key: string; agentId: string; storePath?: string } | undefined,
  publish: () => void,
) {
  if (!projection || !query) {
    publish();
    return;
  }
  await sessionEventPublicationRows(projection).withReadyRows(() => [query], publish, {
    includeAncestors: true,
  });
}

function readTranscriptUpdateLifecycleOwner(
  update: InternalSessionTranscriptUpdate,
  projection: SessionRowProjection | undefined,
): { sessionId: string; lifecycleRevision?: string } | undefined {
  const marker = parseSqliteSessionFileMarker(update.sessionFile);
  const sessionKey =
    normalizeOptionalString(update.target?.sessionKey) ??
    normalizeOptionalString(update.sessionKey) ??
    (marker ? projection?.findBySessionId(marker)[0]?.key : undefined);
  if (!sessionKey) {
    return undefined;
  }
  const agentId =
    normalizeOptionalString(update.target?.agentId) ??
    normalizeOptionalString(update.agentId) ??
    marker?.agentId;
  const sessionId =
    normalizeOptionalString(update.target?.sessionId) ??
    normalizeOptionalString(update.sessionId) ??
    marker?.sessionId;
  const storePath = normalizeOptionalString(update.target?.storePath) ?? marker?.storePath;
  const ownerAgentId =
    agentId ?? resolveSessionEventAgentScope(getRuntimeConfig(), sessionKey)?.[1];
  const entry = ownerAgentId
    ? projection?.capture({ agentId: ownerAgentId, key: sessionKey, storePath })?.entry
    : undefined;
  if (!entry || (sessionId && entry.sessionId !== sessionId)) {
    return undefined;
  }
  const lifecycleRevision = normalizeOptionalString(entry.lifecycleRevision);
  return { sessionId: entry.sessionId, ...(lifecycleRevision ? { lifecycleRevision } : {}) };
}

/** Creates a serialized transcript-update broadcaster for session websocket clients. */
export function createTranscriptUpdateBroadcastHandler(params: {
  broadcastToConnIds: GatewayBroadcastToConnIdsFn;
  sessionEventSubscribers: SessionEventSubscribers;
  sessionMessageSubscribers: SessionMessageSubscribers;
  chatAbortControllers: Map<string, ChatAbortControllerEntry>;
  getSessionRowProjection?: () => SessionRowProjection | undefined;
}) {
  // Ordering is a per-transcript contract: subscribers merge each session's
  // updates independently, so lanes keyed by transcript identity keep message
  // order without one session's async seq reads stalling every other session.
  const broadcastQueues = new Map<
    string,
    {
      key: string | undefined;
      agentId: string | undefined;
      sessionId: string | undefined;
      storePath: string | undefined;
      keyReady: Promise<string | undefined>;
      settled: Promise<void>;
    }
  >();
  const unresolvedQueueKeys = new Set<string>();
  return (update: InternalSessionTranscriptUpdate): Promise<void> => {
    const projection = params.getSessionRowProjection?.();
    // Capture legacy ownership before the async queue can cross a same-id reset;
    // committed producer ownership always wins over a later session-store read.
    const suppliedRevision = normalizeOptionalString(update.lifecycleRevision);
    const lifecycleOwner =
      !suppliedRevision && update.message !== undefined
        ? readTranscriptUpdateLifecycleOwner(update, projection)
        : undefined;
    const lifecycleRevision =
      suppliedRevision ??
      (update.message !== undefined ? lifecycleOwner?.lifecycleRevision : undefined);
    const queuedUpdate = lifecycleRevision ? { ...update, lifecycleRevision } : update;
    const legacyMarker = parseSqliteSessionFileMarker(update.sessionFile);
    const markerCaptured =
      legacyMarker && !hasCompleteTranscriptTarget(update)
        ? projection?.findBySessionId(legacyMarker)[0]
        : undefined;
    const sessionKey =
      normalizeOptionalString(update.target?.sessionKey) ??
      normalizeOptionalString(update.sessionKey) ??
      markerCaptured?.key;
    const agentId =
      normalizeOptionalString(update.target?.agentId) ??
      normalizeOptionalString(update.agentId) ??
      legacyMarker?.agentId;
    const agentScope = sessionKey
      ? resolveSessionEventAgentScope(getRuntimeConfig(), sessionKey, agentId)
      : undefined;
    if (agentScope === null) {
      return Promise.resolve();
    }
    const markerObservation =
      projection && legacyMarker && !hasCompleteTranscriptTarget(update) && !markerCaptured
        ? projection.observeGeneration(legacyMarker)
        : undefined;
    // Raw global is per-agent storage identity; its qualified aliases must share a lane.
    const laneKey =
      sessionKey && agentScope?.[1]
        ? resolveSessionSubscriptionKey(sessionKey, agentScope[1])
        : (sessionKey ?? normalizeOptionalString(update.sessionFile) ?? "");
    const queueKey = `${sessionKey ? "key" : "file"}:${laneKey}`;
    const tail = broadcastQueues.get(queueKey);
    // Unresolved legacy updates dispatch through the marker's logical owner.
    const queueAgentId =
      agentScope?.[1] ??
      (legacyMarker
        ? normalizeAgentId(legacyMarker.agentId)
        : agentId
          ? normalizeAgentId(agentId)
          : undefined);
    // Capture only earlier lane tails: resolving a marker must never wait on its successors.
    const earlier = sessionKey
      ? [
          ...(tail ? [tail] : []),
          ...[...unresolvedQueueKeys].flatMap((key) => broadcastQueues.get(key) ?? []),
        ]
      : broadcastQueues.values();
    const predecessors = [...new Set(earlier)].filter((queue) => {
      if (queue === tail) {
        return true;
      }
      if (queue.key !== undefined) {
        return !sessionKey || queue.key === laneKey;
      }
      // Different IDs prove distinct keys only inside the marker's original physical store.
      const current =
        sessionKey &&
        projection &&
        queue.agentId &&
        queue.storePath &&
        !projection.needsMembershipPreparation() &&
        (parseAgentSessionKey(laneKey) || laneKey === "global" || laneKey === "unknown")
          ? projection.sharingTarget({
              agentId: queue.agentId,
              key: sessionKey,
              storePath: queue.storePath,
            })
          : undefined;
      return (
        (!queue.agentId || !queueAgentId || queue.agentId === queueAgentId) &&
        (!current || !queue.sessionId || queue.sessionId === current.entry.sessionId)
      );
    });
    const keyReady = createDeferredCore<string | undefined>();
    let resolvedKey = sessionKey ? laneKey : undefined;
    if (resolvedKey !== undefined) {
      keyReady.resolve(resolvedKey);
    }
    const joinQueue = async (key: string): Promise<void> => {
      resolvedKey = key;
      keyReady.resolve(key);
      const canonicalQueueKey = `key:${key}`;
      const canonicalTail = broadcastQueues.get(canonicalQueueKey);
      // A newer keyed tail already depends on this marker; never replace that successor.
      if (!canonicalTail || predecessors.includes(canonicalTail)) {
        broadcastQueues.set(canonicalQueueKey, reservation);
      }
      if (broadcastQueues.get(queueKey) === reservation) {
        unresolvedQueueKeys.delete(queueKey);
      }
      await Promise.all(
        predecessors.splice(0).map(async (queue) => {
          if (queue === tail || (queue.key ?? (await queue.keyReady)) === key) {
            await queue.settled;
          }
        }),
      );
    };
    const task = (tail?.settled ?? Promise.resolve()).then(async () => {
      try {
        if (sessionKey) {
          await joinQueue(laneKey);
        }
        await handleTranscriptUpdateBroadcast(
          params,
          queuedUpdate,
          agentScope,
          projection,
          markerCaptured,
          markerObservation,
          sessionKey ? undefined : joinQueue,
        );
      } finally {
        keyReady.resolve(undefined);
        markerObservation?.dispose();
      }
    });
    const settled = task.then(
      () => undefined,
      () => undefined,
    );
    const reservation = {
      get key() {
        return resolvedKey;
      },
      agentId: queueAgentId,
      sessionId: legacyMarker?.sessionId,
      storePath: legacyMarker?.storePath,
      keyReady: keyReady.promise,
      settled,
    };
    broadcastQueues.set(queueKey, reservation);
    if (!sessionKey) {
      unresolvedQueueKeys.add(queueKey);
    }
    void settled.then(() => {
      // Drop drained lanes so idle sessions do not accumulate map entries.
      for (const key of new Set([queueKey, `key:${resolvedKey}`])) {
        if (broadcastQueues.get(key) === reservation) {
          broadcastQueues.delete(key);
          unresolvedQueueKeys.delete(key);
        }
      }
    });
    return task;
  };
}

async function handleTranscriptUpdateBroadcast(
  params: {
    broadcastToConnIds: GatewayBroadcastToConnIdsFn;
    sessionEventSubscribers: SessionEventSubscribers;
    sessionMessageSubscribers: SessionMessageSubscribers;
    chatAbortControllers: Map<string, ChatAbortControllerEntry>;
    getSessionRowProjection?: () => SessionRowProjection | undefined;
  },
  update: InternalSessionTranscriptUpdate,
  capturedAgentScope: SessionEventAgentScope | undefined,
  projection: SessionRowProjection | undefined,
  markerCaptured: ReturnType<SessionRowProjection["capture"]>,
  markerObservation: GenerationObservation | undefined,
  joinQueue?: (key: string) => Promise<void>,
): Promise<void> {
  const legacyMarker = parseSqliteSessionFileMarker(update.sessionFile);
  const targetAgentId = normalizeOptionalString(update.target?.agentId);
  const targetSessionId = normalizeOptionalString(update.target?.sessionId);
  const targetSessionKey = normalizeOptionalString(update.target?.sessionKey);
  const suppliedSessionKey = normalizeOptionalString(update.sessionKey);
  const candidateSessionKey = targetSessionKey ?? suppliedSessionKey;
  const targetKeyAgentId = parseAgentSessionKey(candidateSessionKey)?.agentId;
  const targetStorePath = normalizeOptionalString(update.target?.storePath);
  const completeTarget = hasCompleteTranscriptTarget(update);
  if (legacyMarker && !completeTarget && projection) {
    do {
      await projection.prepareMembership();
    } while (projection.needsMembershipPreparation());
    if (params.getSessionRowProjection?.() !== projection) {
      return;
    }
  }
  const markerMatches =
    legacyMarker && !completeTarget ? (projection?.findBySessionId(legacyMarker) ?? []) : [];
  const candidateKeyEntry =
    candidateSessionKey && legacyMarker && !completeTarget
      ? projection?.capture({
          agentId: legacyMarker.agentId,
          key: candidateSessionKey,
          storePath: legacyMarker.storePath,
        })?.entry
      : undefined;
  if (targetKeyAgentId && targetAgentId && targetKeyAgentId !== targetAgentId) {
    return;
  }
  if (
    legacyMarker &&
    !completeTarget &&
    ((targetAgentId && targetAgentId !== legacyMarker.agentId) ||
      (targetSessionId &&
        targetSessionId !== legacyMarker.sessionId &&
        candidateKeyEntry?.sessionId !== legacyMarker.sessionId) ||
      (targetKeyAgentId && targetKeyAgentId !== legacyMarker.agentId) ||
      (candidateSessionKey &&
        ((candidateKeyEntry && candidateKeyEntry.sessionId !== legacyMarker.sessionId) ||
          (!candidateKeyEntry && markerMatches.length > 0))) ||
      (targetStorePath && path.resolve(targetStorePath) !== path.resolve(legacyMarker.storePath)))
  ) {
    return;
  }
  const compatibleLegacyMarker = completeTarget ? undefined : legacyMarker;
  const sessionKey = compatibleLegacyMarker
    ? candidateKeyEntry?.sessionId === compatibleLegacyMarker.sessionId ||
      (!candidateKeyEntry && markerMatches.length === 0)
      ? candidateSessionKey
      : markerMatches[0]?.key
    : candidateSessionKey;
  if (!sessionKey) {
    return;
  }
  const publicationStorePath = targetStorePath ?? compatibleLegacyMarker?.storePath;
  const markerOwner = compatibleLegacyMarker
    ? projection?.capture({
        agentId: compatibleLegacyMarker.agentId,
        key: sessionKey,
        storePath: compatibleLegacyMarker.storePath,
      })
    : undefined;
  const markerIsCurrent = () =>
    (!markerCaptured || projection?.isCurrent(markerCaptured)) &&
    (!markerObservation || (markerOwner && markerObservation.isCurrent(markerOwner)));
  if (!markerIsCurrent()) {
    return;
  }
  const agentScope =
    capturedAgentScope ??
    resolveSessionEventAgentScope(
      getRuntimeConfig(),
      sessionKey,
      compatibleLegacyMarker?.agentId ?? targetAgentId ?? update.agentId,
    );
  if (!agentScope) {
    return;
  }
  if (joinQueue) {
    await joinQueue(
      agentScope[1] ? resolveSessionSubscriptionKey(sessionKey, agentScope[1]) : sessionKey,
    );
    if (params.getSessionRowProjection?.() !== projection || !markerIsCurrent()) {
      return;
    }
  }
  const [eventAgentId, routingAgentId, compatibilityOwnerAgentId] = agentScope;
  const privateBroadcastScope = resolvePrivateSessionEventBroadcastScope(sessionKey, agentScope);
  const connIds = new Set<string>();
  for (const connId of params.sessionEventSubscribers.getAll()) {
    connIds.add(connId);
  }
  const broadcastKeys = routingAgentId
    ? resolveSessionSubscriptionKeys(sessionKey, routingAgentId, compatibilityOwnerAgentId)
    : [sessionKey];
  for (const broadcastKey of broadcastKeys) {
    for (const connId of params.sessionMessageSubscribers.get(broadcastKey)) {
      connIds.add(connId);
    }
  }
  if (connIds.size === 0) {
    if (
      !hasSessionChangeReceivers(connIds) ||
      (update.message !== undefined && projectChatDisplayMessage(update.message))
    ) {
      return;
    }
  }
  const lifecycleRevision =
    normalizeOptionalString(update.lifecycleRevision) ??
    (markerObservation
      ? normalizeOptionalString(markerOwner?.entry?.lifecycleRevision)
      : undefined);
  if (!eventAgentId && !compatibilityOwnerAgentId && !parseAgentSessionKey(sessionKey)) {
    if (lifecycleRevision) {
      const currentLifecycleOwner = readTranscriptUpdateLifecycleOwner(update, projection);
      if (
        !currentLifecycleOwner ||
        (currentLifecycleOwner.lifecycleRevision &&
          currentLifecycleOwner.lifecycleRevision !== lifecycleRevision)
      ) {
        return;
      }
    }
    params.broadcastToConnIds(
      "sessions.changed",
      { sessionKey, phase: "message", ts: Date.now() },
      connIds,
      {
        ...privateBroadcastScope,
        dropIfSlow: true,
      },
    );
    return;
  }
  let message = update.message;
  let messageSeq = asPositiveSafeInteger(update.messageSeq);
  let transcriptPosition: TranscriptDisplayPosition | undefined;
  if (message !== undefined && update.messageId && completeTarget && targetSessionId) {
    // A queued append can cross a rewrite. Read content and placement together;
    // never attach a new generation to the producer's stale queued payload.
    try {
      const stored = await readSessionMessageByIdAsync(
        {
          agentId: targetAgentId,
          sessionId: targetSessionId,
          sessionKey,
          storePath: targetStorePath,
        },
        update.messageId,
      );
      message = stored.message;
      messageSeq = stored.seq;
      transcriptPosition = readTranscriptDisplayPosition(
        asOptionalRecord(asOptionalRecord(message)?.["__openclaw"])?.transcriptPosition,
      );
    } catch (error) {
      if (
        !isSessionTranscriptProjectionUnavailableError(error) &&
        !(error instanceof WorkerTaskError && error.code === "overloaded")
      ) {
        throw error;
      }
      message = undefined;
    }
  } else if (message !== undefined && messageSeq === undefined) {
    // Updates from raw transcript events may not carry seq; fall back to the
    // current transcript line count for cursor-compatible live history.
    const updateStorePath = publicationStorePath;
    do {
      await projection?.prepareMembership();
    } while (projection?.needsMembershipPreparation());
    const fallbackTarget = projection?.selectEntries({
      agentId: routingAgentId,
      key: sessionKey,
      storePath: updateStorePath,
    })[0];
    const entry = fallbackTarget?.entry;
    const messageSessionId =
      compatibleLegacyMarker?.sessionId ??
      normalizeOptionalString(update.target?.sessionId) ??
      entry?.sessionId;
    const storePath = updateStorePath ?? fallbackTarget?.storeTarget.storePath;
    try {
      messageSeq = messageSessionId
        ? asPositiveSafeInteger(
            await readSessionMessageCountAsync({
              agentId: update.target?.agentId ?? routingAgentId,
              sessionEntry: entry,
              sessionId: messageSessionId,
              sessionKey,
              storePath,
            }),
          )
        : undefined;
    } catch (error) {
      if (!(error instanceof WorkerTaskError && error.code === "overloaded")) {
        throw error;
      }
      message = undefined;
    }
  }
  await withPreparedEventRow(
    projection,
    routingAgentId
      ? { key: sessionKey, agentId: routingAgentId, storePath: publicationStorePath }
      : undefined,
    () => {
      if (params.getSessionRowProjection?.() !== projection) {
        return;
      }
      if (!markerIsCurrent()) {
        return;
      }
      if (lifecycleRevision) {
        // A reset can retain sessionId, so validate the captured owner after every
        // awaited transcript read before projecting the current session snapshot.
        const currentLifecycleOwner = readTranscriptUpdateLifecycleOwner(update, projection);
        if (
          !currentLifecycleOwner ||
          (currentLifecycleOwner.lifecycleRevision &&
            currentLifecycleOwner.lifecycleRevision !== lifecycleRevision)
        ) {
          return;
        }
      }
      const sessionRow = routingAgentId
        ? projection?.snapshot({
            key: sessionKey,
            agentId: routingAgentId,
            storePath: publicationStorePath,
          }).row
        : null;
      const activeRunState =
        sessionRow &&
        (sessionRow.key !== "global" || routingAgentId !== undefined || compatibilityOwnerAgentId)
          ? resolveVisibleActiveSessionRunState({
              context: params,
              requestedKey: sessionKey,
              canonicalKey: sessionRow.key,
              sessionId: sessionRow.sessionId,
              ...(routingAgentId ? { agentId: routingAgentId } : {}),
              defaultAgentId: compatibilityOwnerAgentId,
              projectedAgentRunIndex: projection?.state.rowContext.projectedAgentRuns,
            })
          : null;
      const sessionSnapshot = buildGatewaySessionSnapshot({
        sessionRow,
        agentId: eventAgentId,
        includeSession: true,
        activeRunState,
      });
      if (message === undefined) {
        // A committed batch or unavailable selected row must invalidate
        // both session-list and targeted transcript subscribers exactly once.
        params.broadcastToConnIds(
          "sessions.changed",
          {
            sessionKey,
            ...(eventAgentId ? { agentId: eventAgentId } : {}),
            phase: "message",
            ts: Date.now(),
            ...sessionSnapshot,
          },
          connIds,
        );
        return;
      }
      const projected = projectSessionMessagePayload({
        sessionKey,
        ...(eventAgentId ? { agentId: eventAgentId } : {}),
        message,
        transcriptPosition,
        ...(typeof update.messageId === "string" ? { messageId: update.messageId } : {}),
        ...(messageSeq !== undefined ? { messageSeq } : {}),
        ...(update.runId ? { runId: update.runId } : {}),
        sessionSnapshot,
      });
      if (projected.payload) {
        params.broadcastToConnIds("session.message", projected.payload, connIds);
        return;
      }

      // Messages suppressed from display can still change transcript state, so
      // notify broad session listeners even when no session.message is emitted.
      const sessionEventConnIds = params.sessionEventSubscribers.getAll();
      if (!hasSessionChangeReceivers(sessionEventConnIds)) {
        return;
      }
      params.broadcastToConnIds(
        "sessions.changed",
        {
          sessionKey,
          ...(eventAgentId ? { agentId: eventAgentId } : {}),
          phase: "message",
          ts: Date.now(),
          ...(typeof update.messageId === "string" ? { messageId: update.messageId } : {}),
          ...(messageSeq !== undefined ? { messageSeq } : {}),
          ...sessionSnapshot,
        },
        sessionEventConnIds,
        { dropIfSlow: true },
      );
    },
  );
}

/** Creates a lifecycle-event broadcaster for session list refreshes. */
export function createLifecycleEventBroadcastHandler(params: {
  broadcastToConnIds: GatewayBroadcastToConnIdsFn;
  sessionEventSubscribers: SessionEventSubscribers;
  chatAbortControllers: Map<string, ChatAbortControllerEntry>;
  getSessionRowProjection?: () => SessionRowProjection | undefined;
}) {
  return async (event: SessionLifecycleEvent): Promise<void> => {
    const connIds = params.sessionEventSubscribers.getAll();
    if (!hasSessionChangeReceivers(connIds)) {
      return;
    }
    const agentScope = resolveSessionEventAgentScope(
      getRuntimeConfig(),
      event.sessionKey,
      normalizeOptionalString(event.agentId),
      true,
    );
    if (!agentScope) {
      return;
    }
    const [eventAgentId, routingAgentId, compatibilityOwnerAgentId] = agentScope;
    const privateBroadcastScope = resolvePrivateSessionEventBroadcastScope(
      event.sessionKey,
      agentScope,
    );
    const broadcastOptions = { ...privateBroadcastScope, dropIfSlow: true };
    // Key-only lifecycle deletes invalidate membership; a later row is not deletion evidence.
    if (
      event.reason === "delete" ||
      !routingAgentId ||
      (!eventAgentId && !compatibilityOwnerAgentId)
    ) {
      params.broadcastToConnIds(
        "sessions.changed",
        {
          sessionKey: event.sessionKey,
          ...(eventAgentId ? { agentId: eventAgentId } : {}),
          reason: event.reason,
          ...(event.catalogChanged ? { catalogChanged: true } : {}),
          ts: Date.now(),
        },
        connIds,
        broadcastOptions,
      );
      return;
    }
    const projection = params.getSessionRowProjection?.();
    const query = { key: event.sessionKey, agentId: routingAgentId };
    const captured = projection?.capture(query);
    const readActiveState = (session: { key: string; sessionId?: string }) =>
      resolveVisibleActiveSessionRunState({
        context: params,
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
      event.reason === "run-capacity"
        ? readActiveState({
            key: captured?.key ?? event.sessionKey,
            sessionId: captured?.entry?.sessionId,
          })
        : undefined;
    const observation = !captured ? projection?.observeGeneration(query) : undefined;
    try {
      await withPreparedEventRow(projection, query, () => {
        const current = captured ?? projection?.capture(query);
        if (
          params.getSessionRowProjection?.() !== projection ||
          (projection && (!current || !projection.isCurrent(current))) ||
          (observation && (!current || !observation.isCurrent(current)))
        ) {
          return;
        }
        const sessionRow = projection?.snapshot(query).row;
        const activeRunState = capacityState ?? (sessionRow ? readActiveState(sessionRow) : null);
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
          { dropIfSlow: true },
        );
      });
    } finally {
      observation?.dispose();
    }
  };
}
