import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
} from "../../infra/kysely-sync.js";
import { withSqliteDatabaseWriteScope } from "../../infra/sqlite-database-admission.js";
import { assertTransactionUsable } from "../../infra/sqlite-transaction.js";
import { emitSessionLifecycleEvent } from "../../sessions/session-lifecycle-events.js";
import {
  deferOpenClawAgentPostCommitPublication,
  getOpenClawAgentDatabaseIfOpen,
  runOpenClawAgentWriteTransaction,
  type OpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { ensureSessionParticipantsSchema } from "../../state/openclaw-agent-session-participants-schema.js";
import { readUserProfileAliases } from "../../state/user-profiles.js";
import type { SessionAccessScope } from "./session-accessor.sqlite-contract.js";
import {
  publishSessionEntryCacheParticipantUpdate,
  trackSessionEntryCacheWrite,
} from "./session-accessor.sqlite-entry-cache.js";
import {
  getSessionKysely,
  resolveSqliteScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import { MAX_SESSION_PARTICIPANTS } from "./session-entry-provenance.js";
import {
  participantIdentityNamespace,
  mergeParticipantAggregate,
} from "./session-participant-identity.js";
import type {
  RecordSessionParticipantResult,
  SessionParticipantRecordInput,
} from "./session-sharing-store.types.js";
export type { RecordSessionParticipantResult } from "./session-sharing-store.types.js";

export function recordSessionParticipant(
  scope: SessionAccessScope,
  params: SessionParticipantRecordInput,
): RecordSessionParticipantResult | null {
  // Native callers may open shared state here; keep that read before their agent transaction.
  return recordSessionParticipantWithAliasRead(scope, params, "before-transaction");
}

/** The sharing worker already holds its agent transaction when resolving profile aliases. */
export function recordSessionParticipantFromWorker(
  database: OpenClawAgentDatabase,
  scope: SessionAccessScope,
  params: SessionParticipantRecordInput,
): RecordSessionParticipantResult | null {
  return recordSessionParticipantWithAliasRead(scope, params, "on-miss", database);
}

function recordSessionParticipantWithAliasRead(
  scope: SessionAccessScope,
  params: SessionParticipantRecordInput,
  aliasRead: "before-transaction" | "on-miss",
  transaction?: OpenClawAgentDatabase,
): RecordSessionParticipantResult | null {
  const actorId = params.identity.id;
  if (!actorId || (params.identity.type === "agent" && actorId === params.sessionAgentId)) {
    return null;
  }
  const resolved = resolveSqliteScope(scope);
  const options = toDatabaseOptions(resolved);
  const promptedAt = params.promptedAt ?? Date.now();
  const namespace = participantIdentityNamespace(params.identity);
  const preparedAliases =
    aliasRead === "before-transaction" && params.identity.type === "profile"
      ? readUserProfileAliases(actorId, { env: scope.env })
      : undefined;
  const write = (database: OpenClawAgentDatabase): RecordSessionParticipantResult => {
    ensureSessionParticipantsSchema(database.db);
    const kysely = getSessionKysely(database.db);
    const participantQuery = kysely
      .selectFrom("session_participants")
      .select(["actor_id", "contribution_count", "first_prompted_at", "last_prompted_at"])
      .where("session_key", "=", resolved.sessionKey)
      .where("identity_namespace", "=", namespace);
    const exact = executeSqliteQueryTakeFirstSync(
      database.db,
      participantQuery.where("actor_id", "=", actorId),
    );
    // SQLite bindings replace lone surrogates; preserve the original JS identity comparison.
    let existing = exact?.actor_id === actorId ? exact : undefined;
    // Prefer the exact row, otherwise the first retained alias. Preserve raw history;
    // read-time canonicalization combines aliases without a cross-database rewrite.
    if (!existing && params.identity.type === "profile") {
      const aliases =
        aliasRead === "on-miss"
          ? readUserProfileAliases(actorId, { env: scope.env })
          : preparedAliases;
      if (aliases && aliases.size > 1) {
        existing = executeSqliteQuerySync(
          database.db,
          participantQuery.orderBy("actor_id"),
        ).rows.find((row) => aliases.has(row.actor_id));
      }
    }
    if (!existing) {
      const count = executeSqliteQueryTakeFirstSync(
        database.db,
        kysely
          .selectFrom("session_participants")
          .select((eb) => eb.fn.countAll<number>().as("count"))
          .where("session_key", "=", resolved.sessionKey),
      );
      if ((count?.count ?? 0) >= MAX_SESSION_PARTICIPANTS) {
        return "capped";
      }
    }
    const aggregate = mergeParticipantAggregate(
      existing,
      {
        contribution_count: 1,
        first_prompted_at: promptedAt,
        last_prompted_at: promptedAt,
      },
      "sum",
    );
    const writeGeneration = trackSessionEntryCacheWrite(database, () =>
      withSqliteDatabaseWriteScope(database.db, [resolved.sessionKey], () =>
        executeSqliteQuerySync(
          database.db,
          kysely
            .insertInto("session_participants")
            .values({
              session_key: resolved.sessionKey,
              identity_namespace: namespace,
              actor_id: existing?.actor_id ?? actorId,
              ...aggregate,
            })
            .onConflict((conflict) =>
              conflict
                .columns(["session_key", "identity_namespace", "actor_id"])
                .doUpdateSet(aggregate),
            ),
        ),
      ),
    );
    publishSessionEntryCacheParticipantUpdate(database, resolved.sessionKey, {
      writeGeneration,
      projectionChanged:
        !existing ||
        existing.actor_id !== actorId ||
        aggregate.first_prompted_at !== existing.first_prompted_at,
    });
    deferOpenClawAgentPostCommitPublication(database, () =>
      emitSessionLifecycleEvent({
        agentId: resolved.agentId,
        sessionKey: resolved.sessionKey,
        reason: "participants",
        scope: "session-entry",
      }),
    );
    return existing ? "updated" : "inserted";
  };
  if (transaction) {
    if (getOpenClawAgentDatabaseIfOpen(options) !== transaction || !transaction.db.isTransaction) {
      throw new Error("Session participant write lost its owning transaction");
    }
    assertTransactionUsable(transaction.db);
    const result = write(transaction);
    assertTransactionUsable(transaction.db);
    return result;
  }
  return runOpenClawAgentWriteTransaction(write, options, {
    operationLabel: "sessions.record-participant",
  });
}
