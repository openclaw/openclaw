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
import { getSessionActorStorageBinding } from "../config/sessions/session-actor-storage-binding.js";
import { listSessionTranscriptInstancesInWorker } from "../config/sessions/session-history.js";
import { captureIncognitoSessionSource } from "../config/sessions/session-incognito-binding.js";
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

export type {
  MemorySessionSelectors,
  MemorySessionTarget,
} from "../config/sessions/session-memory-targets.types.js";

/** @deprecated Use loadArchivedSessionsAsync; removed at the next Plugin SDK major. */
export function loadArchivedSessions(
  params: Parameters<typeof listSessionTranscriptArchivesReadOnly>[0],
) {
  assertBoundIncognitoMemorySyncAccess(params, "loadArchivedSessions", "loadArchivedSessionsAsync");
  return listSessionTranscriptArchivesReadOnly(params);
}
export {
  listSessionTranscriptArchivesInWorker as loadArchivedSessionsAsync,
  resolveMemorySessionTargetsInWorker as resolveMemorySessionTargetsAsync,
} from "../config/sessions/session-transcript-inventory-runtime.js";

export {
  extractKeywords,
  isCronRunSessionKey,
  isDreamingNarrativeSessionStoreKey,
  matchesSessionEntryPrefixHash,
  parseUsageCountedSessionIdFromFileName,
  readTranscriptStatsBatchReadOnlyAsync,
  readTranscriptStatsBatchReadOnlySync,
  sessionPathForFile,
  sessionPathForSessionIdentity,
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

/** @deprecated Use loadMemorySessionMetadataAsync; removed at the next Plugin SDK major. */
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

/** @deprecated Use loadMemorySessionMetadataBatchAsync; removed at the next Plugin SDK major. */
export function loadMemorySessionMetadataBatch(params: {
  agentId: string;
  storePath?: string;
  sessions: readonly { sessionId: string; sessionKey?: string }[];
}): MemorySessionTarget[] {
  if (isMainThread) {
    warnPluginSdkDeprecation({
      family: "memory-session",
      method: "loadMemorySessionMetadataBatch",
      replacement: "loadMemorySessionMetadataBatchAsync",
    });
  }
  for (const session of params.sessions) {
    assertBoundIncognitoMemorySyncAccess(
      { ...params, ...session },
      "loadMemorySessionMetadataBatch",
      "loadMemorySessionMetadataBatchAsync",
    );
  }
  const selectors = new Map<string, Set<string | undefined>>();
  for (const { sessionId, sessionKey } of params.sessions) {
    const keys = selectors.get(sessionId) ?? new Set<string | undefined>();
    keys.add(sessionKey);
    selectors.set(sessionId, keys);
  }
  const sessionIds = [...selectors.keys()];
  const agentId = normalizeAgentId(params.agentId);
  const metadata: MemorySessionTarget[] = [];
  const batchSize = 128;
  for (let start = 0; start < sessionIds.length; start += batchSize) {
    const instances = listSessionTranscriptInstances(
      { agentId, storePath: params.storePath, projection: "list" },
      { includeAllWindows: true, sessionIds: sessionIds.slice(start, start + batchSize) },
    );
    for (const instance of instances) {
      const keys = selectors.get(instance.sessionId);
      if (
        instance.agentId === agentId &&
        (keys?.has(undefined) || keys?.has(instance.sessionKey))
      ) {
        metadata.push(projectSessionMetadata(instance));
      }
    }
  }
  return metadata;
}

/** Read the selected transcript's recorded source metadata through its owner. */
export async function loadMemorySessionMetadataAsync(
  params: Parameters<typeof loadMemorySessionMetadata>[0],
): Promise<MemorySessionTarget | undefined> {
  return (await loadMemorySessionMetadataBatchAsync({ ...params, sessions: [params] }))[0];
}

/** One history read resolves the complete ingestion batch. */
export async function loadMemorySessionMetadataBatchAsync(
  params: Parameters<typeof loadMemorySessionMetadataBatch>[0],
): Promise<MemorySessionTarget[]> {
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
  const metadata =
    getSessionActorStorageBinding(scope) || captureIncognitoSessionSource(scope)
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

/** @deprecated Use resolveMemorySessionTargetsAsync; removed at the next Plugin SDK major. */
export function resolveMemorySessionTargets(params: MemorySessionSelectors): MemorySessionTarget[] {
  assertBoundIncognitoMemorySyncAccess(
    params,
    "resolveMemorySessionTargets",
    "resolveMemorySessionTargetsAsync",
  );
  return readMemorySessionTargets(params);
}
