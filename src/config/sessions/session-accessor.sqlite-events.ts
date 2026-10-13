import { emitSessionTranscriptUpdate } from "../../sessions/transcript-events.js";
import type {
  SessionLifecycleArchivedTranscript,
  SessionTranscriptWriteScope,
  TranscriptUpdatePayload,
} from "./session-accessor.sqlite-contract.js";
import { resolveSqliteTranscriptScope } from "./session-accessor.sqlite-scope.js";
import { getSessionActorStorageBinding } from "./session-actor-storage-binding.js";
import type { SessionEntryReadSource } from "./session-entry-read-source.types.js";

// Outward notifications happen only after the owning SQLite mutation commits.

export function emitArchivedTranscriptUpdates(
  archivedTranscripts: readonly SessionLifecycleArchivedTranscript[],
): void {
  for (const archived of archivedTranscripts) {
    emitSessionTranscriptUpdate({ sessionFile: archived.archivedPath });
  }
}

export async function publishTranscriptUpdate(
  scope: SessionTranscriptWriteScope,
  update: TranscriptUpdatePayload = {},
  readSource?: SessionEntryReadSource,
): Promise<void> {
  const memory = getSessionActorStorageBinding(scope);
  const resolved = memory
    ? {
        agentId: memory.agentId,
        path: memory.path,
        sessionKey: memory.actor.target.sessionKey,
        sessionId: scope.sessionId ?? memory.actor.snapshot(memory.authority)?.entry?.sessionId,
      }
    : resolveSqliteTranscriptScope(scope, readSource);
  if (!resolved.sessionId) {
    throw new Error("Transcript publication requires its selected session window");
  }
  memory?.actor.assertReadable();
  memory?.authority.assertCurrent();
  emitSessionTranscriptUpdate({
    ...update,
    agentId: resolved.agentId,
    sessionKey: resolved.sessionKey,
    sessionId: resolved.sessionId,
    target: {
      agentId: resolved.agentId,
      sessionId: resolved.sessionId,
      sessionKey: resolved.sessionKey,
      storePath: resolved.path,
    },
  });
}
