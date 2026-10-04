import type { SessionTranscriptReadScope } from "./session-accessor.sqlite-contract.js";
import {
  prepareSqliteTranscriptReadScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
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
  const resolved = await prepareSqliteTranscriptReadScope(scope, abortSignal);
  assertCurrent();
  abortSignal.throwIfAborted();
  startSessionTranscriptIndexReconcile({
    ...toDatabaseOptions(resolved),
    preferredSessionId: resolved.sessionId,
  });
  await waitForPreparedSessionTranscriptProjection(resolved, abortSignal);
}
