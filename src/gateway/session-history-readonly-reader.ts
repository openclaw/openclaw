import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { readSessionEntryRow } from "../config/sessions/session-accessor.sqlite-entry-read.js";
import { readSessionTranscriptRunInputVisibilityFromProjection } from "../config/sessions/session-accessor.sqlite-history-input-visibility.js";
import { readTranscriptDisplayDeltaFromProjection } from "../config/sessions/session-accessor.sqlite-history-query.js";
import {
  readCurrentProjectionSnapshot,
  type CurrentTranscriptProjection,
} from "../config/sessions/session-accessor.sqlite-projection-read.js";
import { readSessionTranscriptBindingFromProjection } from "../config/sessions/session-accessor.sqlite-task-history.js";
import type { SessionTranscriptRawDeltaLimits } from "../config/sessions/session-accessor.types.js";
import { readWithCanonicalSessionAdmission } from "../config/sessions/session-canonical-key.js";
import {
  SessionTranscriptProjectionUnavailableError,
  SessionTranscriptStorageUnavailableError,
} from "../config/sessions/session-transcript-projection-error.js";
import { buildRunUserTurnIdempotencyKey } from "../sessions/user-turn-transcript.metadata.js";
import { withScopedOpenClawAgentDatabaseReadOnly } from "../state/openclaw-agent-db-readonly-scope.js";
import {
  isSubagentCoordinationHistoryInput,
  type SubagentCoordinationDisplayResolver,
} from "./chat-display-projection.history.js";
import type { PreparedSessionHistoryReadTarget } from "./session-history-read.types.js";
import { createBoundSessionHistorySubagentSource } from "./session-history-subagent-sources.js";
import { createSessionTranscriptReader } from "./session-transcript-read-kernel.js";
import type { GatewaySessionStoreReadSources } from "./session-utils-store.types.js";

/** Source and run facts live only for one history operation, on its admitted database. */
export function createBoundSessionHistorySubagentProjection(
  readSnapshot: <T>(read: (projection: CurrentTranscriptProjection) => T) => T,
  stateDatabase: PreparedSessionHistoryReadTarget["stateDatabase"],
  readSourceDatabases: () => GatewaySessionStoreReadSources | undefined,
): SubagentCoordinationDisplayResolver {
  const runs = new Map<
    string,
    ReturnType<typeof readSessionTranscriptRunInputVisibilityFromProjection>
  >();
  const readSource = createBoundSessionHistorySubagentSource(
    readSnapshot,
    stateDatabase,
    readSourceDatabases,
  );
  return {
    isSubagentSession(sessionKey) {
      return readSource(sessionKey);
    },
    isSubagentRunMessage(runId, messageSeq) {
      if (messageSeq === undefined) {
        return false;
      }
      let visibility = runs.get(runId);
      if (
        !visibility ||
        (visibility.hidden &&
          visibility.firstVisibleMessageSeq === undefined &&
          visibility.scannedThroughMessageSeq < messageSeq)
      ) {
        visibility = readSnapshot((projection) =>
          readSessionTranscriptRunInputVisibilityFromProjection(projection, {
            idempotencyKey: buildRunUserTurnIdempotencyKey(runId),
            runId,
            messageSeq,
            previous: visibility?.hidden ? visibility : undefined,
            isHiddenInput: (message) => {
              const record = asOptionalRecord(message);
              return Boolean(record && isSubagentCoordinationHistoryInput(record, readSource));
            },
          }),
        );
        runs.set(runId, visibility);
      }
      return (
        visibility.hidden &&
        (visibility.firstVisibleMessageSeq === undefined ||
          messageSeq < visibility.firstVisibleMessageSeq)
      );
    },
  };
}

export function createReadonlySessionHistoryReader(target: PreparedSessionHistoryReadTarget) {
  const sourceDatabases = target.sourceDatabases;
  const readSnapshot = <T>(read: (projection: CurrentTranscriptProjection) => T): T => {
    const result = withScopedOpenClawAgentDatabaseReadOnly(
      (database) =>
        readWithCanonicalSessionAdmission(database, () => {
          // Repeat the original conditional row validation at every reader invocation,
          // after dispatch. A current entry may name a successor; it never selects this transcript.
          const entryValidationKey = target.entryValidationKey;
          if (entryValidationKey !== undefined) {
            readSessionEntryRow(database, entryValidationKey);
          }
          return readCurrentProjectionSnapshot(
            database,
            {
              agentId: target.transcript.agentId,
              sessionId: target.transcript.sessionId,
              sessionKey: target.transcript.sessionKey,
              databaseAgentId: target.database.agentId,
              path: target.database.path,
            },
            read,
          );
        }),
      target.database,
    );
    if (!result.found) {
      throw new SessionTranscriptStorageUnavailableError(result.reason);
    }
    if (result.value.kind === "unavailable") {
      throw new SessionTranscriptProjectionUnavailableError(target.transcript.sessionId);
    }
    return result.value.value;
  };
  return {
    readTranscriptBinding: (run?: { id: string; maxBytes: number }) =>
      readSnapshot((projection) => readSessionTranscriptBindingFromProjection(projection, run)),
    readTranscriptDisplayDelta: (limits: SessionTranscriptRawDeltaLimits) =>
      readSnapshot((projection) => readTranscriptDisplayDeltaFromProjection(projection, limits)),
    ...createSessionTranscriptReader({
      resolveTarget: async () => target.transcript,
      readSnapshot: async (_transcript, read) => readSnapshot(read),
    }),
    subagentCoordination: createBoundSessionHistorySubagentProjection(
      readSnapshot,
      target.stateDatabase,
      () => sourceDatabases,
    ),
  };
}
