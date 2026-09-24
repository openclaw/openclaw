import {
  executeSqliteQuerySync,
  iterateSqliteQuerySync,
  sqliteStringSet,
} from "../../infra/kysely-sync.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  collectActiveSessionWorkAdmissions,
  runExclusiveSessionLifecycleMutation,
} from "../../sessions/session-lifecycle-admission.js";
import { runQueuedStoreWrite, type StoreWriterQueue } from "../../shared/store-writer-queue.js";
import {
  isIncognitoOpenClawAgentSqlitePath,
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
  type OpenClawAgentDatabase,
  type OpenClawAgentDatabaseOptions,
} from "../../state/openclaw-agent-db.js";
import { resolveStateDir } from "../paths.js";
import {
  hasRetainedSessionTranscriptArchives,
  measureSessionPhysicalDiskUsage,
} from "./disk-budget.js";
import type { SessionDiskBudgetSweepResult } from "./disk-budget.types.js";
import { withSqliteTranscriptArchiveSession } from "./session-accessor.sqlite-archive-session.js";
import { publishSessionStateArchives } from "./session-accessor.sqlite-archive-store.js";
import { materializeSessionStateDeletePlans } from "./session-accessor.sqlite-archive.js";
import type {
  SqliteSessionArchivePruningDiagnostics,
  SqliteSessionReclamationDiagnostics,
} from "./session-accessor.sqlite-contract.js";
import { emitArchivedTranscriptUpdates } from "./session-accessor.sqlite-events.js";
import {
  collectSessionStateIdsForEntry,
  planSessionStateDeleteIfUnreferenced,
  readReferencedSessionIds,
} from "./session-accessor.sqlite-lifecycle-state.js";
import { refreshSqliteSessionPlannerStatisticsBestEffort } from "./session-accessor.sqlite-maintenance.js";
import { withSqliteSessionPageReclamation } from "./session-accessor.sqlite-page-reclamation.js";
import {
  createHistoryEvictionReclamationPlan,
  runExclusiveSqliteSessionReclamation,
  runSqliteSessionReclamation,
} from "./session-accessor.sqlite-reclamation.js";
import {
  collectRecentSessionHistoryIds,
  isRecentHistoricalSessionId,
} from "./session-accessor.sqlite-references.js";
import {
  getSessionKysely,
  resolveSqliteScope,
  resolveSqliteTranscriptArchiveDirectory,
  runExclusiveSqliteSessionWrite,
  toDatabaseOptions,
  withSqliteSessionDatabase,
} from "./session-accessor.sqlite-scope.js";
import { parseSessionEntryJson } from "./session-accessor.sqlite-status.js";
import {
  hasCanonicalSessionTranscriptArchives,
  pruneAllSessionTranscriptArchivesToHighWater,
  reclaimSqliteFreePages,
} from "./session-history-archive-pruning.js";
import {
  budgetKickStateByStore,
  createPhysicalBudgetResult,
  deferPhysicalBudgetForCheckpoint,
  getBudgetKickState,
  recordPhysicalBudgetOutcome,
  PHYSICAL_BUDGET_CHECK_INTERVAL_MS,
  FORCED_PHYSICAL_BUDGET_CHECK_INTERVAL_MS,
  type SessionHistoryBudgetKick,
  type SessionHistoryDiskBudgetParams,
} from "./session-history-budget-state.js";
import { deleteDiskBudgetArchivedSessionEntry } from "./session-history-entry-eviction.runtime.js";
import { readDiskEvictableArchivedSessionBatch } from "./session-history-eviction-candidates.js";
import { normalizeStoreSessionKey } from "./store-entry.js";
import { resolveMaintenanceConfig } from "./store-maintenance-runtime.js";

