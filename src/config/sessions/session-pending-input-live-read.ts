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

/** Resolve the physical session before write admission; reads thereafter use live host custody. */
export async function prepareForeignLiveSessionPendingInputEntries(
  scope: SessionAccessScope & { sessionId: string },
  signal?: AbortSignal,
): Promise<() => ReadonlyMap<string, string>> {
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
  const target = memory
    ? undefined
    : captureSessionStoreReadTarget(captured, "Live input changed its captured database owner");
  const resolved = await prepareSqliteTranscriptReadScope(captured, signal);
  signal?.throwIfAborted();
  const sessionKey = resolveSqliteSessionKey(captured.sessionKey, resolved.agentId);
  const physical = target?.resolve({ ...resolved, sessionKey });
  // An uncreated store has no foreign custody; its path can still match later accepted input.
  const assertReadCurrent = physical?.identity.key.startsWith("file:")
    ? physical.assertReadCurrent
    : undefined;
  assertReadCurrent?.();
  const inputScope = {
    databasePath: memory?.path ?? physical!.identity.canonicalPath,
    sessionId: scope.sessionId,
    sessionKey,
  };
  return () => {
    signal?.throwIfAborted();
    assertReadCurrent?.();
    return read(inputScope);
  };
}
