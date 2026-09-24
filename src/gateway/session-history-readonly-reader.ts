import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { readAcpSessionMetaForEntry } from "../acp/runtime/session-meta-readonly.js";
import { isSubagentSessionFromEntry } from "../agents/subagents/spawn/subagent-depth-policy.js";
import {
  readExactSessionEntryRow,
  readSessionEntryRow,
} from "../config/sessions/session-accessor.sqlite-entry-read.js";
import { readSessionTranscriptRunInputVisibilityFromProjection } from "../config/sessions/session-accessor.sqlite-history-input-visibility.js";
import { readTranscriptDisplayDeltaFromProjection } from "../config/sessions/session-accessor.sqlite-history-query.js";
import {
  readCurrentProjectionSnapshot,
  type CurrentTranscriptProjection,
} from "../config/sessions/session-accessor.sqlite-projection-read.js";
import type { SessionTranscriptRawDeltaLimits } from "../config/sessions/session-accessor.types.js";
import { readWithCanonicalSessionAdmission } from "../config/sessions/session-canonical-key.js";
import {
  SessionTranscriptProjectionUnavailableError,
  SessionTranscriptStorageUnavailableError,
} from "../config/sessions/session-transcript-projection-error.js";
import { withStateDatabaseCoordinatorRuntimeDirectory } from "../infra/state-database-coordinator.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { buildRunUserTurnIdempotencyKey } from "../sessions/user-turn-transcript.metadata.js";
import { withScopedOpenClawAgentDatabaseReadOnly } from "../state/openclaw-agent-db-readonly-scope.js";
import {
  isSubagentCoordinationHistoryInput,
  type SubagentCoordinationDisplayResolver,
} from "./chat-display-projection.history.js";
import type { PreparedSessionHistoryReadTarget } from "./session-history-read.types.js";
import { createSessionTranscriptReader } from "./session-transcript-read-kernel.js";
import { readGatewaySessionEntryFromSources } from "./session-utils-store-readonly.js";
import type { GatewaySessionStoreReadSources } from "./session-utils-store.types.js";

/** Source and run facts live only for one history operation, on its admitted database. */
export function createBoundSessionHistorySubagentProjection(
  readSnapshot: <T>(read: (projection: CurrentTranscriptProjection) => T) => T,
  stateDatabase: PreparedSessionHistoryReadTarget["stateDatabase"],
  readSourceDatabases: () => GatewaySessionStoreReadSources | undefined,
): SubagentCoordinationDisplayResolver {
  const sources = new Map<string, boolean>();
  const runs = new Map<
    string,
    ReturnType<typeof readSessionTranscriptRunInputVisibilityFromProjection>
  >();
  const readSource = (projection: CurrentTranscriptProjection, sessionKey: string) => {
    const cached = sources.get(sessionKey);
    if (cached !== undefined) {
      return cached;
    }
    if (isSubagentSessionFromEntry(sessionKey, undefined)) {
      sources.set(sessionKey, true);
      return true;
    }
    // Retired native children retain their canonical key. ACP lineage additionally
    // requires current metadata from its separately bound shared-state owner.
    const sourceAgentId = parseAgentSessionKey(sessionKey)?.agentId;
    const sourceDatabases = readSourceDatabases();
    const ownSource = { agentId: projection.database.agentId, path: projection.database.path };
    const hasPreparedSource = Boolean(
      sourceAgentId && sourceDatabases && Object.hasOwn(sourceDatabases, sourceAgentId),
    );
    const candidates =
      sourceAgentId && sourceDatabases && hasPreparedSource
        ? [...(sourceDatabases[sourceAgentId] ?? [])]
        : [];
    if (!sourceAgentId || sourceAgentId === projection.resolved.agentId || !hasPreparedSource) {
      if (
        !candidates.some(
          (source) => source.agentId === ownSource.agentId && source.path === ownSource.path,
        )
      ) {
        candidates.unshift(ownSource);
      }
    }
    const ownCandidate = candidates.find(
      (source) => source.agentId === ownSource.agentId && source.path === ownSource.path,
    );
    const ownEntry = ownCandidate
      ? readExactSessionEntryRow(projection.database, sessionKey, "list")?.entry
      : undefined;
    const entry = readGatewaySessionEntryFromSources(sessionKey, candidates, {
      source: ownCandidate ?? ownSource,
      entry: ownEntry,
    });
    let child = isSubagentSessionFromEntry(sessionKey, entry);
    if (!child && entry && (entry.parentSessionKey || entry.spawnedBy) && stateDatabase) {
      const acp = withStateDatabaseCoordinatorRuntimeDirectory(
        stateDatabase.coordinatorRuntime,
        () =>
          readAcpSessionMetaForEntry({
            sessionKey,
            agentId: parseAgentSessionKey(sessionKey)?.agentId,
            entry,
            databasePath: stateDatabase.path,
            env: stateDatabase.environment,
          }),
      );
      child = isSubagentSessionFromEntry(sessionKey, entry, acp);
    }
    sources.set(sessionKey, child);
    return child;
  };
  return {
    isSubagentSession(sessionKey) {
      return (
        sources.get(sessionKey) ?? readSnapshot((projection) => readSource(projection, sessionKey))
      );
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
              return Boolean(
                record &&
                isSubagentCoordinationHistoryInput(record, (key) => readSource(projection, key)),
              );
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
