import fs from "node:fs";
/**
 * Reclaims expired cron-run retained-history placeholders.
 *
 * Eligibility follows `cron.sessionRetention`. Transcript state is archived
 * before deletion; archive lifetime remains owned by existing archive policy.
 */
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  sqliteStringSet,
} from "../../infra/kysely-sync.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { normalizeAgentId, parseAgentSessionKey } from "../../routing/session-key.js";
import { isCronRunSessionKey } from "../../sessions/session-key-utils.js";
import { runExclusiveSessionLifecycleMutation } from "../../sessions/session-lifecycle-admission.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
  type OpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { publishSessionStateArchives } from "./session-accessor.sqlite-archive-store.js";
import { materializeSessionStateDeletePlans } from "./session-accessor.sqlite-archive.js";
import { publishSessionEntryCacheInvalidation } from "./session-accessor.sqlite-entry-cache.js";
import { emitArchivedTranscriptUpdates } from "./session-accessor.sqlite-events.js";
import {
  deleteMaterializedSessionStatePlans,
  planSessionStateDeleteIfUnreferenced,
  readReferencedSessionIds,
  withBatchedSessionReferenceAnalysis,
} from "./session-accessor.sqlite-lifecycle-state.js";
import { deleteSessionNodeArtifacts } from "./session-accessor.sqlite-node-artifacts.js";
import { runExclusiveSqliteSessionReclamation } from "./session-accessor.sqlite-reclamation.js";
import {
  getSessionKysely,
  resolveSqliteTranscriptArchiveDirectory,
  runExclusiveSqliteSessionWrite,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import { isCanonicalSqliteRetainedHistoryPlaceholder } from "./session-canonical-key.js";
import { collectAdmissionProtectedCandidateSessionIds } from "./session-history-eviction.admission-scope.js";
import { resolveSqliteTargetFromSessionStorePath } from "./session-sqlite-target.js";
import type { SessionStoreTarget } from "./targets-collision.js";

const log = createSubsystemLogger("cleanup-tombstones");

export type SessionTombstoneSweepResult = {
  /** Canonical expired cron-run placeholders at scan time. */
  candidates: number;
  /** Node rows deleted (0 on dry runs). */
  removedNodes: number;
  /** Transcript generations deleted after durable extraction. */
  sweptTranscriptStates: number;
  olderThanMs: number;
};

/**
 * Candidates whose reference analysis shares one pass over the store.
 *
 * Bounded so the narrowed predicate stays small and so the memo it fills holds
 * at most this many ids; a larger batch buys progressively less because the pass
 * is already amortized away from the per-candidate cost.
 */
const TOMBSTONE_REFERENCE_BATCH_SIZE = 32;

/**
 * Candidates reclaimed before each unbatched post-delete verification pass.
 *
 * The batched fast path above trades a rare miss window (see
 * session-accessor.sqlite-reference-batch.ts) for amortized cost; this bounds
 * that window's blast radius instead of trusting the fast path for the whole
 * outer batch. Kept at or under readReferencedSessionIds' own narrowed-query
 * threshold (16 ids) so each verification stays a cheap indexed lookup, not a
 * full scan.
 */
const TOMBSTONE_VERIFICATION_GROUP_SIZE = 8;

type TombstoneCandidate = {
  currentSessionId: string;
  generationIds: string[];
  sessionKey: string;
  updatedAt: number;
};

/**
 * Lists expired cron-run placeholder rows.
 *
 * Only canonical retained-history placeholders qualify. Live sessions,
 * unidentified rows, non-cron rows, and anything inside the retention window
 * stay untouched.
 *
 * `sessionKeys` restricts both reads to named keys. The scan that builds the
 * candidate list omits it and enumerates the store once; per-candidate
 * revalidation passes the one key it is about to act on, so apply work stays
 * proportional to the candidates instead of to the store size per candidate.
 */
function listCanonicalCronRunTombstones(
  database: Pick<OpenClawAgentDatabase, "db">,
  cutoffMs: number,
  requestedOwners: ReadonlySet<string>,
  sessionKeys?: readonly string[],
): TombstoneCandidate[] {
  const db = getSessionKysely(database.db);
  const nodes = executeSqliteQuerySync(
    database.db,
    db
      .selectFrom("session_nodes")
      .leftJoin("session_windows as retained_window", (join) =>
        join
          .onRef("retained_window.session_id", "=", "session_nodes.current_session_id")
          .onRef("retained_window.session_key", "=", "session_nodes.session_key"),
      )
      .select([
        "session_nodes.session_key",
        "session_nodes.current_session_id",
        "session_nodes.entry_json",
        "session_nodes.entry_valid",
        "session_nodes.updated_at",
        "retained_window.session_id as retained_window_id",
      ])
      .$if(sessionKeys !== undefined, (builder) =>
        builder.where("session_nodes.session_key", "in", sqliteStringSet(sessionKeys ?? [])),
      ),
  ).rows;
  const windows = executeSqliteQuerySync(
    database.db,
    db
      .selectFrom("session_windows")
      .select(["session_id", "session_key", "updated_at"])
      .$if(sessionKeys !== undefined, (builder) =>
        builder.where("session_key", "in", sqliteStringSet(sessionKeys ?? [])),
      ),
  ).rows;
  const windowsByKey = new Map<string, Array<{ sessionId: string; updatedAt: number }>>();
  for (const window of windows) {
    const owned = windowsByKey.get(window.session_key) ?? [];
    owned.push({ sessionId: window.session_id, updatedAt: window.updated_at });
    windowsByKey.set(window.session_key, owned);
  }
  return nodes.flatMap((node) => {
    const ownedWindows = windowsByKey.get(node.session_key) ?? [];
    const updatedAt = Math.max(node.updated_at, ...ownedWindows.map((window) => window.updatedAt));
    if (!isCronRunSessionKey(node.session_key) || updatedAt >= cutoffMs) {
      return [];
    }
    const scopedOwner = parseAgentSessionKey(node.session_key)?.agentId;
    if (!scopedOwner || !requestedOwners.has(normalizeAgentId(scopedOwner))) {
      return [];
    }
    if (!isCanonicalSqliteRetainedHistoryPlaceholder(node)) {
      return [];
    }
    return [
      {
        currentSessionId: node.current_session_id,
        generationIds: ownedWindows.map((window) => window.sessionId).toSorted(),
        sessionKey: node.session_key,
        updatedAt,
      },
    ];
  });
}

/**
 * Re-reads one candidate's current state with key-narrowed queries.
 *
 * The `find` stays so membership is decided by exact JS key equality rather than
 * by SQLite text comparison. A key SQLite does not match therefore yields
 * `undefined`, which `sameCandidate` rejects and the caller treats as "skip this
 * candidate" — narrowing can only abandon a delete, never authorize one.
 */
function findCanonicalCronRunTombstone(
  database: Pick<OpenClawAgentDatabase, "db">,
  cutoffMs: number,
  requestedOwners: ReadonlySet<string>,
  sessionKey: string,
): TombstoneCandidate | undefined {
  return listCanonicalCronRunTombstones(database, cutoffMs, requestedOwners, [sessionKey]).find(
    (entry) => entry.sessionKey === sessionKey,
  );
}

function sameCandidate(left: TombstoneCandidate, right: TombstoneCandidate | undefined): boolean {
  return (
    right !== undefined &&
    left.currentSessionId === right.currentSessionId &&
    left.sessionKey === right.sessionKey &&
    left.updatedAt === right.updatedAt &&
    left.generationIds.length === right.generationIds.length &&
    left.generationIds.every((sessionId, index) => sessionId === right.generationIds[index])
  );
}

/**
 * Ids still held by something other than this placeholder, narrowed to the
 * generations the placeholder owns.
 *
 * Both consumers only ask about those generations —
 * `planSessionStateDeleteIfUnreferenced` tests `plan.sessionId`, and
 * `deleteMaterializedSessionStatePlans` tests the same ids — so restricting the
 * set cannot change a decision, and it lets every read be bounded. One read
 * covers every generation the placeholder owns: the narrowed reference predicate
 * takes an id set, so a multi-generation placeholder no longer costs one pass per
 * generation. The admission probe uses its candidate-scoped form.
 */
function readProtectedSessionIds(params: {
  candidate: TombstoneCandidate;
  database: OpenClawAgentDatabase;
  storePath: string;
}): Set<string> {
  const excludedSessionKeys = new Set([params.candidate.sessionKey]);
  const protectedSessionIds = new Set(
    readReferencedSessionIds(params.database, excludedSessionKeys, params.candidate.generationIds),
  );
  for (const sessionId of collectAdmissionProtectedCandidateSessionIds({
    candidateSessionIds: params.candidate.generationIds,
    candidateSessionKey: params.candidate.sessionKey,
    database: params.database,
    storePath: params.storePath,
  })) {
    protectedSessionIds.add(sessionId);
  }
  return protectedSessionIds;
}

/**
 * A candidate's full `session_nodes` row and every `session_windows` row it
 * owns, captured before a reclaim touches either. `selectAll()` rather than a
 * named column list deliberately: a snapshot that only knew the columns this
 * file cares about would restore an incomplete row if the schema has grown
 * columns since, silently dropping data on the one path meant to put it back
 * exactly as found.
 */
type ReclaimedRowSnapshot = {
  sessionKey: string;
  node: Record<string, unknown>;
  windows: Record<string, unknown>[];
};

function captureReclaimedRowSnapshot(
  database: OpenClawAgentDatabase,
  sessionKey: string,
): ReclaimedRowSnapshot | undefined {
  const db = getSessionKysely(database.db);
  const node = executeSqliteQueryTakeFirstSync(
    database.db,
    db.selectFrom("session_nodes").selectAll().where("session_key", "=", sessionKey),
  );
  if (!node) {
    return undefined;
  }
  const windows = executeSqliteQuerySync(
    database.db,
    db.selectFrom("session_windows").selectAll().where("session_key", "=", sessionKey),
  ).rows;
  return { sessionKey, node, windows };
}

/**
 * Re-inserts a snapshot taken before a reclaim, undoing that reclaim's delete.
 *
 * Only ever called immediately after a post-delete verification proves the
 * candidate was live at the moment it was removed -- the row did not change in
 * between (nothing else could have written a `session_nodes` row back under
 * the same primary key without first recreating the placeholder, which the
 * verification query would itself have counted as a live reference), so
 * replaying the exact captured columns reproduces the pre-delete state, not an
 * approximation of it.
 */
function restoreReclaimedRowSnapshot(
  database: OpenClawAgentDatabase,
  snapshot: ReclaimedRowSnapshot,
): void {
  const db = getSessionKysely(database.db);
  executeSqliteQuerySync(
    database.db,
    db
      .insertInto("session_nodes")
      .values(snapshot.node as never)
      .onConflict((oc) => oc.column("session_key").doNothing()),
  );
  for (const window of snapshot.windows) {
    executeSqliteQuerySync(
      database.db,
      db
        .insertInto("session_windows")
        .values(window as never)
        .onConflict((oc) => oc.column("session_id").doNothing()),
    );
  }
}

/**
 * Archives and removes expired canonical cron-run placeholders and their
 * unshared state.
 *
 */
async function sweepTombstonedCronRunRemnants(params: {
  requestedOwners: ReadonlySet<string>;
  databaseAgentId: string;
  storePath: string;
  sqlitePath: string;
  olderThanMs: number;
  dryRun: boolean;
  nowMs?: number;
}): Promise<SessionTombstoneSweepResult> {
  const nowMs = params.nowMs ?? Date.now();
  const olderThanMs = Math.max(params.olderThanMs, 0);
  const cutoffMs = nowMs - olderThanMs;
  const scope = { agentId: params.databaseAgentId, path: params.sqlitePath };
  const empty: SessionTombstoneSweepResult = {
    candidates: 0,
    removedNodes: 0,
    sweptTranscriptStates: 0,
    olderThanMs,
  };
  const scanned = withOpenClawAgentDatabaseReadOnly(
    (database) => listCanonicalCronRunTombstones(database, cutoffMs, params.requestedOwners),
    scope,
  );
  const candidates = scanned.found ? scanned.value : [];
  if (params.dryRun || candidates.length === 0) {
    return {
      ...empty,
      candidates: candidates.length,
    };
  }

  let removedNodes = 0;
  let sweptTranscriptStates = 0;
  const reclaim = async (candidate: TombstoneCandidate): Promise<boolean> => {
    const result = await runExclusiveSessionLifecycleMutation({
      scope: params.storePath,
      identities: [candidate.sessionKey, ...candidate.generationIds],
      run: async () => {
        const plans = await runExclusiveSqliteSessionWrite(
          scope,
          async () => {
            const database = openOpenClawAgentDatabase(toDatabaseOptions(scope));
            const authoritative = findCanonicalCronRunTombstone(
              database,
              cutoffMs,
              params.requestedOwners,
              candidate.sessionKey,
            );
            if (!sameCandidate(candidate, authoritative)) {
              return null;
            }
            const protectedSessionIds = readProtectedSessionIds({
              candidate,
              database,
              storePath: params.storePath,
            });
            if (candidate.generationIds.some((sessionId) => protectedSessionIds.has(sessionId))) {
              return null;
            }
            const archiveDirectory = resolveSqliteTranscriptArchiveDirectory(scope);
            const prepared = candidate.generationIds.flatMap((sessionId) => {
              const plan = planSessionStateDeleteIfUnreferenced({
                archiveDirectory,
                archiveTranscript: true,
                database,
                reason: "deleted",
                referencedSessionIds: protectedSessionIds,
                sessionId,
              });
              return plan ? [plan] : [];
            });
            return prepared.length === candidate.generationIds.length ? prepared : null;
          },
          "session.maintenance.tombstone-prepare",
        );
        if (!plans) {
          return null;
        }
        // Archive materialization is the expensive phase, so it runs between two
        // short writer-lane sections rather than inside one long hold: the store
        // writer queue is process-local and FIFO, so holding it across encoding
        // would make every unrelated session write in this process wait for a
        // transcript that is being encoded off-thread. The candidate itself stays
        // fenced by lifecycle admission across the release, and nothing decided
        // above is trusted afterwards — the deletion transaction re-reads the
        // placeholder and its references before touching a row. Reclamation
        // admission bounds materialized archive bytes through their commit, the
        // same way history eviction and lifecycle deletion already do.
        return await runExclusiveSqliteSessionReclamation(async () => {
          const materialized = await materializeSessionStateDeletePlans(plans);
          return await runExclusiveSqliteSessionWrite(
            scope,
            async () => {
              let archivedTranscripts: ReturnType<typeof deleteMaterializedSessionStatePlans> = [];
              let removed = false;
              runOpenClawAgentWriteTransaction(
                (transactionDb) => {
                  const current = findCanonicalCronRunTombstone(
                    transactionDb,
                    cutoffMs,
                    params.requestedOwners,
                    candidate.sessionKey,
                  );
                  if (!sameCandidate(candidate, current)) {
                    return;
                  }
                  const protectedAtDelete = readProtectedSessionIds({
                    candidate,
                    database: transactionDb,
                    storePath: params.storePath,
                  });
                  if (
                    candidate.generationIds.some((sessionId) => protectedAtDelete.has(sessionId))
                  ) {
                    return;
                  }
                  archivedTranscripts = deleteMaterializedSessionStatePlans(
                    transactionDb,
                    materialized,
                    protectedAtDelete,
                    new Set([candidate.sessionKey]),
                  );
                  const db = getSessionKysely(transactionDb.db);
                  const remainingGenerationIds = executeSqliteQuerySync(
                    transactionDb.db,
                    db
                      .selectFrom("session_windows")
                      .select("session_id")
                      .where("session_key", "=", candidate.sessionKey),
                  ).rows;
                  if (remainingGenerationIds.length > 0) {
                    return;
                  }
                  // This row is an intentionally empty retained-history placeholder,
                  // not a readable SessionEntry. Its owned windows were removed above,
                  // so delete only the node-owned artifacts and placeholder row.
                  deleteSessionNodeArtifacts(transactionDb, candidate.sessionKey);
                  executeSqliteQuerySync(
                    transactionDb.db,
                    db.deleteFrom("session_nodes").where("session_key", "=", candidate.sessionKey),
                  );
                  publishSessionEntryCacheInvalidation(transactionDb, {
                    sessionKey: candidate.sessionKey,
                  });
                  removed =
                    executeSqliteQuerySync(
                      transactionDb.db,
                      db
                        .selectFrom("session_nodes")
                        .select("session_key")
                        .where("session_key", "=", candidate.sessionKey),
                    ).rows.length === 0;
                },
                scope,
                { operationLabel: "sessions.cleanup.tombstoned-cron-run-remnants" },
              );
              if (!removed) {
                return null;
              }
              return {
                archivedTranscripts,
                sweptTranscriptStates: candidate.generationIds.length,
              };
            },
            "session.maintenance.tombstone-commit",
          );
        });
      },
    });
    if (!result) {
      return false;
    }
    // The lifecycle and SQLite writer lanes are released before file I/O;
    // publication reacquires the writer only for its short status commit.
    const publishedArchives = await publishSessionStateArchives(scope, result.archivedTranscripts);
    removedNodes += 1;
    sweptTranscriptStates += result.sweptTranscriptStates;
    emitArchivedTranscriptUpdates(publishedArchives);
    return true;
  };

  // Reference analysis is the only unindexable part of a reclaim, so it is
  // amortized across bounded batches: one pass over the store answers every
  // boundary for a whole batch while a connection-local token proves nothing was
  // inserted or updated since. Each candidate keeps its own lifecycle admission
  // and its own write transaction, so a batch never widens the exclusion held
  // over unrelated sessions and a busy placeholder still only skips itself.
  const batchDatabase = openOpenClawAgentDatabase(toDatabaseOptions(scope));
  const repairedCandidates: { candidate: TombstoneCandidate; liveGenerationIds: string[] }[] = [];
  const unrepairableFailures: { candidate: TombstoneCandidate; liveGenerationIds: string[] }[] = [];
  for (let offset = 0; offset < candidates.length; offset += TOMBSTONE_REFERENCE_BATCH_SIZE) {
    const batch = candidates.slice(offset, offset + TOMBSTONE_REFERENCE_BATCH_SIZE);
    await withBatchedSessionReferenceAnalysis(
      batchDatabase,
      batch.flatMap((candidate) => candidate.generationIds),
      async () => {
        // The batched reference check above is a probabilistic fast path (see
        // session-accessor.sqlite-reference-batch.ts): it amortizes cost across
        // the whole outer batch, but nothing proves it stayed correct for the
        // full window between priming and this exact candidate's delete. So it
        // is never trusted alone -- reclaim a SMALL sub-group at a time, then
        // immediately re-verify with a real, unbatched, unconditionally correct
        // read (readReferencedSessionIds with an explicit diskBudget bypasses
        // the memo entirely) scoped to just that sub-group's ids. Verifying in
        // small groups rather than once per outer batch bounds both how long a
        // wrongly-reclaimed session stays gone before detection and how many
        // candidates one incident could ever involve.
        for (
          let subOffset = 0;
          subOffset < batch.length;
          subOffset += TOMBSTONE_VERIFICATION_GROUP_SIZE
        ) {
          const group = batch.slice(subOffset, subOffset + TOMBSTONE_VERIFICATION_GROUP_SIZE);
          // Snapshotted before the delete, not after: once a candidate is
          // reclaimed there is nothing left in session_nodes/session_windows
          // to read back. Capturing every candidate in the group costs one
          // extra indexed lookup each even though only a rare one will ever
          // need it, but there is no "decide afterward" option here.
          const snapshotsByKey = new Map<string, ReclaimedRowSnapshot>();
          for (const candidate of group) {
            const snapshot = captureReclaimedRowSnapshot(batchDatabase, candidate.sessionKey);
            if (snapshot) {
              snapshotsByKey.set(candidate.sessionKey, snapshot);
            }
          }
          // Only candidates this sub-group actually removed need verifying --
          // one `reclaim()` legitimately skips a candidate for reasons that
          // have nothing to do with references (a live work admission, a
          // stale scan no longer matching the current row), and a skipped
          // candidate is trivially still "referenced": it was never deleted.
          const reclaimed: TombstoneCandidate[] = [];
          for (const candidate of group) {
            if (await reclaim(candidate)) {
              reclaimed.push(candidate);
            }
          }
          const reclaimedGenerationIds = reclaimed.flatMap((candidate) => candidate.generationIds);
          if (reclaimedGenerationIds.length === 0) {
            continue;
          }
          const liveReferences = readReferencedSessionIds(
            batchDatabase,
            new Set(),
            reclaimedGenerationIds,
            {},
          );
          if (liveReferences.size === 0) {
            continue;
          }
          for (const candidate of reclaimed) {
            const liveGenerationIds = candidate.generationIds.filter((sessionId) =>
              liveReferences.has(sessionId),
            );
            if (liveGenerationIds.length === 0) {
              continue;
            }
            const snapshot = snapshotsByKey.get(candidate.sessionKey);
            if (!snapshot) {
              // Should be unreachable -- every reclaimed candidate was live
              // (and therefore captured) immediately beforehand. Treated as
              // unrepairable rather than silently accepted either way.
              unrepairableFailures.push({ candidate, liveGenerationIds });
              continue;
            }
            restoreReclaimedRowSnapshot(batchDatabase, snapshot);
            removedNodes -= 1;
            sweptTranscriptStates -= candidate.generationIds.length;
            repairedCandidates.push({ candidate, liveGenerationIds });
          }
        }
      },
    );
  }
  if (unrepairableFailures.length > 0) {
    // Surfacing this loudly rather than silently is deliberate -- it should
    // never be quiet if a wrongly-reclaimed candidate could not be repaired.
    throw new Error(
      `Tombstone sweep reclaimed ${unrepairableFailures.length} candidate(s) that a post-delete ` +
        `verification found still referenced, and could not restore: ${unrepairableFailures
          .map(
            (failure) =>
              `${failure.candidate.sessionKey} (${failure.liveGenerationIds.join(", ")})`,
          )
          .join("; ")}`,
    );
  }
  if (repairedCandidates.length > 0) {
    log.warn(
      `Tombstone sweep reclaimed and then restored ${repairedCandidates.length} candidate(s) that a ` +
        `post-delete verification found still referenced: ${repairedCandidates
          .map(
            (failure) =>
              `${failure.candidate.sessionKey} (${failure.liveGenerationIds.join(", ")})`,
          )
          .join("; ")}`,
    );
  }
  return {
    candidates: candidates.length,
    removedNodes,
    sweptTranscriptStates,
    olderThanMs,
  };
}

/**
 * Resolves the cron-run tombstone sweep for one selected store target, or null
 * when retention is disabled or the store has no SQLite file yet. Lives here
 * rather than in cleanup-service so the preview and apply paths share one
 * definition, and so the target-to-owner-set mapping has a single owner.
 */
export async function sweepTombstonedCronRunRemnantsForStore(params: {
  target: SessionStoreTarget;
  retentionMs: number | null;
  dryRun: boolean;
  nowMs?: number;
}): Promise<SessionTombstoneSweepResult | null> {
  const { agentId, sharedOwnerAgentIds, storePath } = params.target;
  const databaseTarget = resolveSqliteTargetFromSessionStorePath(storePath, { agentId });
  if (params.retentionMs == null || !fs.existsSync(databaseTarget.path)) {
    return null;
  }
  return await sweepTombstonedCronRunRemnants({
    // A shared store collapses every selected agent onto one target, so the
    // sweep must cover the whole collapsed set; only their union covers what
    // --all-agents selected. Single-agent selections never dedupe, so the field
    // is absent there and scanning stays scoped to the one requested owner.
    requestedOwners: new Set(
      [agentId, ...(sharedOwnerAgentIds ?? [])].map((owner) => normalizeAgentId(owner)),
    ),
    databaseAgentId: databaseTarget.agentId ?? agentId,
    storePath,
    sqlitePath: databaseTarget.path,
    olderThanMs: params.retentionMs,
    dryRun: params.dryRun,
    ...(params.nowMs === undefined ? {} : { nowMs: params.nowMs }),
  });
}
