import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { readSessionEntryRow } from "../config/sessions/session-accessor.sqlite-entry-store.js";
import { readCurrentProjectionSnapshot } from "../config/sessions/session-accessor.sqlite-projection-read.js";
import { resolveTranscriptBoundaryWindow } from "../config/sessions/session-accessor.sqlite-reset-window.js";
import {
  getSessionKysely,
  type ResolvedTranscriptScope,
} from "../config/sessions/session-accessor.sqlite-scope.js";
import { readActiveTranscriptEntryAnchorInTransaction } from "../config/sessions/session-accessor.sqlite-transcript-anchor.js";
import { readTranscriptGenerationInTransaction } from "../config/sessions/session-accessor.sqlite-transcript-state.js";
import { rewriteSqliteTranscriptEventRowsInTransaction } from "../config/sessions/session-accessor.sqlite-transcript-store.js";
import { assertSessionTranscriptHot } from "../config/sessions/session-cold-storage-state.js";
import { transcriptEventJsonSql } from "../config/sessions/transcript-payload.js";
import { SessionTranscriptWriterClaimReboundError } from "../config/sessions/transcript-write-context.js";
import { executeSqliteQueryTakeFirstSync } from "../infra/kysely-sync.js";
import { assertTransactionUsable } from "../infra/sqlite-transaction.js";
import type { SqliteWorkerBackend } from "../infra/sqlite-worker-contract.js";
import { getSqliteWorkerStateContext } from "../infra/sqlite-worker-state-context.js";
import {
  getOpenClawAgentDatabaseIfOpen,
  runOpenClawAgentWriteTransaction,
  type OpenClawAgentDatabase,
  type OpenClawAgentDatabaseOptions,
} from "../state/openclaw-agent-db.js";
import type {
  SteeredUserTurnTranscriptCommit,
  SteeredUserTurnTranscriptInput,
  SteeredUserTurnTranscriptOperations,
  SteeredUserTurnTranscriptSnapshot,
} from "./user-turn-transcript-steering.types.js";
import { rewritePersistedSteerTargetRunId } from "./user-turn-transcript.metadata.js";