/** Reports the same physical total enforce mode compares, without projecting logical row bytes. */
export async function inspectSqliteSessionHistoryDiskBudget(
  input: SessionHistoryDiskBudgetParams,
): Promise<{ diskBudget: SessionDiskBudgetSweepResult | null; wouldMutate: boolean }> {
  const params = { ...input, env: { ...(input.env ?? process.env) } };
  params.env.OPENCLAW_STATE_DIR = resolveStateDir(params.env);
  const { highWaterBytes, maxDiskBytes } = params.maintenance;
  if (maxDiskBytes == null || highWaterBytes == null) {
    return { diskBudget: null, wouldMutate: false };
  }
  const usage = await measureSessionPhysicalDiskUsage(params.storePath);
  const diskBudget = createPhysicalBudgetResult({
    totalBytesBefore: usage.totalBytes,
    maxBytes: maxDiskBytes,
    highWaterBytes,
  });
  if (!diskBudget.overBudget || params.mode !== "enforce") {
    return { diskBudget, wouldMutate: false };
  }
  const blocked = budgetKickStateByStore.get(params.storePath)?.checkpointBlocked;
  if (blocked) {
    return {
      diskBudget: {
        ...diskBudget,
        deferredReason: "checkpoint-incomplete",
        checkpoint: blocked.checkpoint?.health,
        walBytesBefore: usage.databaseWalBytes,
        walBytesAfter: usage.databaseWalBytes,
      },
      wouldMutate: false,
    };
  }
  // Predict only definite reclamation: prunable archives or unprotected
  // historical generations. Checkpoint-only byte reclamation stays out of the
  // preview; applied summaries report it via their byte-decrease predicate.
  const resolved = resolveSqliteScope({
    ...(params.agentId ? { agentId: params.agentId } : {}),
    env: params.env,
    sessionKey: "",
    storePath: params.storePath,
  });
  const databaseOptions = toDatabaseOptions(resolved);
  if (
    hasCanonicalSessionTranscriptArchives(databaseOptions) ||
    (await hasRetainedSessionTranscriptArchives(params.storePath))
  ) {
    return { diskBudget, wouldMutate: true };
  }
  const candidates = readHistoricalSessionIds({
    databaseOptions,
    preserveRecentMs: params.maintenance.preserveRecentMs,
    storePath: params.storePath,
  });
  const archivedCandidates = readDiskEvictableArchivedSessionBatch({
    databaseOptions,
    limit: 1,
    preserveRecentMs: params.maintenance.preserveRecentMs,
  });
  return {
    diskBudget,
    wouldMutate: candidates.length > 0 || archivedCandidates.candidates.length > 0,
  };
}

function collectProtectedHistoricalSessionIds(params: {
  database: OpenClawAgentDatabase;
  preserveRecentMs?: number | null;
  storePath: string;
}): Set<string> {
  const protectedSessionIds = readReferencedSessionIds(
    params.database,
    undefined,
    undefined,
    params,
  );
  for (const sessionId of collectAdmissionProtectedSessionIds(params)) {
    protectedSessionIds.add(sessionId);
  }
  return protectedSessionIds;
}

function collectCandidateAdditionalProtection(params: {
  database: OpenClawAgentDatabase;
  preserveRecentMs?: number | null;
  sessionId: string;
  storePath: string;
}): Set<string> {
  const protectedSessionIds = collectAdmissionProtectedSessionIds(params);
  if (isRecentHistoricalSessionId(params)) {
    protectedSessionIds.add(params.sessionId);
  }
  return protectedSessionIds;
}

