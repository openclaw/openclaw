import { randomUUID } from "node:crypto";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import {
  createSqliteQueryCache,
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  prepareSqliteQueryTakeFirstSync,
} from "../../infra/kysely-sync.js";
import {
  sqliteSessionIdWriteScope,
  withoutSqliteDatabaseWriteScope,
  withSqliteDatabaseWriteScope,
} from "../../infra/sqlite-database-admission.js";
import { coerceRequiredSqliteNumber as sqliteNumber } from "../../infra/sqlite-number.js";
import { getSqliteReadScopeRevision } from "../../infra/sqlite-schema-facts.js";
import { findOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import type { SessionTranscriptContextVersion } from "./session-accessor.sqlite-contract.js";
import { publishSessionEntryPlaceholderInsertion } from "./session-accessor.sqlite-entry-cache.js";
import { getSessionKysely, type ResolvedTranscriptScope } from "./session-accessor.sqlite-scope.js";
import { parseSessionEntryJson } from "./session-accessor.sqlite-status.js";
import { readSessionActorTransactionState } from "./session-actor-transaction.js";
import {
  assertCanonicalSqliteSessionRootWrite,
  canonicalSessionKeyMigrationRequiredError,
  markCanonicalSessionValidationPending,
} from "./session-canonical-key.js";
import {
  assertSessionTranscriptHot,
  readSessionColdTranscript,
  SessionTranscriptColdError,
} from "./session-cold-storage-state.js";
import {
  publishSessionTranscriptAuthority,
  type SessionTranscriptAuthority,
} from "./session-transcript-authority.js";
import {
  readTranscriptContextFacts,
  retainTranscriptContextFacts,
} from "./session-transcript-context-facts.js";
import {
  foldedSessionKeyAliasCandidates,
  normalizeStoreSessionKey,
  resolveDeliveryProvenCanonicalSessionKey,
} from "./store-entry.js";

const transcriptContextVersionQuery = createSqliteQueryCache((database) => {
  const db = getSessionKysely(database);
  return prepareSqliteQueryTakeFirstSync<
    string,
    SessionTranscriptContextVersion & { cold: number }
  >(database, (parameter) =>
    db
      .selectFrom("transcript_events")
      .select((eb) => [
        eb.fn
          .coalesce(
            eb
              .selectFrom("session_transcript_cold_archives")
              .select("last_seq")
              .where(
                "session_id",
                "=",
                parameter((sessionId) => sessionId),
              ),
            eb.fn.max<number | null>("seq"),
          )
          .as("rawSeq"),
        eb
          .selectFrom("transcript_rewrite_watermarks")
          .select("generation")
          .where(
            "session_id",
            "=",
            parameter((sessionId) => sessionId),
          )
          .as("generation"),
        eb
          .selectFrom("session_windows")
          .select("transcript_updated_at")
          .where(
            "session_id",
            "=",
            parameter((sessionId) => sessionId),
          )
          .as("updatedAt"),
        eb
          .exists(
            eb
              .selectFrom("session_transcript_cold_archives")
              .select("session_id")
              .where(
                "session_id",
                "=",
                parameter((sessionId) => sessionId),
              ),
          )
          .as("cold"),
      ])
      .where(
        "session_id",
        "=",
        parameter((sessionId) => sessionId),
      ),
  );
});

function readContextState(database: Pick<OpenClawAgentDatabase, "db">, sessionId: string) {
  const revision = getSqliteReadScopeRevision(database.db);
  const { cold, ...version } = transcriptContextVersionQuery(database.db)(sessionId)!;
  retainTranscriptContextFacts(database, sessionId, version, revision, Boolean(cold));
  return { version, cold: Boolean(cold) };
}

export function readTranscriptContextVersionInTransaction(
  database: Pick<OpenClawAgentDatabase, "db">,
  sessionId: string,
) {
  const actor = readSessionActorTransactionState(database, { sessionId });
  if (actor) {
    return { ...actor.hot.transcript.version };
  }
  return {
    ...(readTranscriptContextFacts(database, sessionId)?.version ??
      readContextState(database, sessionId).version),
  };
}

/** Preparation consumes cold presence and the matching version from one read phase. */
export function readTranscriptContextStateInTransaction(
  database: Pick<OpenClawAgentDatabase, "db">,
  sessionId: string,
) {
  const actor = readSessionActorTransactionState(database, { sessionId });
  if (actor) {
    return {
      coldArchive: actor.transcript.coldArchive,
      version: { ...actor.hot.transcript.version },
    };
  }
  const retained = readTranscriptContextFacts(database, sessionId);
  const state = retained?.cold === undefined ? readContextState(database, sessionId) : retained;
  return {
    coldArchive: state.cold ? readSessionColdTranscript(database.db, sessionId) : undefined,
    version: { ...state.version },
  };
}

function createTranscriptGeneration(): string {
  return randomUUID().replaceAll("-", "");
}

/** Read the current raw transcript generation inside the caller's transaction. */
export function readTranscriptGenerationInTransaction(
  database: OpenClawAgentDatabase,
  sessionId: string,
): string | undefined {
  const actor = readSessionActorTransactionState(database, { sessionId });
  if (actor) {
    return actor.hot.transcript.version.generation ?? undefined;
  }
  const db = getSessionKysely(database.db);
  return executeSqliteQueryTakeFirstSync(
    database.db,
    db
      .selectFrom("transcript_rewrite_watermarks")
      .select("generation")
      .where("session_id", "=", sessionId),
  )?.generation;
}

/** Materialize a generation once; pure appends must preserve an existing token. */
export function ensureTranscriptGenerationInTransaction(
  database: OpenClawAgentDatabase,
  sessionId: string,
): void {
  const actor = readSessionActorTransactionState(database, { sessionId });
  if (actor?.hot.transcript.version.generation) {
    return;
  }
  const generation = writeTranscriptGeneration(database, sessionId, false);
  if (actor) {
    actor.hot.transcript.version.generation = generation;
    actor.hot.transcript.watermark.generation = generation;
  }
}

/** Rotate the watermark in the same transaction as destructive transcript replacement. */
export function rotateTranscriptGenerationInTransaction(
  database: OpenClawAgentDatabase,
  sessionId: string,
): string {
  return writeTranscriptGeneration(database, sessionId, true);
}

function writeTranscriptGeneration(
  database: OpenClawAgentDatabase,
  sessionId: string,
  rotate: boolean,
): string {
  return withSqliteDatabaseWriteScope(database.db, [sqliteSessionIdWriteScope(sessionId)], () => {
    const db = getSessionKysely(database.db);
    const generation = createTranscriptGeneration();
    executeSqliteQuerySync(
      database.db,
      db
        .insertInto("transcript_rewrite_watermarks")
        .values({ session_id: sessionId, generation, updated_at: Date.now() })
        .onConflict((conflict) =>
          rotate
            ? conflict.column("session_id").doUpdateSet({ generation, updated_at: Date.now() })
            : conflict.column("session_id").doNothing(),
        ),
    );
    return generation;
  });
}

export function ensureTranscriptSessionRoot(
  database: OpenClawAgentDatabase,
  scope: ResolvedTranscriptScope,
  updatedAt: number,
  options: {
    allowStoredAlias?: boolean;
    onPlaceholderInserted?: (placeholder: { sessionKey: string; sessionId: string }) => void;
  } = {},
): void {
  return withSqliteDatabaseWriteScope(
    database.db,
    [scope.sessionKey, sqliteSessionIdWriteScope(scope.sessionId)],
    () => {
      const db = getSessionKysely(database.db);
      const actor = readSessionActorTransactionState(database, scope);
      if (actor?.window) {
        if (actor.window.session_key !== scope.sessionKey) {
          throw new Error("Session actor transcript window belongs to another logical owner");
        }
      } else {
        let nodeExists = false;
        if (!options.allowStoredAlias) {
          assertCanonicalSqliteSessionRootWrite(database, scope.sessionKey);
          const lookupKeys = uniqueStrings([
            scope.sessionKey,
            ...foldedSessionKeyAliasCandidates(normalizeStoreSessionKey(scope.sessionKey)),
          ]);
          const candidates = executeSqliteQuerySync(
            database.db,
            db
              .selectFrom("session_nodes")
              .select(["current_session_id", "entry_valid", "session_key", "updated_at"])
              .select("entry_json")
              .select((eb) =>
                eb
                  .selectFrom("session_windows")
                  .select("session_key")
                  .where("session_id", "=", scope.sessionId)
                  .as("persisted_session_key"),
              )
              .where("session_key", "in", lookupKeys),
          ).rows;
          // A retained window can outlive its node, so the empty-candidate case still reads its owner.
          const persistedSessionKey =
            candidates.length > 0
              ? candidates[0]!.persisted_session_key
              : executeSqliteQueryTakeFirstSync(
                  database.db,
                  db
                    .selectFrom("session_windows")
                    .select("session_key")
                    .where("session_id", "=", scope.sessionId),
                )?.session_key;
          if (persistedSessionKey && persistedSessionKey !== scope.sessionKey) {
            throw new Error(
              `Transcript session ${scope.sessionId} is owned by ${persistedSessionKey}, not ${scope.sessionKey}; resolve the transcript target again before retrying.`,
            );
          }
          let retainedRoot = false;
          for (const candidate of candidates) {
            const entry = parseSessionEntryJson(candidate, "list");
            if (!entry) {
              const retainedWindow =
                candidate.entry_json === "{}"
                  ? executeSqliteQueryTakeFirstSync(
                      database.db,
                      db
                        .selectFrom("session_windows")
                        .select("session_id")
                        .where("session_id", "=", candidate.current_session_id)
                        .where("session_key", "=", candidate.session_key),
                    )
                  : undefined;
              if (!retainedWindow) {
                throw canonicalSessionKeyMigrationRequiredError(
                  `invalid persisted session row requires repair for ${candidate.session_key}`,
                );
              }
              retainedRoot ||= candidate.session_key === scope.sessionKey;
              continue;
            }
            if (
              resolveDeliveryProvenCanonicalSessionKey(candidate.session_key, entry) !==
              candidate.session_key
            ) {
              throw canonicalSessionKeyMigrationRequiredError(
                `non-canonical persisted row resolves to session key ${candidate.session_key}`,
              );
            }
          }
          const existing = candidates.find(
            (candidate) => candidate.session_key === scope.sessionKey,
          );
          nodeExists = existing !== undefined;
          if (existing && existing.entry_valid !== 1 && !retainedRoot) {
            throw canonicalSessionKeyMigrationRequiredError(
              `invalid persisted session row requires repair for ${scope.sessionKey}`,
            );
          }
        }
        if (options.allowStoredAlias) {
          markCanonicalSessionValidationPending(database, [scope.sessionKey]);
        }
        if (!nodeExists) {
          const insertedNode = executeSqliteQuerySync(
            database.db,
            db
              .insertInto("session_nodes")
              .values({
                session_key: scope.sessionKey,
                current_session_id: scope.sessionId,
                entry_json: "{}",
                entry_valid: -1,
                updated_at: updatedAt,
              })
              .onConflict((conflict) => conflict.column("session_key").doNothing()),
          );
          if ((insertedNode.numAffectedRows ?? 0n) > 0n) {
            publishSessionEntryPlaceholderInsertion(database, {
              sessionKey: scope.sessionKey,
              sessionId: scope.sessionId,
            });
            withoutSqliteDatabaseWriteScope(database.db, () =>
              options.onPlaceholderInserted?.({
                sessionKey: scope.sessionKey,
                sessionId: scope.sessionId,
              }),
            );
          }
        }
      }
      executeSqliteQuerySync(
        database.db,
        db
          .insertInto("session_windows")
          .values({
            session_id: scope.sessionId,
            session_key: scope.sessionKey,
            previous_session_id: null,
            reason: null,
            session_scope: "conversation",
            created_at: updatedAt,
            updated_at: updatedAt,
          })
          .onConflict((conflict) =>
            conflict.column("session_id").doUpdateSet({
              updated_at: updatedAt,
            }),
          ),
      );
      if (actor?.window) {
        actor.window.updated_at = updatedAt;
      }
    },
  );
}

export function readNextTranscriptSeq(database: OpenClawAgentDatabase, sessionId: string): number {
  const actor = readSessionActorTransactionState(database, { sessionId });
  if (actor) {
    if (actor.transcript.coldArchive) {
      throw new SessionTranscriptColdError(sessionId);
    }
    return (actor.hot.transcript.version.rawSeq ?? -1) + 1;
  }
  const db = getSessionKysely(database.db);
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    db
      .selectFrom("transcript_events")
      .select((eb) => [
        eb.fn.max<number | bigint>("seq").as("max_seq"),
        eb
          .exists(
            eb
              .selectFrom("session_transcript_cold_archives")
              .select("session_id")
              .where("session_id", "=", sessionId),
          )
          .as("cold"),
      ])
      .where("session_id", "=", sessionId),
  );
  if (row?.cold) {
    throw new SessionTranscriptColdError(sessionId);
  }
  const maxSeq =
    row?.max_seq === null || row?.max_seq === undefined ? -1 : sqliteNumber(row.max_seq);
  return maxSeq + 1;
}

