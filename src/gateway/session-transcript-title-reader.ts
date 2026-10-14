import {
  isSessionTranscriptProjectionUnavailableError,
  type SessionTranscriptReadScope,
} from "../config/sessions/session-accessor.js";
import {
  resolveSqliteTranscriptReadScope,
  toDatabaseOptions,
} from "../config/sessions/session-accessor.sqlite-scope.js";
import { prepareSessionTranscriptReadTargetCore } from "../config/sessions/session-accessor.transcript-read-target.js";
import { captureSessionActorTranscriptRead } from "../config/sessions/session-actor-transcript-read.js";
import { resolveSessionTranscriptReadFence } from "../config/sessions/session-transcript-read-fence.js";
import { startSessionTranscriptIndexReconcile } from "../config/sessions/session-transcript-reconcile.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import type { SessionTitleFields } from "./session-utils.types.js";

const EMPTY_SESSION_TITLE_FIELDS: SessionTitleFields = {
  firstUserMessage: null,
  lastMessagePreview: null,
};

/** Reuse the bounded title cache in the existing history worker without transporting session metadata. */
export async function readSessionTitleFieldsFromTranscriptAsync(
  scope: SessionTranscriptReadScope,
  opts?: { includeInterSession?: boolean },
): Promise<SessionTitleFields> {
  const memory = captureSessionActorTranscriptRead(scope);
  if (memory) {
    return memory.missing
      ? { ...EMPTY_SESSION_TITLE_FIELDS }
      : (
          await memory.read("session.history.title", {
            includeInterSession: opts?.includeInterSession,
          })
        ).fields;
  }
  const target = prepareSessionTranscriptReadTargetCore(scope);
  const readScope: SessionTranscriptReadScope = {
    agentId: target.agentId,
    sessionId: scope.sessionId,
    sessionKey: target.sessionKey,
    storePath: target.storePath,
    ...(scope.env ? { env: scope.env } : {}),
    ...(scope.sessionEntry ? { sessionEntry: { sessionId: scope.sessionEntry.sessionId } } : {}),
  };
  const resolved = resolveSqliteTranscriptReadScope(readScope);
  const options = toDatabaseOptions(resolved);
  const databasePath = resolveOpenClawAgentSqlitePath(options);
  const admission = resolveSessionTranscriptReadFence(resolved);
  const { withSessionHistoryWorkerDatabase } =
    await import("../config/sessions/session-transcript-worker-runtime.js");
  try {
    return await withSessionHistoryWorkerDatabase(options, (owner) =>
      owner.readTitleFields({
        scope: { ...readScope, storePath: databasePath },
        ...(opts?.includeInterSession ? { includeInterSession: true } : {}),
        ...(admission ? { admission: { ...admission } } : {}),
      }),
    );
  } catch (error) {
    if (isSessionTranscriptProjectionUnavailableError(error)) {
      startSessionTranscriptIndexReconcile({ ...options, preferredSessionId: resolved.sessionId });
      return { ...EMPTY_SESSION_TITLE_FIELDS };
    }
    throw error;
  }
}
