import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import {
  readSessionEntrySelectionInDatabase,
  readSessionKeyBySessionIdInDatabase,
} from "./session-accessor.sqlite-entry-read.js";
import { resolveSqliteScope } from "./session-accessor.sqlite-read-scope.js";
import { resolveSqliteSessionKey } from "./session-accessor.sqlite-scope-helpers.js";
import { readWithCanonicalSessionReaderContinuation } from "./session-canonical-key.js";
import { captureSessionEntryReadSource } from "./session-entry-read-source.js";
import type {
  SessionRuntimeTargetWorkerInput,
  SessionRuntimeTargetWorkerResult,
} from "./session-entry-read.types.js";

/** Runtime targets consume the existing reader without importing the caller's memory/write adapters. */
export function readSessionRuntimeTargetWorkerRequest(
  request: SessionRuntimeTargetWorkerInput,
): SessionRuntimeTargetWorkerResult {
  const read = withOpenClawAgentDatabaseReadOnly(
    (database) => {
      const { agentId, sessionId, storePath } = request.scope;
      const persistedSessionKey = readSessionKeyBySessionIdInDatabase(database, sessionId);
      const selected =
        persistedSessionKey && !request.keyFormat
          ? undefined
          : readWithCanonicalSessionReaderContinuation(database, request.continuation, () => {
              const resolved = resolveSqliteScope({
                ...request.scope,
                sessionKey: persistedSessionKey ?? request.scope.sessionKey,
                storePath: undefined,
              });
              const row = readSessionEntrySelectionInDatabase(
                database,
                resolved.agentId,
                resolved.sessionKey,
                { keyFormat: request.keyFormat, allowCanonicalMove: !persistedSessionKey },
              );
              return {
                existing: row?.entry ?? undefined,
                normalizedKey: row?.row.session_key ?? resolved.sessionKey,
              };
            });
      return {
        target: {
          agentId,
          sessionId,
          sessionKey: persistedSessionKey ?? selected?.normalizedKey ?? request.scope.sessionKey,
          storePath,
          ...(request.keyFormat
            ? {
                selectedSessionId: selected?.existing?.sessionId ?? null,
                selectedLifecycleRevision: selected?.existing?.lifecycleRevision ?? null,
              }
            : {}),
        },
        source: captureSessionEntryReadSource(
          database,
          undefined,
          "Session runtime target requires its current durable owner",
        ),
      };
    },
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