// Only compilation is retained; writer transactions must see their latest mutation fences.
const transcriptMutationStateQuery = createSqliteQueryCache((database) => {
  const db = getSessionKysely(database);
  return prepareSqliteQueryTakeFirstSync<
    string,
    { transcript_observed_at: number | null; transcript_updated_at: number | null }
  >(database, (parameter) =>
    db
      .selectFrom("session_windows")
      .select(["transcript_observed_at", "transcript_updated_at"])
      .where(
        "session_id",
        "=",
        parameter((sessionId) => sessionId),
      ),
  );
});

export function readTranscriptMutationStateInTransaction(
  database: Pick<OpenClawAgentDatabase, "db">,
  sessionId: string,
): { observedAt: number | null; updatedAt: number | null } {
  const actor = readSessionActorTransactionState(database, { sessionId });
  if (actor) {
    return {
      observedAt: actor.window?.transcript_observed_at ?? null,
      updatedAt: actor.window?.transcript_updated_at ?? null,
    };
  }
  const row = transcriptMutationStateQuery(database.db)(sessionId);
  return {
    observedAt: row?.transcript_observed_at ?? null,
    updatedAt: row?.transcript_updated_at ?? null,
  };
}

export function advanceTranscriptMutationAtInTransaction(
  database: OpenClawAgentDatabase,
  sessionId: string,
  value: number,
  options: { strictly?: boolean } = {},
): void {
  return withSqliteDatabaseWriteScope(database.db, [sqliteSessionIdWriteScope(sessionId)], () => {
    let transcriptUpdatedAt = Math.floor(value);
    if (!Number.isFinite(transcriptUpdatedAt) || transcriptUpdatedAt < 0) {
      return;
    }
    if (!options.strictly) {
      const state = readTranscriptMutationStateInTransaction(database, sessionId);
      transcriptUpdatedAt = Math.max(transcriptUpdatedAt, state.updatedAt ?? 0);
      if (state.updatedAt !== null && state.updatedAt >= transcriptUpdatedAt) {
        return;
      }
    }
    const db = getSessionKysely(database.db);
    const actor = readSessionActorTransactionState(database, { sessionId });
    if (actor?.window && options.strictly) {
      transcriptUpdatedAt = Math.max(
        transcriptUpdatedAt,
        (actor.window.transcript_updated_at ?? -1) + 1,
        (actor.window.transcript_observed_at ?? -1) + 1,
      );
    }
    const update = db
      .updateTable("session_windows")
      .set((eb) => ({
        transcript_updated_at:
          options.strictly && !actor?.window
            ? eb.fn<number>("max", [
                eb.val(transcriptUpdatedAt),
                eb(eb.fn.coalesce("transcript_updated_at", eb.val(-1)), "+", 1),
                eb(eb.fn.coalesce("transcript_observed_at", eb.val(-1)), "+", 1),
              ])
            : transcriptUpdatedAt,
      }))
      .where("session_id", "=", sessionId);
    if (!findOpenClawAgentDatabaseIdentity(database)) {
      executeSqliteQuerySync(database.db, update);
      return;
    }
    if (actor?.window) {
      executeSqliteQuerySync(database.db, update);
      actor.window.transcript_updated_at = transcriptUpdatedAt;
      actor.hot.transcript.version.updatedAt = transcriptUpdatedAt;
      const projection = actor.transcript.projection;
      publishSessionTranscriptAuthority(database, {
        ...actor.hot.transcript.version,
        sessionId,
        sessionKey: actor.hot.target.sessionKey,
        leafEventId: projection?.leafEventId ?? null,
        indexedSeq: projection?.indexedSeq ?? null,
        activeMessageCount: projection?.activeMessageCount ?? null,
        needsRebuild: projection ? (projection.needsRebuild ? 1 : 0) : null,
      });
      return;
    }
    const context = executeSqliteQueryTakeFirstSync(
      database.db,
      update
        .returning((eb) => [
          "session_id as sessionId",
          "session_key as sessionKey",
          "transcript_updated_at as updatedAt",
          eb
            .selectFrom("transcript_rewrite_watermarks")
            .select("generation")
            .where("session_id", "=", sessionId)
            .as("generation"),
          eb.fn
            .coalesce(
              eb
                .selectFrom("session_transcript_cold_archives")
                .select("last_seq")
                .where("session_id", "=", sessionId),
              eb
                .selectFrom("transcript_events")
                .select((inner) => inner.fn.max<number | null>("seq").as("seq"))
                .where("session_id", "=", sessionId),
            )
            .as("rawSeq"),
          eb
            .selectFrom("session_transcript_index_state")
            .select("leaf_event_id")
            .where("session_id", "=", sessionId)
            .as("leafEventId"),
          eb
            .selectFrom("session_transcript_index_state")
            .select("indexed_seq")
            .where("session_id", "=", sessionId)
            .as("indexedSeq"),
          eb
            .selectFrom("session_transcript_index_state")
            .select("active_message_count")
            .where("session_id", "=", sessionId)
            .as("activeMessageCount"),
          eb
            .selectFrom("session_transcript_index_state")
            .select("needs_rebuild")
            .where("session_id", "=", sessionId)
            .as("needsRebuild"),
        ])
        .$assertType<SessionTranscriptAuthority>(),
    );
    if (context) {
      retainTranscriptContextFacts(
        database,
        sessionId,
        {
          generation: context.generation,
          rawSeq: context.rawSeq,
          updatedAt: context.updatedAt,
        },
        getSqliteReadScopeRevision(database.db),
      );
      publishSessionTranscriptAuthority(database, context);
    }
  });
}

