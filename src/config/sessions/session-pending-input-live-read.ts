import { captureForeignLiveSessionPendingInputReader } from "./session-accessor.sqlite-pending-inputs.js";
import {
  assertSqliteTranscriptWriteIdentity,
  prepareSqliteTranscriptReadScope,
  resolveSqliteSessionKey,
} from "./session-accessor.sqlite-scope.js";
import type { SessionAccessScope } from "./session-accessor.types.js";
import { captureSessionActorStorageOwner } from "./session-actor-storage-binding.js";
import { captureSessionStoreReadTarget } from "./session-store-read-target.js";
import { captureSessionTranscriptStorageEnvironment } from "./transcript-target-binding.js";
import { getOwnedSessionTranscriptReader } from "./transcript-write-context.js";

/** Resolve the physical session before write admission; reads thereafter use live host custody. */
export async function prepareForeignLiveSessionPendingInputEntries(
  scope: SessionAccessScope & { sessionId: string },
  signal?: AbortSignal,
): Promise<() => Promise<ReadonlyMap<string, string>>> {
  signal?.throwIfAborted();
  assertSqliteTranscriptWriteIdentity(scope);
  const read = captureForeignLiveSessionPendingInputReader();
  const captured = {
    ...scope,
    env: captureSessionTranscriptStorageEnvironment(scope.env ?? process.env),
  };
  const memory = captureSessionActorStorageOwner(captured, {
    assertCurrent() {},
    authorize() {},
  });
  const reader = memory ? undefined : getOwnedSessionTranscriptReader(captured);
  const target =
    memory || reader
      ? undefined
      : await captureSessionStoreReadTarget(
          captured,
          "Live input changed its captured database owner",
        );
  const resolved = await prepareSqliteTranscriptReadScope(captured, signal);
  signal?.throwIfAborted();
  const sessionKey = resolveSqliteSessionKey(captured.sessionKey, resolved.agentId);
  const physical = await target?.resolve({ ...resolved, sessionKey });
  // An uncreated store has no foreign custody; its path can still match later accepted input.
  reader?.assertCurrent();
  if (physical?.identity.key.startsWith("file:")) {
    await physical.assertReadCurrentAsync();
  }
  signal?.throwIfAborted();
  const inputScope = {
    databasePath:
      memory?.path ?? reader?.identity.canonicalPath ?? physical!.identity.canonicalPath,
    sessionId: captured.sessionId,
    sessionKey,
  };
  return async () => {
    signal?.throwIfAborted();
    if (reader) {
      reader.assertCurrent();
    } else if (physical?.identity.key.startsWith("file:")) {
      await physical.assertReadCurrentAsync();
    }
    signal?.throwIfAborted();
    const entries = await read(inputScope);
    reader?.assertCurrent();
    signal?.throwIfAborted();
    return entries;
  };
}
