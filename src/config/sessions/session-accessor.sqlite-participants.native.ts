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
import {
  prepareSessionActorParticipantUpdate,
  readSessionActorParticipants,
} from "./session-actor-entry-publication.worker.js";
import { MAX_SESSION_PARTICIPANTS } from "./session-entry-provenance.js";
import {
  participantIdentityNamespace,
  mergeParticipantAggregate,
  readParticipantIdentity,
} from "./session-participant-identity.js";
import type {
  RecordSessionParticipantResult,
  SessionParticipantRecordInput,
} from "./session-sharing-store.types.js";
export type { RecordSessionParticipantResult } from "./session-sharing-store.types.js";

type SessionParticipantWriteResult = {
  value: RecordSessionParticipantResult | null;
  projectionChanged: boolean;
};

export function recordSessionParticipant(
  scope: SessionAccessScope,
  params: SessionParticipantRecordInput,
): RecordSessionParticipantResult | null {
  return recordSessionParticipantWithAliasRead(scope, params, () =>
    readUserProfileAliases(params.identity.id, { env: scope.env }),
  ).value;
}

/** The sharing worker already holds its agent transaction when resolving profile aliases. */
export function recordSessionParticipantFromWorker(
  database: OpenClawAgentDatabase,
  scope: SessionAccessScope,
  params: SessionParticipantRecordInput,
): SessionParticipantWriteResult {
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
): SessionParticipantWriteResult {
  const actorId = params.identity.id;
  if (!actorId || (params.identity.type === "agent" && actorId === params.sessionAgentId)) {
    return { value: null, projectionChanged: false };
  }
  const resolved = resolveSqliteScope(scope);
  const options = toDatabaseOptions(resolved);
  const promptedAt = params.promptedAt ?? Date.now();
  const namespace = participantIdentityNamespace(params.identity);
  const write = (database: OpenClawAgentDatabase): SessionParticipantWriteResult => {
    ensureSessionParticipantsSchema(database.db);
    const kysely = getSessionKysely(database.db);
    const participants = readSessionActorParticipants(database, resolved.sessionKey);
    const publishActor = prepareSessionActorParticipantUpdate(database, resolved.sessionKey);
    const retainedRows = participants?.map((participant) => ({
      actor_id: participant.identity.id,
      identity_namespace: participantIdentityNamespace(participant.identity),
      contribution_count: participant.contributionCount,
      first_prompted_at: participant.firstPromptedAt,
      last_prompted_at: participant.lastPromptedAt,
    }));
    const participantQuery = kysely
      .selectFrom("session_participants")
      .select(["actor_id", "contribution_count", "first_prompted_at", "last_prompted_at"])
      .where("session_key", "=", resolved.sessionKey)
      .where("identity_namespace", "=", namespace);
    const exact = retainedRows
      ? retainedRows.find((row) => row.actor_id === actorId && row.identity_namespace === namespace)
      : executeSqliteQueryTakeFirstSync(
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
        existing = (
          retainedRows
            ? retainedRows
                .filter((row) => row.identity_namespace === namespace)
                .toSorted((a, b) =>
                  Buffer.compare(Buffer.from(a.actor_id), Buffer.from(b.actor_id)),
                )
            : executeSqliteQuerySync(database.db, participantQuery.orderBy("actor_id")).rows
        ).find((row) => aliases.has(row.actor_id));
      }
    }
    if (!existing) {
      const count = participants
        ? participants.length
        : (executeSqliteQueryTakeFirstSync(
            database.db,
            kysely
              .selectFrom("session_participants")
              .select((eb) => eb.fn.countAll<number>().as("count"))
              .where("session_key", "=", resolved.sessionKey),
          )?.count ?? 0);
      if (count >= MAX_SESSION_PARTICIPANTS) {
        return { value: "capped", projectionChanged: false };
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
    const projectionChanged =
      !existing ||
      existing.actor_id !== actorId ||
      aggregate.first_prompted_at !== existing.first_prompted_at;
    if (participants && publishActor) {
      const identity = readParticipantIdentity(
        namespace,
        existing?.actor_id ?? actorId.toWellFormed(),
      );
      publishActor([
        ...participants.filter(
          (participant) =>
            participant.identity.id !== identity.id ||
            participantIdentityNamespace(participant.identity) !== namespace,
        ),
        {
          identity,
          contributionCount: aggregate.contribution_count,
          firstPromptedAt: aggregate.first_prompted_at,
          lastPromptedAt: aggregate.last_prompted_at,
        },
      ]);
    }
    publishSessionEntryCacheParticipantUpdate(database, resolved.sessionKey, {
      writeGeneration,
      projectionChanged,
    });
    deferOpenClawAgentPostCommitPublication(database, () =>
      emitSessionLifecycleEvent({
        agentId: resolved.agentId,
        sessionKey: resolved.sessionKey,
        reason: "participants",
        scope: "session-entry",
      }),
    );
    return { value: existing ? "updated" : "inserted", projectionChanged };
  };
  if (transaction) {
    assertTransactionUsable(transaction.db);
    return write(transaction);
  }
  return runOpenClawAgentWriteTransaction(write, options, {
    operationLabel: "sessions.record-participant",
  });
}