/** Session ids owned by in-flight work admissions, without live-reference protection. */
export function collectAdmissionProtectedSessionIds(params: {
  database: Pick<OpenClawAgentDatabase, "db">;
  storePath: string;
}): Set<string> {
  const protectedSessionIds = new Set<string>();
  const admissionIdentities =
    collectActiveSessionWorkAdmissions().get(params.storePath) ?? new Set<string>();
  if (admissionIdentities.size === 0) {
    return protectedSessionIds;
  }

  // Admissions may carry either the backing session id or its live session key. Protect both,
  // then resolve admitted keys through their entries so cleanup cannot reclaim active work.
  for (const identity of admissionIdentities) {
    protectedSessionIds.add(identity);
  }
  const normalizedAdmissionKeys = new Set(
    [...admissionIdentities].map((identity) => normalizeStoreSessionKey(identity)),
  );
  const db = getSessionKysely(params.database.db);
  const admittedKeyBytes: string[] = [];
  // Normalize lightweight keys before reading payloads; unrelated saved prompts can be large.
  for (const row of iterateSqliteQuerySync(
    params.database.db,
    db
      .selectFrom("session_nodes")
      .select(["session_key", db.fn<string>("hex", ["session_key"]).as("key_bytes")]),
  )) {
    if (normalizedAdmissionKeys.has(normalizeStoreSessionKey(row.session_key))) {
      admittedKeyBytes.push(row.key_bytes);
    }
  }
  const rows = admittedKeyBytes.length
    ? iterateSqliteQuerySync(
        params.database.db,
        db
          .selectFrom("session_nodes")
          .select(["entry_json", "current_session_id"])
          // Keep stored keys inside SQLite: Node TEXT rebinding can change raw UTF-16 keys.
          // The key-only subquery scans the existing index before fetching matched payloads.
          .where(
            "session_key",
            "in",
            db
              .selectFrom("session_nodes")
              .select("session_key")
              .where(
                db.fn<string>("hex", ["session_key"]),
                "in",
                sqliteStringSet(admittedKeyBytes),
              ),
          ),
      )
    : [];
  for (const row of rows) {
    protectedSessionIds.add(row.current_session_id);
    const entry = parseSessionEntryJson(row);
    if (entry) {
      for (const sessionId of collectSessionStateIdsForEntry(entry)) {
        protectedSessionIds.add(sessionId);
      }
    }
  }
  // Key-scoped admissions must survive rollover: an in-flight run admitted by
  // key may still write to a generation the entry no longer references, so
  // every generation of an admitted key stays off-limits.
  const generationRows = iterateSqliteQuerySync(
    params.database.db,
    db.selectFrom("session_windows").select(["session_id", "session_key"]),
  );
  for (const row of generationRows) {
    if (normalizedAdmissionKeys.has(normalizeStoreSessionKey(row.session_key))) {
      protectedSessionIds.add(row.session_id);
    }
  }
  return protectedSessionIds;
}

function readHistoricalSessionIds(params: {
  databaseOptions: OpenClawAgentDatabaseOptions;
  preserveRecentMs?: number | null;
  storePath: string;
}): string[] {
  // openclaw-agent-db.ts cache rule: LRU eviction closes idle handles across awaits.
  const database = openOpenClawAgentDatabase(params.databaseOptions);
  const scope = { ...params, database };
  const protectedSessionIds = collectProtectedHistoricalSessionIds(scope);
  for (const sessionId of collectRecentSessionHistoryIds(scope)) {
    protectedSessionIds.add(sessionId);
  }
  const db = getSessionKysely(database.db);
  return executeSqliteQuerySync(
    database.db,
    db
      .selectFrom("session_windows")
      .select("session_id")
      .orderBy("updated_at", "asc")
      .orderBy("session_id", "asc"),
  ).rows.flatMap((row) => (protectedSessionIds.has(row.session_id) ? [] : [row.session_id]));
}

const log = createSubsystemLogger("sessions/history-eviction");

