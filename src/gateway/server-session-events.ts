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
import type { InternalSessionTranscriptUpdate } from "../sessions/transcript-events.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  prepareForwardedMessageCronJobNameResolver,
  readPluginSteeringId,
} from "./chat-display-projection.history.js";
import { projectChatDisplayMessage } from "./chat-display-projection.js";
import type { GatewayBroadcastToConnIdsFn } from "./server-broadcast-types.js";
import type {
  SessionEventSubscriberRegistry,
  SessionMessageSubscriberRegistry,
} from "./server-chat-state.js";
import { resolveVisibleActiveSessionRunState } from "./server-methods/session-active-runs.js";
import type { GatewayContextResolver } from "./server-methods/types.js";
import { hasSessionChangeReceivers } from "./session-change-receivers.js";
import { buildGatewaySessionSnapshot } from "./session-event-payload.js";
import {
  readTranscriptUpdateLifecycleOwner,
  withPreparedEventRow,
} from "./session-event-prepared-row.js";
import { prepareSessionEventProjection } from "./session-event-projection.js";
import { createSessionMessageBodyOmission } from "./session-message-body-delivery.js";
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

function hasCompleteTranscriptTarget(update: InternalSessionTranscriptUpdate): boolean {
  return Boolean(
    normalizeOptionalString(update.target?.agentId) &&
    normalizeOptionalString(update.target?.sessionId) &&
    normalizeOptionalString(update.target?.sessionKey) &&
    normalizeOptionalString(update.target?.storePath),
  );
}

