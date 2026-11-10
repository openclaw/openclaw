import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import { resolveSqliteSessionKey } from "./session-accessor.sqlite-scope-helpers.js";
import { captureSessionEntryReadSource } from "./session-entry-read-source.js";
import type {
  SessionRuntimeTargetWorkerInput,
  SessionRuntimeTargetWorkerResult,
} from "./session-entry-read.types.js";

/** Resolve a private transcript target without loading broad entry hydration. */
export async function readSessionRuntimeTargetWorkerRequest(
  request: SessionRuntimeTargetWorkerInput,
): Promise<SessionRuntimeTargetWorkerResult> {
  const { readSessionTranscriptRuntimeTarget } =
    await import("./session-accessor.transcript-target.js");
  const read = withOpenClawAgentDatabaseReadOnly(
    (database) => ({
      target: readSessionTranscriptRuntimeTarget(
        request.scope,
        {
          keyFormat: request.keyFormat,
          databaseAgentId: request.database.agentId,
          continuation: request.continuation,
        },
        database,
      ),
      source: captureSessionEntryReadSource(
        database,
        undefined,
        "Session runtime target requires its current durable owner",
      ),
    }),
    { ...request.database, env: request.scope.env },
  );
  return {
    kind: "session-runtime-target",
    ...(read.found
      ? read.value
      : {
          target: {
            agentId: request.scope.agentId,
            sessionId: request.scope.sessionId,
            sessionKey: resolveSqliteSessionKey(request.scope.sessionKey, request.scope.agentId),
            storePath: request.scope.storePath,
            ...(request.keyFormat
              ? { selectedSessionId: null, selectedLifecycleRevision: null }
              : {}),
          },
        }),
  };
}
