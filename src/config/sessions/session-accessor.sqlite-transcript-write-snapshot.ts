import type { DatabaseSync } from "node:sqlite";
import { err, ok, type Result } from "@openclaw/normalization-core/result";
import { hasSqlitePostCommitScope } from "../../infra/sqlite-post-commit.js";
import { getSqliteReadScopeRevision } from "../../infra/sqlite-schema-facts.js";
import { readOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import {
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
  runOpenClawAgentWriteTransaction,
  type OpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import type {
  TranscriptWriteSnapshot,
  SessionTranscriptWriteScope,
  TranscriptAppendRefusal,
} from "./session-accessor.sqlite-contract.js";
import { readSessionEntryRow } from "./session-accessor.sqlite-entry-store.js";
import { resolveSessionPendingInputAppend } from "./session-accessor.sqlite-pending-inputs.js";
import {
  resolveSqliteTranscriptScope,
  runExclusiveSqliteSessionWrite,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import { readTranscriptContextVersionInTransaction } from "./session-accessor.sqlite-transcript-state.js";
import { readTranscriptMessageByScopedIdempotencyKey } from "./session-accessor.sqlite-transcript-store.js";
import { resolveTranscriptAppendRefusal } from "./session-accessor.sqlite-transcript-write-guard.js";
import type {
  LockedTranscriptMessageAppendOptions,
  SessionTranscriptWriteTransactionContext,
  TranscriptMessageAppendOptions,
} from "./session-accessor.types.js";
import { SqliteTranscriptMutationConflictError } from "./session-mutation-conflict-error.js";
import { readTranscriptAppendPostimage } from "./session-transcript-append-postimage.js";
import { readMessageIdempotencyKey } from "./transcript-message-identity.js";
import {
  assertOwnedTranscriptWriteCommit,
  SessionTranscriptWriterClaimReboundError,
  withOwnedSessionTranscriptWriterFence,
} from "./transcript-write-context.js";

export type TranscriptWriteViewGuard = {
  assertCurrent: () => void;
  onPendingTransaction: (database: DatabaseSync) => void;
};

/** Prepare without holding a transaction; fresh inserts recheck their original snapshot. */
export async function prepareNativeLockedAppend<T>(
  scope: SessionTranscriptWriteScope,
  options: LockedTranscriptMessageAppendOptions<T>,
): Promise<(database: OpenClawAgentDatabase) => TranscriptMessageAppendOptions<T>> {
  const { preparation, prepareMessageAfterIdempotencyCheckAsync, ...legacy } = options;
  const prepare = preparation?.prepareMessage ?? prepareMessageAfterIdempotencyCheckAsync;
  const retained = {
    ...legacy,
    ...(preparation?.source ? { beforeFreshMessageCommit: preparation.source } : {}),
  };
  if (
    preparation &&
    (options.prepareMessageAfterIdempotencyCheck || options.beforeFreshMessageCommit)
  ) {
    throw new Error("Choose preparation or the legacy transcript callback form, not both.");
  }
  if (!prepare) {
    return () => retained;
  }
  const resolved = resolveSqliteTranscriptScope(scope);
  const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
  const identity = readOpenClawAgentDatabaseIdentity(database);
  const version = { ...readTranscriptContextVersionInTransaction(database, resolved.sessionId) };
  const key = readMessageIdempotencyKey(options.message);
  const existing =
    key && options.idempotencyLookup !== "caller-checked"
      ? readTranscriptMessageByScopedIdempotencyKey(
          database,
          resolved,
          key,
          options.idempotencyLookup,
        )
      : undefined;
  const fresh = !existing && !resolveSessionPendingInputAppend(database, resolved, options.message);
  const message = fresh ? await prepare(options.message) : options.message;
  return (current) => {
    const physical = readOpenClawAgentDatabaseIdentity(current);
    if (physical.identity !== identity.identity || physical.birthtime !== identity.birthtime) {
      throw new SqliteTranscriptMutationConflictError(resolved.sessionId);
    }
    return {
      ...retained,
      prepareMessageAfterIdempotencyCheck: () => {
        // Replay and accepted-input custody keep their original preparation decision.
        const next = readTranscriptContextVersionInTransaction(current, resolved.sessionId);
        if (
          !fresh ||
          next.generation !== version.generation ||
          next.rawSeq !== version.rawSeq ||
          next.updatedAt !== version.updatedAt
        ) {
          throw new SqliteTranscriptMutationConflictError(resolved.sessionId);
        }
        return message;
      },
    };
  };
}

export function runTranscriptWriteSnapshotSync<T>(
  scope: SessionTranscriptWriteScope,
  operation: (
    database: OpenClawAgentDatabase,
    resolved: ReturnType<typeof resolveSqliteTranscriptScope>,
  ) => T,
  beforeCommitInTransaction?: () => void,
  expectedMutationAt?: number | null,
  view?: TranscriptWriteViewGuard,
  diagnosticContext?: { eventType: string; messageRole?: string },
): Result<TranscriptWriteSnapshot<T>, TranscriptAppendRefusal> {
  const fencedScope = withOwnedSessionTranscriptWriterFence(scope);
  const resolved = resolveSqliteTranscriptScope(fencedScope);
  let connection: DatabaseSync | undefined;
  const result = runOpenClawAgentWriteTransaction<
    Result<TranscriptWriteSnapshot<T>, TranscriptAppendRefusal>
  >(
    (database) => {
      connection = database.db;
      beforeCommitInTransaction?.();
      view?.assertCurrent();
      assertOwnedTranscriptWriteCommit(fencedScope);
      const fresh = readSessionEntryRow(database, resolved.sessionKey, "list");
      const refusal = resolveTranscriptAppendRefusal(fresh?.entry, resolved, fencedScope);
      if (refusal) {
        return err(refusal);
      }
      const before = readTranscriptContextVersionInTransaction(database, resolved.sessionId);
      if (expectedMutationAt !== undefined && before.updatedAt !== expectedMutationAt) {
        throw new SqliteTranscriptMutationConflictError(resolved.sessionId);
      }
      const lifecycleRevision = fresh?.entry.lifecycleRevision;
      const value = operation(database, resolved);
      const postimage = readTranscriptAppendPostimage(value);
      view?.assertCurrent();
      assertOwnedTranscriptWriteCommit(fencedScope);
      return ok({
        result: value,
        lifecycleRevision,
        before,
        // Hooks may write after the append. Reuse only within its unchanged native snapshot.
        after:
          postimage?.anchor.sessionId === resolved.sessionId &&
          getSqliteReadScopeRevision(database.db) === postimage.revision
            ? { ...postimage.version }
            : readTranscriptContextVersionInTransaction(database, resolved.sessionId),
      });
    },
    toDatabaseOptions(resolved),
    {
      operationLabel: "session.transcript.write-snapshot",
      diagnosticContext: {
        sessionId: resolved.sessionId,
        requestedEvents: 1,
        ...diagnosticContext,
      },
    },
  );
  // A savepoint can return while its enclosing transaction still owns rollback.
  if (result.ok && connection && hasSqlitePostCommitScope(connection)) {
    view?.onPendingTransaction(connection);
  }
  if (fencedScope.expectedWriterRunId !== undefined && !result.ok) {
    throw new SessionTranscriptWriterClaimReboundError(result.error);
  }
  return result;
}

/** Runs synchronous transcript work under one writer queue and SQLite transaction. */
export async function withTranscriptWriteTransaction<T>(
  scope: SessionTranscriptWriteScope,
  run: (context: SessionTranscriptWriteTransactionContext) => T,
): Promise<T> {
  const resolved = resolveSqliteTranscriptScope(scope);
  const { restoreSessionColdTranscript } = await import("./session-cold-storage.js");
  await restoreSessionColdTranscript({ ...scope, sessionId: resolved.sessionId });
  return await runExclusiveSqliteSessionWrite(
    resolved,
    async () =>
      runOpenClawAgentWriteTransaction(
        () =>
          run({
            agentId: resolved.agentId,
            sessionId: resolved.sessionId,
            sessionKey: resolved.sessionKey,
            storePath:
              resolved.path ??
              scope.storePath ??
              resolveOpenClawAgentSqlitePath({ agentId: resolved.agentId, env: resolved.env }),
          }),
        toDatabaseOptions(resolved),
        { operationLabel: "session.transcript.batch" },
      ),
    "session.transcript.batch",
  );
}
