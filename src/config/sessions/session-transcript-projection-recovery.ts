import type { SessionTranscriptReadScope } from "./session-accessor.sqlite-contract.js";
import {
  prepareSqliteTranscriptReadScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import { captureSessionActorStorageOwner } from "./session-actor-storage-binding.js";
import { prepareReconcileParams } from "./session-transcript-reconcile-readiness.js";
import {
  startSessionTranscriptIndexReconcile,
  waitForPreparedSessionTranscriptProjection,
} from "./session-transcript-reconcile.js";

/** Rebuilds a newly admitted session on its prepared physical store, then waits there. */
export async function recoverSessionTranscriptProjection(
  scope: SessionTranscriptReadScope,
  abortSignal: AbortSignal,
  assertCurrent: () => void,
): Promise<void> {
  abortSignal.throwIfAborted();
  if (captureSessionActorStorageOwner(scope, { assertCurrent, authorize() {} })) {
    return;
  }
  const resolved = await prepareSqliteTranscriptReadScope(scope, abortSignal);
  assertCurrent();
  abortSignal.throwIfAborted();
  const prepared = prepareReconcileParams({
    ...toDatabaseOptions(resolved),
    preferredSessionId: resolved.sessionId,
  });
  startSessionTranscriptIndexReconcile(prepared);
  await waitForPreparedSessionTranscriptProjection(resolved.sessionId, prepared, abortSignal);
}