/** Fire-and-forget budget pass from the ordinary entry-write maintenance seam. */
export function kickSessionHistoryDiskBudgetMaintenance(input: SessionHistoryBudgetKick): void {
  if (
    input.agentId &&
    isIncognitoOpenClawAgentSqlitePath(input.storePath, {
      agentId: input.agentId,
      env: input.env,
    })
  ) {
    return;
  }
  const maintenance = input.maintenanceConfig ?? resolveMaintenanceConfig();
  if (
    maintenance.mode !== "enforce" ||
    maintenance.maxDiskBytes == null ||
    maintenance.highWaterBytes == null
  ) {
    return;
  }
  const now = input.now ?? Date.now();
  const state = getBudgetKickState(input.storePath, maintenance);
  if (state.checkpointBlocked) {
    return;
  }
  if (state.running) {
    if (input.force) {
      const env = { ...(input.env ?? process.env) };
      env.OPENCLAW_STATE_DIR = resolveStateDir(env);
      state.pendingForce = { ...input, env, maintenanceConfig: maintenance, now: undefined };
    }
    return;
  }
  const interval = input.force
    ? FORCED_PHYSICAL_BUDGET_CHECK_INTERVAL_MS
    : PHYSICAL_BUDGET_CHECK_INTERVAL_MS;
  const lastCheckAt = input.force ? state.lastForcedCheckAt : state.lastCheckAt;
  if (now < (state.blockedUntil ?? -Infinity) || now - lastCheckAt < interval) {
    // Like ordinary writes, coalesced deletes retry on subsequent activity.
    // Manual cleanup bypasses this scheduling gate entirely.
    return;
  }
  const params = { ...input, env: { ...(input.env ?? process.env) } };
  params.env.OPENCLAW_STATE_DIR = resolveStateDir(params.env);
  state.lastCheckAt = now;
  if (input.force) {
    state.lastForcedCheckAt = now;
  }
  state.running = true;
  budgetKickStateByStore.set(params.storePath, state);
  void enforceSqliteSessionHistoryDiskBudget({
    ...(params.agentId ? { agentId: params.agentId } : {}),
    env: params.env,
    storePath: params.storePath,
    mode: maintenance.mode,
    maintenance,
  })
    .catch((error: unknown) => {
      // Best-effort: budget pressure is retried on the next throttled kick,
      // but a persistently failing sweep must stay operator-visible — silent
      // failure here means unbounded disk growth with no signal.
      log.warn("session history disk-budget sweep failed; retrying on next kick", {
        error,
        storePath: params.storePath,
      });
    })
    .finally(() => {
      state.running = false;
      if (state.pendingForce) {
        const pending = state.pendingForce;
        state.pendingForce = undefined;
        kickSessionHistoryDiskBudgetMaintenance(pending);
      }
    });
}

// One enforcement pass per store at a time: overlapping passes (background
// kick vs `sessions cleanup`) would evict on stale usage measurements and
// prune each other's freshly extracted archives.
const SESSION_HISTORY_MAINTENANCE_QUEUES = new Map<string, StoreWriterQueue>();

/** Extracts historical sessions durably before reclaiming their SQLite rows. */
export async function enforceSqliteSessionHistoryDiskBudget(
  input: SessionHistoryDiskBudgetParams,
): Promise<SessionDiskBudgetSweepResult | null> {
  // Measurement and queued cleanup must keep the invoking shared-state owner.
  const params = { ...input, env: { ...(input.env ?? process.env) } };
  params.env.OPENCLAW_STATE_DIR = resolveStateDir(params.env);
  return await runQueuedStoreWrite({
    queues: SESSION_HISTORY_MAINTENANCE_QUEUES,
    storePath: params.storePath,
    label: "enforceSqliteSessionHistoryDiskBudget",
    fn: async () => {
      const result = await enforceSessionHistoryMaintenanceSerialized(params);
      recordPhysicalBudgetOutcome(params, result);
      return result;
    },
  });
}

