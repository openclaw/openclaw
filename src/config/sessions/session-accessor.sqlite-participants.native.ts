import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
} from "../../infra/kysely-sync.js";
import { emitSessionLifecycleEvent } from "../../sessions/session-lifecycle-events.js";
import {
  deferOpenClawAgentPostCommitPublication,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import {
  confirmSessionParticipantsSchemaEnsured,
  ensureSessionParticipantsSchema,
} from "../../state/openclaw-agent-session-participants-schema.js";
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
  type SessionParticipantIdentity,
} from "./session-participant-identity.js";

export type RecordSessionParticipantResult = "inserted" | "updated" | "capped";

export function recordSessionParticipant(
  scope: SessionAccessScope,
  params: {
    identity: SessionParticipantIdentity;
    promptedAt?: number;
    sessionAgentId?: string;
  },
): RecordSessionParticipantResult | null {
  const actorId = params.identity.id;
  if (!actorId || (params.identity.type === "agent" && actorId === params.sessionAgentId)) {
    return null;
  }
  const resolved = resolveSqliteScope(scope);
  const options = toDatabaseOptions(resolved);
  const promptedAt = params.promptedAt ?? Date.now();
  const namespace = participantIdentityNamespace(params.identity);
  const aliases =
    params.identity.type === "profile"
      ? readUserProfileAliases(actorId, { env: scope.env })
      : undefined;
  const result = runOpenClawAgentWriteTransaction(
    (database) => {
      if (ensureSessionParticipantsSchema(database.db)) {
        deferOpenClawAgentPostCommitPublication(database, () =>
          confirmSessionParticipantsSchemaEnsured(database.db),
        );
      }
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
      if (!existing && aliases && aliases.size > 1) {
        existing = executeSqliteQuerySync(
          database.db,
          participantQuery.orderBy("actor_id"),
        ).rows.find((row) => aliases.has(row.actor_id));
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
        }),
      );
      return existing ? "updated" : "inserted";
    },
    options,
    { operationLabel: "sessions.record-participant" },
  );
  return result;
}
