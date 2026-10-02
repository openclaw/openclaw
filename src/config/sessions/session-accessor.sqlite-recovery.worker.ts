import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db-contract.js";
import type { SessionEntryReplacementPublication } from "./session-accessor.sqlite-entry-cache.js";
import {
  normalizeLifecycleTarget,
  readSessionIdentitySnapshot,
  resolveLifecyclePrimaryEntry,
  writeSessionEntry,
} from "./session-accessor.sqlite-entry-store.js";
import { loadTranscriptEventsFromDatabase } from "./session-accessor.sqlite-read.js";
import type {
  RestartTombstoneRecoveryInput,
  RestartTombstoneRecoveryResult,
} from "./session-accessor.sqlite-recovery.types.js";
import { prepareSessionEntryReplacementPublication } from "./session-accessor.sqlite-replacement-state.js";
import { formatLegacySqliteSessionMarkerForScope } from "./session-accessor.sqlite-scope.js";
import { appendTranscriptEventsInTransaction } from "./session-accessor.sqlite-transcript-store.js";
import { findSessionTranscriptHeader } from "./session-entry-codec.js";
import { normalizeStoreSessionKey } from "./store-entry.js";
import { createSessionTranscriptHeader } from "./transcript-header.js";
import type { InternalSessionEntry } from "./types.js";
import { MIN_READABLE_SESSION_VERSION } from "./version.js";

/** The worker transaction owns the complete clone and both revisioned entry writes. */
export function recoverRestartTombstoneInDatabase(
  database: OpenClawAgentDatabase,
  params: RestartTombstoneRecoveryInput,
): { result: RestartTombstoneRecoveryResult; publication?: SessionEntryReplacementPublication } {
  const resolved = { agentId: params.agentId, path: database.path };
  const sourceTarget = normalizeLifecycleTarget(params.sourceTarget);
  const successorTarget = normalizeLifecycleTarget(params.successorTarget);
  // SAFETY: Canonical lifecycle rows retain internal recovery metadata through the entry codec.
  const source = resolveLifecyclePrimaryEntry(database, sourceTarget)?.entry as
    | InternalSessionEntry
    | undefined;
  const recovery = source?.mainRestartRecovery;
  const tombstone = recovery?.tombstone;
  if (!source?.sessionId || !recovery || !tombstone) {
    return { result: { status: "conflict", reason: "not-tombstoned" } };
  }

  if (
    source.sessionId !== params.expected.sessionId ||
    source.lifecycleRevision !== params.expected.lifecycleRevision ||
    recovery.cycleId !== params.expected.cycleId ||
    source.pluginOwnerId !== params.expected.pluginOwnerId
  ) {
    return { result: { status: "conflict", reason: "source-changed" } };
  }

  const recoveredSessionKey = tombstone.recoveredSessionKey;
  const recoveredSessionId = tombstone.recoveredSessionId;
  if (recoveredSessionKey || recoveredSessionId) {
    if (!recoveredSessionKey || !recoveredSessionId) {
      return { result: { status: "conflict", reason: "successor-missing" } };
    }
    const linked = resolveLifecyclePrimaryEntry(
      database,
      normalizeLifecycleTarget({
        canonicalKey: recoveredSessionKey,
        storeKeys: [recoveredSessionKey],
      }),
    )?.entry;
    if (!linked || linked.sessionId !== recoveredSessionId) {
      return { result: { status: "conflict", reason: "successor-missing" } };
    }
    return {
      result: {
        status: "existing",
        sourceEntry: structuredClone(source),
        successorEntry: structuredClone(linked),
        successorKey: recoveredSessionKey,
      },
    };
  }

  if (recovery.revision !== params.expected.revision) {
    return { result: { status: "conflict", reason: "source-changed" } };
  }
  if (resolveLifecyclePrimaryEntry(database, successorTarget)?.entry) {
    return { result: { status: "conflict", reason: "target-exists" } };
  }

  const sourceEvents = loadTranscriptEventsFromDatabase(database, source.sessionId);
  const header = findSessionTranscriptHeader(sourceEvents);
  if (!header) {
    return { result: { status: "conflict", reason: "transcript-missing" } };
  }

  const successorSessionId = params.successorEntry.sessionId;
  const parentSession = formatLegacySqliteSessionMarkerForScope({
    ...resolved,
    sessionId: source.sessionId,
    sessionKey: normalizeStoreSessionKey(sourceTarget.canonicalKey),
  });
  appendTranscriptEventsInTransaction(
    database,
    {
      ...resolved,
      sessionId: successorSessionId,
      sessionKey: normalizeStoreSessionKey(successorTarget.canonicalKey),
    },
    [
      {
        ...createSessionTranscriptHeader({
          cwd: typeof header.cwd === "string" ? header.cwd : undefined,
          sessionId: successorSessionId,
          version: header.version ?? MIN_READABLE_SESSION_VERSION,
        }),
        parentSession,
      },
      ...sourceEvents.filter((event) => !(isRecord(event) && event.type === "session")),
    ],
  );

  const now = Date.now();
  const nextSource: InternalSessionEntry = {
    ...source,
    mainRestartRecovery: {
      ...recovery,
      revision: recovery.revision + 1,
      tombstone: {
        ...tombstone,
        recoveredSessionId: successorSessionId,
        recoveredSessionKey: successorTarget.canonicalKey,
      },
    },
    archivedAt: source.archivedAt ?? now,
    ...(source.archiveReason
      ? { archiveReason: source.archiveReason }
      : source.archivedAt === undefined
        ? { archiveReason: "restart-recovery" as const }
        : {}),
    ...(source.archivedBy === undefined && params.archivedBy
      ? { archivedBy: params.archivedBy }
      : {}),
    updatedAt: Math.max(now, (source.updatedAt ?? 0) + 1),
  };
  delete nextSource.pinnedAt;

  const identityKeys = [sourceTarget.canonicalKey, successorTarget.canonicalKey];
  const previousIdentity = readSessionIdentitySnapshot(database, identityKeys);
  writeSessionEntry(database, successorTarget.canonicalKey, params.successorEntry);
  writeSessionEntry(database, sourceTarget.canonicalKey, nextSource, {
    previousEntry: source,
  });
  const currentIdentity = readSessionIdentitySnapshot(database, identityKeys);
  const result: RestartTombstoneRecoveryResult = {
    status: "created",
    sourceEntry: structuredClone(nextSource),
    successorEntry: structuredClone(params.successorEntry),
    successorKey: successorTarget.canonicalKey,
  };
  return {
    result,
    publication: prepareSessionEntryReplacementPublication(
      {
        pendingArchiveRecovery: false,
        previous: previousIdentity,
        current: currentIdentity,
        maintenancePlans: [],
        membershipInvalidatedKeys: [],
      },
      database,
    ),
  };
}