/** Creates a serialized broadcaster; false reports a temporary canonical-read failure. */
export function createTranscriptUpdateBroadcastHandler(params: {
  broadcastToConnIds: GatewayBroadcastToConnIdsFn;
  sessionEventSubscribers: SessionEventSubscribers;
  sessionMessageSubscribers: SessionMessageSubscribers;
  getSessionRowProjection?: () => SessionRowProjection | undefined;
  resolveGatewayContext?: GatewayContextResolver;
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
  return (update: InternalSessionTranscriptUpdate): Promise<false | void> => {
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
    // Without an original incarnation, notify history instead of retargeting inline bytes.
    const queuedUpdate =
      projection &&
      legacyMarker &&
      !hasCompleteTranscriptTarget(update) &&
      !markerCaptured &&
      !lifecycleRevision
        ? { ...update, message: undefined }
        : lifecycleRevision
          ? { ...update, lifecycleRevision }
          : update;
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
        return await handleTranscriptUpdateBroadcast(
          params,
          queuedUpdate,
          agentScope,
          projection,
          markerCaptured,
          sessionKey ? undefined : joinQueue,
        );
      } finally {
        keyReady.resolve(undefined);
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
    getSessionRowProjection?: () => SessionRowProjection | undefined;
    resolveGatewayContext?: GatewayContextResolver;
  },
  update: InternalSessionTranscriptUpdate,
  capturedAgentScope: SessionEventAgentScope | undefined,
  projection: SessionRowProjection | undefined,
  markerCaptured: ReturnType<SessionRowProjection["capture"]>,
  joinQueue?: (key: string) => Promise<void>,
): Promise<false | void> {
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
  const markerIsCurrent = () => !markerCaptured || projection?.isCurrent(markerCaptured);
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
  const connIds = new Set(params.sessionEventSubscribers.getAll());
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
      (update.message !== undefined &&
        // This probe checks visibility only; it does not publish sender labels.
        projectChatDisplayMessage(update.message, { resolveCronJobName: () => undefined }))
    ) {
      return;
    }
  }
  const lifecycleRevision = normalizeOptionalString(update.lifecycleRevision);
  const lifecycleIsCurrent = () => {
    if (!lifecycleRevision) {
      return true;
    }
    const current = readTranscriptUpdateLifecycleOwner(update, projection);
    return Boolean(
      current && (!current.lifecycleRevision || current.lifecycleRevision === lifecycleRevision),
    );
  };
  if (!eventAgentId && !compatibilityOwnerAgentId && !parseAgentSessionKey(sessionKey)) {
    if (!lifecycleIsCurrent()) {
      return;
    }
    params.broadcastToConnIds(
      "sessions.changed",
      { sessionKey, phase: "message", ts: Date.now() },
      connIds,
      {
        ...resolvePrivateSessionEventBroadcastScope(sessionKey, agentScope),
        sessionEventSubscriptionKeys: broadcastKeys,
        dropIfSlow: true,
      },
    );
    return;
  }
  let message = update.message;
  let publicationFailed = false;
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
      publicationFailed = true;
    }
  } else if (message !== undefined && messageSeq === undefined) {
    // Updates from raw transcript events may not carry seq; fall back to the
    // current transcript line count for cursor-compatible live history.
    do {
      await projection?.prepareMembership();
    } while (projection?.needsMembershipPreparation());
    const fallbackTarget = projection?.selectEntries({
      agentId: routingAgentId,
      key: sessionKey,
      storePath: publicationStorePath,
    })[0];
    const entry = fallbackTarget?.entry;
    const messageSessionId =
      compatibleLegacyMarker?.sessionId ??
      normalizeOptionalString(update.target?.sessionId) ??
      entry?.sessionId;
    const storePath = publicationStorePath ?? fallbackTarget?.storeTarget.storePath;
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
      publicationFailed = true;
    }
  }
  const resolveCronJobName = await prepareForwardedMessageCronJobNameResolver(
    message === undefined ? [] : [message],
  );
  await withPreparedEventRow(
    projection,
    routingAgentId
      ? { key: sessionKey, agentId: routingAgentId, storePath: publicationStorePath }
      : undefined,
    (read, ancestors) => {
      if (params.getSessionRowProjection?.() !== projection) {
        return;
      }
      if (!markerIsCurrent()) {
        return;
      }
      // A reset can retain sessionId; consume current ownership after awaited reads.
      if (!lifecycleIsCurrent()) {
        return;
      }
      const record = routingAgentId
        ? read?.describe({
            key: sessionKey,
            agentId: routingAgentId,
            storePath: publicationStorePath,
          })
        : undefined;
      const sessionRow = record && read?.present(record);
      const activeRunState =
        record &&
        sessionRow &&
        (sessionRow.key !== "global" || routingAgentId !== undefined || compatibilityOwnerAgentId)
          ? resolveVisibleActiveSessionRunState({
              storePath: record.storeTarget.storePath,
              resolveGatewayContext: params.resolveGatewayContext,
              requestedKey: sessionKey,
              canonicalKey: sessionRow.key,
              sessionId: sessionRow.sessionId,
              ...(routingAgentId ? { agentId: routingAgentId } : {}),
              defaultAgentId: compatibilityOwnerAgentId,
              projectedAgentRunIndex: projection?.state.rowContext.projectedAgentRuns,
              physicalPaths: read?.physicalPaths ?? projection?.physicalPaths,
            })
          : null;
      const sessionSnapshot = buildGatewaySessionSnapshot({
        sessionRow,
        agentId: eventAgentId,
        includeSession: true,
        activeRunState,
      });
      const omitMessage = createSessionMessageBodyOmission(
        broadcastKeys,
        params.sessionMessageSubscribers,
      );
      const broadcastOptions = {
        sessionEventSubscriptionKeys: broadcastKeys,
        prepareSessionProjection:
          read && projection
            ? prepareSessionEventProjection(projection, read, {
                ancestors,
                encodeMessage: true,
                omitMessage,
              })
            : undefined,
      };
      const messageProjectionParams =
        message === undefined
          ? undefined
          : {
              sessionKey,
              ...(eventAgentId ? { agentId: eventAgentId } : {}),
              message,
              resolveCronJobName,
              transcriptPosition,
              ...(typeof update.messageId === "string" ? { messageId: update.messageId } : {}),
              ...(messageSeq !== undefined ? { messageSeq } : {}),
              ...(update.runId ? { runId: update.runId } : {}),
              sessionSnapshot,
            };
      const projected =
        messageProjectionParams && projectSessionMessagePayload(messageProjectionParams);
      // Do not invalidate history for a recoverable attempt: a refetch could
      // publish its durable error row before the owning run settles.
      if (projected?.deferredAssistantError) {
        return;
      }
      const historyReset = message === undefined || projected?.requiresHistoryReset;
      if (!historyReset && projected?.payload) {
        params.broadcastToConnIds("session.message", projected.payload, connIds, broadcastOptions);
        return;
      }
      if (
        !historyReset &&
        !projected?.payload &&
        messageProjectionParams &&
        read &&
        projection &&
        readPluginSteeringId(message)
      ) {
        const controlUiProjection = projectSessionMessagePayload({
          ...messageProjectionParams,
          includePluginSteering: true,
        });
        if (controlUiProjection.payload) {
          params.broadcastToConnIds("session.message", controlUiProjection.payload, connIds, {
            sessionEventSubscriptionKeys: broadcastKeys,
            prepareSessionProjection: prepareSessionEventProjection(projection, read, {
              ancestors,
              encodeMessage: true,
              omitMessage,
              controlUiOnly: true,
            }),
          });
        }
      }

      // Resets invalidate both audiences; hidden messages notify only broad session listeners.
      const recipients = historyReset ? connIds : params.sessionEventSubscribers.getAll();
      if (!historyReset && !hasSessionChangeReceivers(recipients)) {
        return;
      }
      params.broadcastToConnIds(
        "sessions.changed",
        {
          sessionKey,
          ...(eventAgentId ? { agentId: eventAgentId } : {}),
          phase: "message",
          ts: Date.now(),
          ...(!historyReset && typeof update.messageId === "string"
            ? { messageId: update.messageId }
            : {}),
          ...(!historyReset && messageSeq !== undefined ? { messageSeq } : {}),
          ...sessionSnapshot,
        },
        recipients,
        historyReset ? broadcastOptions : { dropIfSlow: true, ...broadcastOptions },
      );
    },
  );
  return publicationFailed ? false : undefined;
}
