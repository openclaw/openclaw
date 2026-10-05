/** Private-local SDK subpath for memory session transcript helpers. */
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
  buildSessionEntry,
  extractKeywords,
  isCronRunSessionKey,
  isDreamingNarrativeSessionStoreKey,
  listSessionTranscriptCorpusEntriesForAgent,
  matchesSessionEntryPrefixHash,
  parseUsageCountedSessionIdFromFileName,
  readTranscriptStatsBatchReadOnlySync,
  readSessionResetRecallCutoff,
  sessionPathForFile,
  sessionPathForSessionIdentity,
  statSessionEntrySync,
} from "../../packages/memory-host-sdk/src/engine-sessions.js";
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

/** @deprecated Use resolveMemorySessionTargetsAsync; removed at the next Plugin SDK major. */
export function resolveMemorySessionTargets(params: MemorySessionSelectors): MemorySessionTarget[] {
  return readMemorySessionTargets(params);
}