export function touchTranscriptMutationInTransaction(
  database: OpenClawAgentDatabase,
  sessionId: string,
): void {
  advanceTranscriptMutationAtInTransaction(database, sessionId, Date.now(), { strictly: true });
}

export function deleteTranscriptEventsInTransaction(
  database: OpenClawAgentDatabase,
  sessionId: string,
): boolean {
  return withSqliteDatabaseWriteScope(database.db, [sqliteSessionIdWriteScope(sessionId)], () => {
    assertSessionTranscriptHot(database.db, sessionId);
    const db = getSessionKysely(database.db);
    executeSqliteQuerySync(
      database.db,
      db.deleteFrom("transcript_event_identities").where("session_id", "=", sessionId),
    );
    const result = executeSqliteQuerySync(
      database.db,
      db.deleteFrom("transcript_events").where("session_id", "=", sessionId),
    );
    return (result.numAffectedRows ?? 0n) > 0n;
  });
}

export function pruneTranscriptReactionsInTransaction(
  database: OpenClawAgentDatabase,
  scope: ResolvedTranscriptScope,
  removedEventIds?: readonly string[],
): void {
  return withSqliteDatabaseWriteScope(
    database.db,
    [scope.sessionKey, sqliteSessionIdWriteScope(scope.sessionId)],
    () => {
      const db = getSessionKysely(database.db);
      const query = db
        .deleteFrom("session_reactions")
        .where("session_key", "=", scope.sessionKey)
        .where("session_id", "=", scope.sessionId)
        .where((eb) =>
          eb.not(
            eb.exists(
              eb
                .selectFrom("transcript_event_identities")
                .select("event_id")
                .whereRef("session_id", "=", "session_reactions.session_id")
                .whereRef("event_id", "=", "session_reactions.message_id"),
            ),
          ),
        );
      if (removedEventIds === undefined) {
        executeSqliteQuerySync(database.db, query);
        return;
      }
      // A suffix rewrite must not prune a retained, legacy unindexed prefix.
      for (let start = 0; start < removedEventIds.length; start += 500) {
        executeSqliteQuerySync(
          database.db,
          query.where("message_id", "in", removedEventIds.slice(start, start + 500)),
        );
      }
    },
  );
}
