import { installSessionActorMemoryEntry } from "./session-actor-memory-entry-install.js";
import type { SessionActorMemoryState } from "./session-actor-memory-state.js";
import type {
  InitialSessionEntryCommit,
  SessionMetadataOperations,
} from "./session-manager-write-contract.js";
import { SessionTranscriptWriterClaimReboundError } from "./session-transcript-writer-claim-error.js";

/** Initialize the captured actor without manufacturing a transcript message. */
export function initializeSessionActorMemoryEntry(
  { state, agentId, path }: { state: SessionActorMemoryState; agentId: string; path: string },
  input: SessionMetadataOperations["session.metadata.initialize"]["input"],
): InitialSessionEntryCommit {
  if (
    input.entry.sessionId !== input.scope.sessionId ||
    (input.scope.agentId !== undefined && input.scope.agentId !== agentId) ||
    (input.scope.sessionKey !== undefined &&
      input.scope.sessionKey !== state.hot.target.sessionKey) ||
    (input.scope.storePath !== undefined && input.scope.storePath !== path)
  ) {
    throw new SessionTranscriptWriterClaimReboundError();
  }
  if (state.hot.entry) {
    if (input.initialWriterRunId !== undefined) {
      throw new SessionTranscriptWriterClaimReboundError();
    }
    return { owned: state.hot.entry.sessionId === input.entry.sessionId };
  }
  if (input.scope.expectedWriterRunId !== undefined && input.initialWriterRunId === undefined) {
    return { owned: false };
  }
  const persisted = installSessionActorMemoryEntry(state, {
    ...structuredClone(input.entry),
    ...(input.initialWriterRunId !== undefined
      ? { activeWriterRunId: input.initialWriterRunId }
      : {}),
  });
  return {
    owned: true,
    ...(input.initialWriterRunId !== undefined
      ? {
          fence: {
            expectedLifecycleRevision: persisted.lifecycleRevision,
            expectedWriterRunId: input.initialWriterRunId,
          },
        }
      : {}),
    identity: {
      previous: new Map(),
      current: new Map([[state.hot.target.sessionKey, structuredClone(persisted)]]),
    },
  };
}