// Reclaims checkpointable pages, retained archives, then historical SQLite
// rows. Unreferenced session-dir artifacts (orphan transcripts, stale blobs)
// are owned by per-save store maintenance and `sessions cleanup`, not by this
// supplementary pressure pass.
async function enforceSessionHistoryMaintenanceSerialized(
  params: SessionHistoryDiskBudgetParams,
): Promise<SessionDiskBudgetSweepResult | null> {
  const { highWaterBytes, maxDiskBytes } = params.maintenance;
  if (maxDiskBytes == null || highWaterBytes == null) {
    return null;
  }
  const initialUsage = await measureSessionPhysicalDiskUsage(params.storePath);
  const blocked = getBudgetKickState(params.storePath, params.maintenance).checkpointBlocked;
  if (blocked && params.mode === "enforce") {
    return createPhysicalBudgetResult({
      totalBytesBefore: initialUsage.totalBytes,
      maxBytes: maxDiskBytes,
      highWaterBytes,
      deferred: {
        checkpoint: blocked.checkpoint?.health,
        walBytesBefore: initialUsage.databaseWalBytes,
        walBytesAfter: initialUsage.databaseWalBytes,
      },
    });
  }
  if (initialUsage.totalBytes <= maxDiskBytes || params.mode === "warn") {
    return createPhysicalBudgetResult({
      totalBytesBefore: initialUsage.totalBytes,
      maxBytes: maxDiskBytes,
      highWaterBytes,
    });
  }

  const resolved = resolveSqliteScope({
    ...(params.agentId ? { agentId: params.agentId } : {}),
    env: params.env,
    sessionKey: "",
    storePath: params.storePath,
  });
  return await withSqliteTranscriptArchiveSession(toDatabaseOptions(resolved), () =>
    enforceSessionHistoryMaintenanceForDatabase(
      params,
      initialUsage,
      resolved,
      highWaterBytes,
      maxDiskBytes,
    ),
  );
}