/** One transaction kernel for durable workers and the existing process-held memory owner. */
export function confirmSteeredUserTurnTranscriptInTransaction(
  database: OpenClawAgentDatabase,
  input: SteeredUserTurnTranscriptInput,
): SteeredUserTurnTranscriptCommit {
  const anchor = input.source.admission;
  const resolved: ResolvedTranscriptScope = {
    agentId: anchor.agentId,
    sessionId: anchor.sessionId,
    sessionKey: anchor.sessionKey,
    path: database.path,
  };
  if (
    input.target &&
    (input.target.agentId !== anchor.agentId ||
      input.target.sessionId !== anchor.sessionId ||
      input.target.sessionKey !== anchor.sessionKey)
  ) {
    throw new Error("Steer confirmation belongs to another transcript target");
  }
  assertSessionTranscriptHot(database.db, resolved.sessionId);
  const entry = readSessionEntryRow(database, resolved.sessionKey, "list")?.entry;
  if (
    !entry ||
    entry.sessionId !== anchor.sessionId ||
    (input.target &&
      (entry.lifecycleRevision !== input.target.expectedLifecycleRevision ||
        entry.activeWriterRunId !== input.target.expectedWriterRunId ||
        input.target.expectedWriterRunId !== input.targetRunId))
  ) {
    throw new SessionTranscriptWriterClaimReboundError();
  }
  const boundary = readCurrentProjectionSnapshot(
    database,
    resolved,
    (projection) =>
      resolveTranscriptBoundaryWindow(projection, "history")?.postBoundaryMessagePosition ?? 0,
  );
  if (boundary.kind !== "value") {
    throw new Error("Steer confirmation requires a current active projection");
  }
  const readSnapshot = (
    snapshot: SteeredUserTurnTranscriptSnapshot,
    requireGeneration: boolean,
  ) => {
    const expected = snapshot.admission;
    const current = readActiveTranscriptEntryAnchorInTransaction({
      database,
      resolved,
      entryId: expected.entryId,
    });
    if (
      !current ||
      expected.activeMessagePosition < boundary.value ||
      expected.role !== "user" ||
      (
        [
          "agentId",
          "sessionId",
          "sessionKey",
          "storePath",
          "entryId",
          "rawSeq",
          "effectiveParentId",
          "activeMessagePosition",
          "idempotencyKey",
        ] as const
      ).some((field) => current[field] !== expected[field]) ||
      (requireGeneration && current.generation !== expected.generation)
    ) {
      throw new Error("Steered user-turn transcript admission changed");
    }
    const row = executeSqliteQueryTakeFirstSync(
      database.db,
      getSessionKysely(database.db)
        .selectFrom("transcript_events")
        .select(transcriptEventJsonSql(database.db).as("event_json"))
        .where("session_id", "=", resolved.sessionId)
        .where("seq", "=", expected.rawSeq),
    );
    const event: unknown = row ? JSON.parse(row.event_json) : undefined;
    if (
      !row ||
      !isRecord(event) ||
      event.type !== "message" ||
      event.id !== expected.entryId ||
      !isRecord(event.message) ||
      event.message.role !== "user" ||
      !isDeepStrictEqual(event.message, snapshot.message)
    ) {
      throw new Error("Steered user-turn transcript message changed");
    }
    return { event, eventJson: row.event_json };
  };
  if (input.continuation) {
    readSnapshot(input.continuation, true);
  }
  // B can predate an earlier confirmation in the same batch. Only the still-current
  // private A receipt permits carrying it across that generation change.
  const source = readSnapshot(input.source, !input.continuation);
  const message = rewritePersistedSteerTargetRunId(input.source.message, input.targetRunId);
  if (!message) {
    throw new Error("Steer confirmation requires its persisted user message");
  }
  const changed = !isDeepStrictEqual(message, input.source.message);
  if (changed) {
    rewriteSqliteTranscriptEventRowsInTransaction(database, resolved, [
      {
        event: { ...source.event, message },
        expectedEventJson: source.eventJson,
        seq: anchor.rawSeq,
      },
    ]);
  }
  const generation = readTranscriptGenerationInTransaction(database, resolved.sessionId);
  if (!generation) {
    throw new Error("Steer confirmation lost its transcript generation");
  }
  return { generation, message, changed };
}

/** Domain binding borrows the broker's canonical writer; it never opens another store. */
export function bindSqliteWorkerBackend(
  input: { agentId: string; path: string },
  context: {
    database: DatabaseSync;
    databasePath: string;
    admit(stage: "transaction" | "commit"): void;
  },
): SqliteWorkerBackend<SteeredUserTurnTranscriptOperations> {
  const options: OpenClawAgentDatabaseOptions = {
    agentId: input.agentId,
    path: context.databasePath,
    env: getSqliteWorkerStateContext().environment,
  };
  const database = getOpenClawAgentDatabaseIfOpen(options);
  if (!database || database.db !== context.database || input.path !== context.databasePath) {
    throw new Error("Steer confirmation lost its canonical database owner");
  }
  let closed = false;
  const assertOpen = () => {
    if (closed || !database.db.isOpen) {
      throw new Error("Steer confirmation domain is closed");
    }
    assertTransactionUsable(database.db);
  };
  return {
    execute(command) {
      assertOpen();
      return runOpenClawAgentWriteTransaction(
        (current) => {
          if (current.db !== database.db) {
            throw new Error("Steer confirmation changed its database owner");
          }
          context.admit("transaction");
          const result = confirmSteeredUserTurnTranscriptInTransaction(database, command.input);
          context.admit("commit");
          return result;
        },
        options,
        { operationLabel: "session.transcript.message-rewrite" },
      );
    },
    assertSettled() {
      assertOpen();
      if (database.db.isTransaction) {
        throw new Error("Steer confirmation left a transaction open");
      }
    },
    close() {
      closed = true;
    },
  };
}
