/** Private-local SDK subpath for memory session transcript helpers. */
import {
  buildSessionEntry as buildSessionEntryFromHost,
  listSessionTranscriptCorpusEntriesForAgent as listSessionTranscriptCorpusEntriesFromHost,
  readSessionResetRecallCutoff as readSessionResetRecallCutoffFromHost,
} from "../../packages/memory-host-sdk/src/engine-sessions.js";
import { listSessionTranscriptInstances } from "../config/sessions/session-accessor.js";
import {
  projectSessionMetadata,
  readMemorySessionTargets,
} from "../config/sessions/session-memory-targets.js";
import type {
  MemorySessionSelectors,
  MemorySessionTarget,
} from "../config/sessions/session-memory-targets.types.js";
import { normalizeAgentId } from "../routing/session-key.js";

export type {
  MemorySessionSelectors,
  MemorySessionTarget,
} from "../config/sessions/session-memory-targets.types.js";

/** @deprecated Use loadArchivedSessionsAsync; removed at the next Plugin SDK major. */
export { listSessionTranscriptArchivesReadOnly as loadArchivedSessions } from "../config/sessions/session-accessor.js";
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

/** Read authoritative admission facts without creating a missing agent database. */
export function loadMemorySessionMetadata(params: {
  agentId: string;
  sessionId: string;
  sessionKey?: string;
  storePath?: string;
}): MemorySessionTarget | undefined {
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

/** Final synchronous admission guard; raw SDK and foreign writers do not publish complete revocation. */
export function loadMemorySessionMetadataBatch(params: {
  agentId: string;
  storePath?: string;
  sessions: readonly { sessionId: string; sessionKey?: string }[];
}): MemorySessionTarget[] {
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

/** @deprecated Use resolveMemorySessionTargetsAsync; removed at the next Plugin SDK major. */
export function resolveMemorySessionTargets(params: MemorySessionSelectors): MemorySessionTarget[] {
  return readMemorySessionTargets(params);
}
