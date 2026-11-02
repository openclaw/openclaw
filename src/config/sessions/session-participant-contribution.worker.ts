import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import { withSqliteDatabaseWriteScope } from "../../infra/sqlite-database-admission.js";
import { stageSqliteTransactionState } from "../../infra/sqlite-post-commit.js";
import { emitSessionLifecycleEvent } from "../../sessions/session-lifecycle-events.js";
import {
  deferOpenClawAgentPostCommitPublication,
  type OpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import type { SessionAccessScope } from "./session-accessor.sqlite-contract.js";
import { sessionEntryCaches } from "./session-accessor.sqlite-entry-cache-state.js";
import {
  prepareSessionEntryCacheWrite,
  publishSessionEntryCacheParticipantUpdate,
} from "./session-accessor.sqlite-entry-cache.js";
import { getSessionKysely, resolveSqliteScope } from "./session-accessor.sqlite-scope.js";
import {
  prepareSessionActorParticipantUpdate,
  readSessionActorParticipants,
} from "./session-actor-entry-publication.worker.js";
import {
  mergeParticipantAggregate,
  participantIdentityNamespace,
} from "./session-participant-identity.js";
import type { SessionParticipantRecordInput } from "./session-sharing-store.types.js";

/** A resident contribution changes one row; aliases, new participants and reordering keep the transaction. */
export function prepareSessionParticipantContribution(
  database: OpenClawAgentDatabase,
  scope: SessionAccessScope,
  params: SessionParticipantRecordInput,
) {
  const resolved = resolveSqliteScope(scope);
  const participants = readSessionActorParticipants(database, resolved.sessionKey);
  const namespace = participantIdentityNamespace(params.identity);
  const existing = participants?.find(
    (participant) =>
      participant.identity.id === params.identity.id &&
      participantIdentityNamespace(participant.identity) === namespace,
  );
  if (
    !participants ||
    !existing ||
    (params.identity.type === "agent" && params.identity.id === params.sessionAgentId)
  ) {
    return undefined;
  }
  const promptedAt = params.promptedAt ?? Date.now();
  const aggregate = mergeParticipantAggregate(
    {
      contribution_count: existing.contributionCount,
      first_prompted_at: existing.firstPromptedAt,
      last_prompted_at: existing.lastPromptedAt,
    },
    { contribution_count: 1, first_prompted_at: promptedAt, last_prompted_at: promptedAt },
    "sum",
  );
  if (aggregate.first_prompted_at !== existing.firstPromptedAt) {
    return undefined;
  }
  const publishActor = prepareSessionActorParticipantUpdate(database, resolved.sessionKey, true);
  if (!publishActor) {
    return undefined;
  }
  const updated = participants.map((participant) =>
    participant === existing
      ? {
          identity: participant.identity,
          contributionCount: aggregate.contribution_count,
          firstPromptedAt: aggregate.first_prompted_at,
          lastPromptedAt: aggregate.last_prompted_at,
        }
      : participant,
  );
  const query = getSessionKysely(database.db)
    .insertInto("session_participants")
    .values({
      session_key: resolved.sessionKey,
      identity_namespace: namespace,
      actor_id: existing.identity.id,
      ...aggregate,
    })
    .onConflict((conflict) =>
      conflict.columns(["session_key", "identity_namespace", "actor_id"]).doUpdateSet(aggregate),
    );
  const completeCacheWrite = prepareSessionEntryCacheWrite(database);
  return {
    result: {
      value: "updated" as const,
      projectionChanged: false,
      participants: {},
      records: updated,
      actorVersion: publishActor.version,
    },
    stage() {
      publishActor.publish(updated);
      stageSqliteTransactionState(database.db, {
        commit() {
          publishSessionEntryCacheParticipantUpdate(database, resolved.sessionKey, {
            writeGeneration: completeCacheWrite(),
            projectionChanged: false,
          });
        },
        invalidate: () => sessionEntryCaches.delete(database.db),
      });
      deferOpenClawAgentPostCommitPublication(database, () =>
        emitSessionLifecycleEvent({
          agentId: resolved.agentId,
          sessionKey: resolved.sessionKey,
          reason: "participants",
          scope: "session-entry",
        }),
      );
    },
    statement: () =>
      withSqliteDatabaseWriteScope(database.db, [resolved.sessionKey], () =>
        executeSqliteQuerySync(database.db, query),
      ),
  };
}