async function enforceSessionHistoryMaintenanceForDatabase(
  params: SessionHistoryDiskBudgetParams,
  initialUsage: Awaited<ReturnType<typeof measureSessionPhysicalDiskUsage>>,
  resolved: ReturnType<typeof resolveSqliteScope>,
  highWaterBytes: number,
  maxDiskBytes: number,
): Promise<SessionDiskBudgetSweepResult> {
  const databaseOptions = toDatabaseOptions(resolved);
  const databasePath = resolveOpenClawAgentSqlitePath(databaseOptions);
  const archiveDirectory = resolveSqliteTranscriptArchiveDirectory(resolved);
  const pruneArchives = (trigger: SqliteSessionArchivePruningDiagnostics["trigger"]) => {
    const archivePruning: SqliteSessionArchivePruningDiagnostics = { trigger };
    return withSqliteSessionPageReclamation(databaseOptions, (reclaimPages) =>
      runExclusiveSqliteSessionWrite(
        resolved,
        async () =>
          pruneAllSessionTranscriptArchivesToHighWater({
            archiveDirectory,
            databaseOptions,
            diagnostics: archivePruning,
            highWaterBytes,
            storePath: params.storePath,
            reclaimPages,
            onCheckpointIncomplete: (checkpoint) =>
              deferPhysicalBudgetForCheckpoint(params, databasePath, checkpoint),
          }),
        "session.history.archive-prune",
        { archivePruning },
      ),
    );
  };
  let pruning = await pruneArchives("initial");
  let { usage, removedFiles } = pruning;
  let removedEntries = 0;
  const finish = () =>
    createPhysicalBudgetResult({
      totalBytesBefore: initialUsage.totalBytes,
      totalBytesAfter: usage.totalBytes,
      removedEntries,
      removedFiles,
      maxBytes: maxDiskBytes,
      highWaterBytes,
      ...(pruning.checkpointIncomplete
        ? {
            deferred: {
              checkpoint: pruning.checkpoint,
              walBytesBefore: initialUsage.databaseWalBytes,
              walBytesAfter: usage.databaseWalBytes,
            },
          }
        : {}),
    });
  if (pruning.checkpointIncomplete) {
    return finish();
  }
  const candidates =
    usage.totalBytes > highWaterBytes
      ? readHistoricalSessionIds({
          databaseOptions,
          preserveRecentMs: params.maintenance.preserveRecentMs,
          storePath: params.storePath,
        })
      : [];

  for (const sessionId of candidates) {
    if (usage.totalBytes <= highWaterBytes) {
      break;
    }
    const eviction = await runExclusiveSessionLifecycleMutation({
      scope: params.storePath,
      identities: [sessionId],
      run: async () => {
        const plan = await runExclusiveSqliteSessionWrite(
          resolved,
          async () =>
            withSqliteSessionDatabase(databaseOptions, (database) => {
              const protectedBeforeArchive = collectCandidateAdditionalProtection({
                database,
                preserveRecentMs: params.maintenance.preserveRecentMs,
                sessionId,
                storePath: params.storePath,
              });
              for (const referenced of readReferencedSessionIds(
                database,
                undefined,
                [sessionId],
                params.maintenance,
              )) {
                protectedBeforeArchive.add(referenced);
              }
              return planSessionStateDeleteIfUnreferenced({
                archiveDirectory,
                archiveTranscript: true,
                database,
                reason: "deleted",
                referencedSessionIds: protectedBeforeArchive,
                sessionId,
              });
            }),
          "session.history.eviction-prepare",
        );
        if (!plan) {
          return null;
        }
        // Extract-before-delete is the retention invariant. The lifecycle hold
        // fences admission while the store writer is released for archive I/O.
        return await runExclusiveSqliteSessionReclamation(async () => {
          const materialized = await materializeSessionStateDeletePlans([plan]);
          const diagnostics: SqliteSessionReclamationDiagnostics = {};
          const reclamationPlan = await runExclusiveSqliteSessionWrite(
            resolved,
            async () =>
              withSqliteSessionDatabase(databaseOptions, (database) => {
                const protectedSessionIds = collectCandidateAdditionalProtection({
                  database,
                  preserveRecentMs: params.maintenance.preserveRecentMs,
                  sessionId,
                  storePath: params.storePath,
                });
                if (protectedSessionIds.has(sessionId)) {
                  return null;
                }
                return createHistoryEvictionReclamationPlan({
                  databaseOptions,
                  diskBudget: { preserveRecentMs: params.maintenance.preserveRecentMs },
                  materializedPlans: materialized,
                  protectedSessionIds,
                  sessionId,
                });
              }),
            "session.history.reclamation-plan",
            diagnostics,
          );
          if (!reclamationPlan) {
            return null;
          }
          const reclaimed = await runSqliteSessionReclamation({
            diagnostics,
            forceInProcess: params.reclamationMode === "in-process",
            plan: reclamationPlan,
          });
          if (reclaimed.kind !== reclamationPlan.kind) {
            throw new Error(
              `SQLite session reclamation returned ${reclaimed.kind} for ${reclamationPlan.kind}`,
            );
          }
          if (!reclaimed.value.deleted) {
            return null;
          }
          return {
            archivedTranscripts: reclaimed.value.archivedTranscripts,
          };
        });
      },
    });
    if (!eviction) {
      // A no-op can outlive a peer freeing space. Refresh after both holds
      // release so the next candidate cannot use stale physical pressure.
      usage = await measureSessionPhysicalDiskUsage(params.storePath);
      continue;
    }
    // The lifecycle and SQLite writer lanes are both released before file I/O;
    // publication reacquires the writer only for its short status commit.
    const publishedArchives = await publishSessionStateArchives(
      resolved,
      eviction.archivedTranscripts,
    );
    removedEntries += 1;
    emitArchivedTranscriptUpdates(publishedArchives);
    // Publication adds both the derived file and SQLite status WAL after the
    // deletion measurement. Re-read physical usage before declaring high water.
    usage = await measureSessionPhysicalDiskUsage(params.storePath);
    if (usage.totalBytes > highWaterBytes) {
      // Reclaim archives (oldest first, including ones this pass committed)
      // before spending another session's rows: each session's data should be
      // destroyed at most once, and pruning an extracted copy beats evicting
      // additional searchable history. No prune runs between an archive write
      // and its row-deletion commit, so a sole copy is never mid-flight here.
      const repruned = await pruneArchives("after-eviction");
      pruning = repruned;
      removedFiles += repruned.removedFiles;
      usage = repruned.usage;
      if (repruned.checkpointIncomplete) {
        return finish();
      }
    }
  }

  if (usage.totalBytes > highWaterBytes) {
    // Candidates are exhausted but archives may remain; finish the pass at the
    // target instead of returning over budget with removable artifacts.
    const finalPrune = await pruneArchives("final");
    pruning = finalPrune;
    removedFiles += finalPrune.removedFiles;
    usage = finalPrune.usage;
    if (finalPrune.checkpointIncomplete) {
      return finish();
    }
  }

  if (usage.totalBytes > highWaterBytes) {
    let after: { archivedAt: number; sessionKey: string } | undefined;
    while (usage.totalBytes > highWaterBytes) {
      const batch = readDiskEvictableArchivedSessionBatch({
        ...(after ? { after } : {}),
        databaseOptions,
        preserveRecentMs: params.maintenance.preserveRecentMs,
      });
      if (batch.candidates.length === 0) {
        break;
      }
      after = batch.cursor;
      for (const candidate of batch.candidates) {
        if (usage.totalBytes <= highWaterBytes) {
          break;
        }
        const deletion = await runExclusiveSessionLifecycleMutation({
          scope: params.storePath,
          identities: [candidate.sessionKey, candidate.entry.sessionId],
          run: async () =>
            await deleteDiskBudgetArchivedSessionEntry(
              {
                ...(params.agentId ? { agentId: params.agentId } : {}),
                archiveTranscript: false,
                deleteDeliveryArtifacts: true,
                deleteTranscriptWithoutArchive: true,
                expectedEntry: candidate.entry,
                expectedSessionId: candidate.entry.sessionId,
                storePath: params.storePath,
                target: { canonicalKey: candidate.sessionKey, storeKeys: [candidate.sessionKey] },
              },
              resolved,
            ),
        });
        if (!deletion.deleted) {
          usage = await measureSessionPhysicalDiskUsage(params.storePath);
          continue;
        }
        removedEntries += 1;
        const pageDiagnostics: SqliteSessionArchivePruningDiagnostics = {
          trigger: "after-eviction",
        };
        const checkpointCompleted = await withSqliteSessionPageReclamation(
          databaseOptions,
          (reclaimPages) =>
            runExclusiveSqliteSessionWrite(
              resolved,
              async () => {
                try {
                  return await reclaimSqliteFreePages(databaseOptions, pageDiagnostics, {
                    reclaimPages,
                    onCheckpointIncomplete: (checkpoint) =>
                      deferPhysicalBudgetForCheckpoint(params, databasePath, checkpoint),
                  });
                } catch {
                  // The durable deletion succeeded; a later pass can reclaim pages.
                  return true;
                }
              },
              "session.history.free-pages",
            ),
        );
        usage = await measureSessionPhysicalDiskUsage(params.storePath);
        if (!checkpointCompleted) {
          pruning = {
            usage,
            removedFiles: 0,
            completed: false,
            checkpointIncomplete: pageDiagnostics.checkpointIncomplete ?? 1,
            checkpoint: pageDiagnostics.checkpoint,
          };
          return finish();
        }
      }
      if (batch.exhausted) {
        break;
      }
    }
  }
  if (removedEntries > 0) {
    await refreshSqliteSessionPlannerStatisticsBestEffort(resolved, removedEntries);
    usage = await measureSessionPhysicalDiskUsage(params.storePath);
  }

  return finish();
}
