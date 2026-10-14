/** Private-local SDK subpath for memory session transcript helpers. */
import { isMainThread } from "node:worker_threads";
import {
  buildSessionEntry as buildSessionEntryFromHost,
  listSessionTranscriptCorpusEntriesForAgent as listSessionTranscriptCorpusEntriesFromHost,
  readSessionResetRecallCutoff as readSessionResetRecallCutoffFromHost,
} from "../../packages/memory-host-sdk/src/engine-sessions.js";
import { assertBoundIncognitoMemorySyncAccess } from "../../packages/memory-host-sdk/src/host/openclaw-runtime-session.js";
import {
  listSessionTranscriptArchivesReadOnly,
  listSessionTranscriptInstances,
} from "../config/sessions/session-accessor.js";
import { captureSessionActorStorageOwner } from "../config/sessions/session-actor-storage-binding.js";
import { listSessionTranscriptInstancesInWorker } from "../config/sessions/session-history.js";
import {
  projectSessionMetadata,
  readMemorySessionTargets,
} from "../config/sessions/session-memory-targets.js";
import type {
  MemorySessionSelectors,
  MemorySessionTarget,
} from "../config/sessions/session-memory-targets.types.js";
import { resolveMemorySessionTargetsInWorker } from "../config/sessions/session-transcript-inventory-runtime.js";
import { warnPluginSdkDeprecation } from "../plugins/sdk-deprecation.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { getAsyncWorkSignal } from "../shared/async-work-scope.js";

export type {
  MemorySessionSelectors,
  MemorySessionTarget,
} from "../config/sessions/session-memory-targets.types.js";

/** @deprecated Await loadArchivedSessionsAsync. Final compatibility day: 2026-12-31. */
export function loadArchivedSessions(
  params: Parameters<typeof listSessionTranscriptArchivesReadOnly>[0],
) {
  warnPluginSdkDeprecation({
    family: "memory-session-sync-inventory",
    method: "loadArchivedSessions",
    replacement: "loadArchivedSessionsAsync",
  });
  assertBoundIncognitoMemorySyncAccess(params, "loadArchivedSessions", "loadArchivedSessionsAsync");
  return listSessionTranscriptArchivesReadOnly(params);
}
export {
  listSessionTranscriptArchivesInWorker as loadArchivedSessionsAsync,
  resolveMemorySessionTargetsInWorker as resolveMemorySessionTargetsAsync,
} from "../config/sessions/session-transcript-inventory-runtime.js";

export {
  buildSessionEntries,
  extractKeywords,
  isCronRunSessionKey,
  isDreamingNarrativeSessionStoreKey,
  matchesSessionEntryPrefixHash,
  parseUsageCountedSessionIdFromFileName,
  readTranscriptStatsBatchReadOnlyAsync,
  readTranscriptStatsBatchReadOnlySync,
  sessionPathForFile,
  sessionPathForSessionIdentity,
  statSessionEntry,
  statSessionEntrySync,
} from "../../packages/memory-host-sdk/src/engine-sessions.js";

// Internal actor sources are not part of the released plugin call signatures.
export const buildSessionEntry: (
  absPath: string,
  options?: Parameters<typeof buildSessionEntryFromHost>[1],
) => ReturnType<typeof buildSessionEntryFromHost> = buildSessionEntryFromHost;
export const listSessionTranscriptCorpusEntriesForAgent: (
  agentId: string,
  options?: Parameters<typeof listSessionTranscriptCorpusEntriesFromHost>[1],
) => ReturnType<typeof listSessionTranscriptCorpusEntriesFromHost> =
  listSessionTranscriptCorpusEntriesFromHost;
export const readSessionResetRecallCutoff: (
  scope: Parameters<typeof readSessionResetRecallCutoffFromHost>[0],
) => ReturnType<typeof readSessionResetRecallCutoffFromHost> = readSessionResetRecallCutoffFromHost;

export type {
  SessionFileEntry,
  SessionFileState,
  SessionTranscriptCorpusEntry,
} from "../../packages/memory-host-sdk/src/engine-sessions.js";

/** @deprecated Await loadMemorySessionMetadataAsync. Final compatibility day: 2026-12-31. */
export function loadMemorySessionMetadata(params: {
  agentId: string;
  sessionId: string;
  sessionKey?: string;
  storePath?: string;
}): MemorySessionTarget | undefined {
  if (isMainThread) {
    warnPluginSdkDeprecation({
      family: "memory-session",
      method: "loadMemorySessionMetadata",
      replacement: "loadMemorySessionMetadataAsync",
    });
  }
  assertBoundIncognitoMemorySyncAccess(
    params,
    "loadMemorySessionMetadata",
    "loadMemorySessionMetadataAsync",
  );
  const instance = listSessionTranscriptInstances(params, {
    includeAllWindows: true,
    sessionId: params.sessionId,
  }).find(
    (candidate) =>
      candidate.agentId === normalizeAgentId(params.agentId) &&
      (!params.sessionKey || candidate.sessionKey === params.sessionKey),
  );
  return instance ? projectSessionMetadata(instance) : undefined;
}

/** Read the selected transcript's recorded source metadata through its owner. */
export async function loadMemorySessionMetadataAsync(
  params: Parameters<typeof loadMemorySessionMetadata>[0],
): Promise<MemorySessionTarget | undefined> {
  return (await loadMemorySessionMetadataBatchAsync({ ...params, sessions: [params] }))[0];
}

/** One history read resolves the complete ingestion batch. */
export async function loadMemorySessionMetadataBatchAsync(params: {
  agentId: string;
  storePath?: string;
  sessions: readonly { sessionId: string; sessionKey?: string }[];
}): Promise<MemorySessionTarget[]> {
  const selectors = new Map<string, Set<string | undefined>>();
  for (const { sessionId, sessionKey } of params.sessions) {
    const keys = selectors.get(sessionId) ?? new Set<string | undefined>();
    keys.add(sessionKey);
    selectors.set(sessionId, keys);
  }
  if (selectors.size === 0) {
    return [];
  }
  const agentId = normalizeAgentId(params.agentId);
  const scope = { agentId, storePath: params.storePath };
  const sessionIds = [...selectors.keys()];
  const signal = getAsyncWorkSignal();
  const assertCurrent = () => signal?.throwIfAborted();
  const memory = captureSessionActorStorageOwner(scope, {
    assertCurrent,
    authorize: assertCurrent,
  });
  const metadata = memory
    ? (await resolveMemorySessionTargetsInWorker({ ...scope, sessionIds })).filter(
        (entry) => entry.resolution === "live",
      )
    : (
        await listSessionTranscriptInstancesInWorker(
          { ...scope, projection: "list" },
          { includeAllWindows: true, sessionIds },
        )
      ).map((instance) => projectSessionMetadata(instance));
  return metadata.filter(
    (entry) =>
      entry.agentId === agentId &&
      (selectors.get(entry.sessionId)?.has(undefined) ||
        selectors.get(entry.sessionId)?.has(entry.sessionKey)),
  );
}

/** @deprecated Await resolveMemorySessionTargetsAsync. Final compatibility day: 2026-12-31. */
export function resolveMemorySessionTargets(params: MemorySessionSelectors): MemorySessionTarget[] {
  warnPluginSdkDeprecation({
    family: "memory-session-sync-inventory",
    method: "resolveMemorySessionTargets",
    replacement: "resolveMemorySessionTargetsAsync",
  });
  assertBoundIncognitoMemorySyncAccess(
    params,
    "resolveMemorySessionTargets",
    "resolveMemorySessionTargetsAsync",
  );
  return readMemorySessionTargets(params);
}
