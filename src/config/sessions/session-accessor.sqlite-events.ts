import { emitSessionTranscriptUpdate } from "../../sessions/transcript-events.js";
import { IncognitoSessionMissingError } from "../../state/incognito-session-error.js";
import type {
  SessionLifecycleArchivedTranscript,
  SessionTranscriptWriteScope,
  TranscriptUpdatePayload,
} from "./session-accessor.sqlite-contract.js";
import { resolveSqliteTranscriptScope } from "./session-accessor.sqlite-scope.js";
import {
  captureSessionActorStorageOwner,
  getSessionActorStorageBinding,
  withSessionActorStorage,
} from "./session-actor-storage-binding.js";
import type { SessionEntryReadSource } from "./session-entry-read-source.types.js";
import { captureOwnedTranscriptWriteAssertion } from "./transcript-write-context.js";

// Outward notifications happen only after the owning mutation commits.

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
  const target = readSource
    ? { ...scope, agentId: readSource.agentId, storePath: readSource.path }
    : scope;
  const memory = getSessionActorStorageBinding(target);
  if (!memory) {
    const assertCurrent = captureOwnedTranscriptWriteAssertion(target);
    const authority = { assertCurrent, authorize: assertCurrent };
    if (captureSessionActorStorageOwner(target, authority)) {
      const published = await withSessionActorStorage(
        target,
        { authority, lifetime: { assertCurrent, assertReadable: assertCurrent } },
        async () => {
          await publishTranscriptUpdate(target, update);
          return true;
        },
      );
      if (!published) {
        throw new IncognitoSessionMissingError();
      }
      return;
    }
  }
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
