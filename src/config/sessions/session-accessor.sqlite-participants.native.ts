import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
} from "../../infra/kysely-sync.js";
import { withSqliteDatabaseWriteScope } from "../../infra/sqlite-database-admission.js";
import { assertTransactionUsable } from "../../infra/sqlite-transaction.js";
import { emitSessionLifecycleEvent } from "../../sessions/session-lifecycle-events.js";
import {
  deferOpenClawAgentPostCommitPublication,
  runOpenClawAgentWriteTransaction,
  type OpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { ensureSessionParticipantsSchema } from "../../state/openclaw-agent-session-participants-schema.js";
import { readUserProfileAliases } from "../../state/user-profile-list.js";
import { readUserProfileAliasesNative } from "../../state/user-profile-list.native.js";
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
  return recordSessionParticipantWithAliasRead(scope, params, () =>
    readUserProfileAliases(params.identity.id, { env: scope.env }),
  );
}

/** The sharing worker already holds its agent transaction when resolving profile aliases. */
export function recordSessionParticipantFromWorker(
  database: OpenClawAgentDatabase,
  scope: SessionAccessScope,
  params: SessionParticipantRecordInput,
): RecordSessionParticipantResult | null {
  return recordSessionParticipantWithAliasRead(
    scope,
    params,
    () => readUserProfileAliasesNative(params.identity.id, { env: scope.env }),
    database,
  );
}

function recordSessionParticipantWithAliasRead(
  scope: SessionAccessScope,
  params: SessionParticipantRecordInput,
  readAliases: () => ReadonlySet<string> | undefined,
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
      const aliases = readAliases();
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
    assertTransactionUsable(transaction.db);
    return write(transaction);
  }
  return runOpenClawAgentWriteTransaction(write, options, {
    operationLabel: "sessions.record-participant",
  });
}
