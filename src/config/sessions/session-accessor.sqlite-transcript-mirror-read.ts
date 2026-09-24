import {
  isIncognitoOpenClawAgentSqlitePath,
  resolveOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.paths.js";
import {
  prepareSqliteTranscriptReadScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import type { TranscriptMirrorFacts } from "./session-accessor.sqlite-transcript-mirror.js";
import type { SessionTranscriptReadScope } from "./session-accessor.types.js";
import { withSessionHistoryWorkerDatabase } from "./session-transcript-worker-runtime.js";
import { captureSessionTranscriptStorageEnvironment } from "./transcript-target-binding.js";

/** Read replay facts within the caller's existing transcript writer queue. */
export async function readTranscriptMirrorFactsAsync(
  scope: SessionTranscriptReadScope,
  params: { idempotencyKeys: readonly string[] },
): Promise<TranscriptMirrorFacts> {
  const capturedScope = {
    ...scope,
    env: captureSessionTranscriptStorageEnvironment(scope.env ?? process.env),
  };
  const idempotencyKeys = [...params.idempotencyKeys];
  const prepared = await prepareSqliteTranscriptReadScope(capturedScope);
  if (!prepared.sessionKey) {
    throw new Error("Session transcript mirror facts require a session key");
  }
  const resolved = { ...prepared, sessionKey: prepared.sessionKey };
  const options = toDatabaseOptions(resolved);
  if (isIncognitoOpenClawAgentSqlitePath(resolveOpenClawAgentSqlitePath(options), options)) {
    // Incognito databases belong to this process and cannot be reopened in another isolate.
    const { readTranscriptMirrorFactsReadOnly } =
      await import("./session-accessor.sqlite-transcript-mirror.js");
    return readTranscriptMirrorFactsReadOnly(resolved, { idempotencyKeys });
  }
  return withSessionHistoryWorkerDatabase(options, async (owner) =>
    owner.readMirrorFacts({ resolved, idempotencyKeys }),
  );
}
