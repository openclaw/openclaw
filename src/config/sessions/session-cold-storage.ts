import fs from "node:fs/promises";
import path from "node:path";
import { hasErrnoCode } from "../../infra/errno.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
  sqliteStringSet,
} from "../../infra/kysely-sync.js";
import { runSqliteDeferredTransactionSync } from "../../infra/sqlite-transaction.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { KeyedAsyncQueue } from "../../plugin-sdk/keyed-async-queue.js";
import {
  retainOpenClawAgentDatabaseReadOnly,
  withOpenClawAgentDatabaseReadOnly,
} from "../../state/openclaw-agent-db-readonly.js";
import type { DB } from "../../state/openclaw-agent-db.generated.js";
import {
  resolveOpenClawAgentSqlitePath,
  type OpenClawAgentDatabaseOptions,
} from "../../state/openclaw-agent-db.js";
import {
  resolveOpenClawStateDirForDatabasePath,
  resolveOpenClawStateSqlitePath,
} from "../../state/openclaw-state-db.paths.js";
import type { OpenClawConfig } from "../types.js";
import { resolveSessionArtifactDirectory } from "./paths.js";
import { runSqliteTranscriptArchiveWorkerOperation } from "./session-accessor.sqlite-archive.js";
import type { SessionTranscriptReadScope } from "./session-accessor.sqlite-contract.js";
import { readSessionStateDeleteSnapshot } from "./session-accessor.sqlite-delete-snapshot.js";
import { withSqliteReclamationAuthorization } from "./session-accessor.sqlite-reclamation-commit.js";
import {
  resolveSqliteTranscriptReadScope,
  runExclusiveSqliteSessionWrite,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import { readSessionColdStorageProtection } from "./session-cold-storage-eligibility.js";
import { readSessionColdTranscript } from "./session-cold-storage-state.js";
import type {
  SessionColdMutationPlan,
  SessionColdBatchInput,
  SessionColdBatchPrepared,
  SessionColdMutationResult,
  SessionColdPreparationWorkerData,
  SessionColdWorkerData,
} from "./session-cold-storage-worker.js";
import { collectAdmissionProtectedSessionIds } from "./session-history-eviction.js";
import { resolveSessionStoreTargets } from "./targets.js";

const operations = new KeyedAsyncQueue();
const log = createSubsystemLogger("session-cold-storage");
const oversizedUntil = new Map<string, number>();
let nextStore = 0;
const restoredUntil = new Map<string, number>();
const RESTORE_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const MAX_TRANSCRIPTS_PER_PASS = 128;
const MAX_BATCH_BYTES = 64 * 1024 * 1024;

export type SessionColdMaintenanceResult = {
  archivedTranscripts: number;
  externalizedTranscripts: number;
};

function workerDatabaseOptions(options: OpenClawAgentDatabaseOptions) {
  const sourceEnv = options.env ?? process.env;
  return {
    agentId: options.agentId,
    path: resolveOpenClawAgentSqlitePath(options),
    env: {
      OPENCLAW_STATE_DIR: resolveOpenClawStateDirForDatabasePath(
        options.database?.path ?? resolveOpenClawStateSqlitePath(sourceEnv),
      ),
    },
  };
}

async function runColdMutation(
  plan: SessionColdMutationPlan,
  assertCurrent?: () => void,
): Promise<SessionColdMutationResult> {
  const retained = await runExclusiveSqliteSessionWrite(
    plan.databaseOptions,
    async () => {
      assertCurrent?.();
      return retainOpenClawAgentDatabaseReadOnly(plan.databaseOptions);
    },
    "session.reclamation.retain",
  );
  if (!retained.found) {
    throw new Error("Cold transcript operation lost its owning database");
  }
  const { claim } = retained;
  try {
    const assertAllowed = () => {
      claim.assertCurrent();
      assertCurrent?.();
    };
    const commitGate = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
    const [completed] = await withSqliteReclamationAuthorization(
      commitGate,
      claim.database.db,
      assertAllowed,
      (authorize) =>
        runSqliteTranscriptArchiveWorkerOperation<{
          result: SessionColdMutationResult;
          cleanupIncomplete?: boolean;
        }>({
          expectedMessageType: "reclaimed",
          onCommitRequest: () => {
            authorize();
          },
          withWriteAdmission: async (run) =>
            runExclusiveSqliteSessionWrite(
              plan.databaseOptions,
              async () => {
                let refusal: { error: unknown } | undefined;
                try {
                  assertAllowed();
                } catch (error) {
                  refusal = { error };
                }
                await run(refusal);
              },
              "session.reclamation.worker-commit",
            ),
          workerData: {
            type: "sqlite-transcript-archive-v2",
            operation: "cold-mutate",
            plan,
            commitGate,
          } satisfies SessionColdWorkerData,
        }),
    );
    if (!completed || completed.cleanupIncomplete) {
      throw new Error(
        "Cold transcript worker cleanup is incomplete; restart OpenClaw before another maintenance operation",
      );
    }
    return completed.result;
  } finally {
    claim.release();
  }
}

type ColdBatchOptions = {
  databaseOptions: OpenClawAgentDatabaseOptions;
  ownerStorePath: string;
  beforeMs: number;
  maxTranscripts: number;
  maxBytes: number;
  assertCurrent?: () => void;
};

type ColdBatchResult = SessionColdMaintenanceResult & {
  envelopeBytes: number;
  attemptedTranscripts: number;
};

async function archiveSessionColdBatch(options: ColdBatchOptions): Promise<ColdBatchResult> {
  const storePath = resolveOpenClawAgentSqlitePath(options.databaseOptions);
  return operations.enqueue(storePath, async () => {
    const selection = await runExclusiveSqliteSessionWrite(
      options.databaseOptions,
      async () =>
        withOpenClawAgentDatabaseReadOnly((database) => {
          options.assertCurrent?.();
          const db = getNodeSqliteKysely<DB>(database.db);
          const excluded = readSessionColdStorageProtection(database, options.beforeMs);
          const admissions = collectAdmissionProtectedSessionIds({
            database,
            storePath: options.ownerStorePath,
          });
          for (const id of admissions) {
            excluded.add(id);
          }
          const cooled = new Set<string>();
          const now = Date.now();
          for (const cache of [restoredUntil, oversizedUntil]) {
            for (const [key, until] of cache) {
              if (until <= now) {
                cache.delete(key);
              } else if (key.startsWith(`${storePath}\0`)) {
                cooled.add(key.slice(storePath.length + 1));
              }
            }
          }
          for (const id of cooled) {
            excluded.add(id);
          }
          const externalizations = executeSqliteQuerySync(
            database.db,
            db
              .selectFrom("session_transcript_cold_archives")
              .select("session_id")
              .where("storage", "=", "sqlite")
              .$if(cooled.size + admissions.size > 0, (query) =>
                query.where("session_id", "not in", sqliteStringSet([...cooled, ...admissions])),
              )
              .orderBy("archived_at")
              .orderBy("session_id")
              .limit(options.maxTranscripts),
          ).rows.flatMap((row) => {
            const archive = readSessionColdTranscript(database.db, row.session_id);
            return archive ? [archive] : [];
          });
          const candidates =
            externalizations.length < options.maxTranscripts
              ? executeSqliteQuerySync(
                  database.db,
                  db
                    .selectFrom("session_windows as window")
                    .leftJoin(
                      "session_transcript_cold_archives as cold",
                      "cold.session_id",
                      "window.session_id",
                    )
                    .select("window.session_id")
                    .where("cold.session_id", "is", null)
                    .$if(excluded.size > 0, (query) =>
                      query.where("window.session_id", "not in", sqliteStringSet([...excluded])),
                    )
                    .where("window.transcript_updated_at", "<", options.beforeMs)
                    .where((eb) =>
                      eb.exists(
                        eb
                          .selectFrom("transcript_events as event")
                          .select("event.seq")
                          .whereRef("event.session_id", "=", "window.session_id"),
                      ),
                    )
                    .orderBy("window.transcript_updated_at")
                    .orderBy("window.session_id")
                    .limit(options.maxTranscripts - externalizations.length),
                ).rows
              : [];
          const databaseOptions = workerDatabaseOptions(options.databaseOptions);
          const plans = candidates.flatMap(({ session_id: sessionId }) => {
            const snapshot = readSessionStateDeleteSnapshot(database.db, sessionId);
            return snapshot.generation && snapshot.lastSeq !== null
              ? [{ databaseOptions, sessionId, beforeMs: options.beforeMs, snapshot }]
              : [];
          });
          const freePages = Number(
            // sqlite-allow-raw -- Physical maintenance is needed only when SQLite owns free pages.
            database.db.prepare("PRAGMA freelist_count").get()?.freelist_count ?? 0,
          );
          return {
            input: {
              databaseOptions,
              plans,
              externalizations,
              maxBytes: options.maxBytes,
            } satisfies SessionColdBatchInput,
            freePages,
          };
        }, options.databaseOptions),
      "session.history.eviction-prepare",
    );
    const empty: ColdBatchResult = {
      archivedTranscripts: 0,
      externalizedTranscripts: 0,
      envelopeBytes: 0,
      attemptedTranscripts: 0,
    };
    if (!selection.found) {
      return empty;
    }
    const { input, freePages } = selection.value;
    if (input.plans.length + input.externalizations.length === 0) {
      if (freePages > 0) {
        await runColdMutation(
          { kind: "cold-maintain", databaseOptions: input.databaseOptions },
          options.assertCurrent,
        );
      }
      return empty;
    }
    const [batch] = await runSqliteTranscriptArchiveWorkerOperation<SessionColdBatchPrepared>({
      expectedMessageType: "done",
      workerData: {
        type: "sqlite-transcript-archive-v2",
        operation: "cold-prepare",
        input,
      } satisfies SessionColdPreparationWorkerData,
    });
    if (!batch) {
      throw new Error("Cold archive worker returned no prepared batch");
    }
    for (const sessionId of batch.oversizedSessionIds) {
      oversizedUntil.set(`${storePath}\0${sessionId}`, Date.now() + RESTORE_COOLDOWN_MS);
      log.warn("Transcript remains in SQLite because its archive exceeds the 64 MiB limit", {
        agentId: input.databaseOptions.agentId,
      });
    }
    const included = [
      ...batch.prepared.map((item) => item.plan.sessionId),
      ...batch.externalizations.map((item) => item.archive.session_id),
    ];
    const result =
      included.length > 0
        ? await runColdMutation(
            {
              kind: "cold-batch",
              databaseOptions: input.databaseOptions,
              prepared: batch.prepared,
              externalizations: batch.externalizations,
              beforeMs: options.beforeMs,
            },
            () => {
              options.assertCurrent?.();
              const read = withOpenClawAgentDatabaseReadOnly(
                (database) =>
                  collectAdmissionProtectedSessionIds({
                    database,
                    storePath: options.ownerStorePath,
                  }),
                input.databaseOptions,
              );
              if (!read.found) {
                throw new Error("Cold transcript database disappeared");
              }
              if (
                included.some(
                  (id) =>
                    read.value.has(id) ||
                    (restoredUntil.get(`${storePath}\0${id}`) ?? 0) > Date.now(),
                )
              ) {
                throw new Error("Transcript became active; cold archival was canceled");
              }
            },
          )
        : empty;
    return {
      archivedTranscripts: result.archivedTranscripts,
      externalizedTranscripts: result.externalizedTranscripts,
      envelopeBytes: batch.envelopeBytes,
      attemptedTranscripts: included.length + batch.oversizedSessionIds.length,
    };
  });
}

export async function restoreSessionColdTranscript(
  scope: SessionTranscriptReadScope,
): Promise<void> {
  const resolved = resolveSqliteTranscriptReadScope(scope);
  const options = toDatabaseOptions(resolved);
  const storePath = resolveOpenClawAgentSqlitePath(options);
  const key = `${storePath}\0${resolved.sessionId}`;
  const initial = withOpenClawAgentDatabaseReadOnly(
    (database) => readSessionColdTranscript(database.db, resolved.sessionId),
    options,
  );
  if (!initial.found || !initial.value) {
    return;
  }
  await operations.enqueue(storePath, async () => {
    const opened = withOpenClawAgentDatabaseReadOnly(
      (database) => readSessionColdTranscript(database.db, resolved.sessionId),
      options,
    );
    if (!opened.found || !opened.value) {
      return;
    }
    await runColdMutation({
      kind: "cold-restore",
      databaseOptions: workerDatabaseOptions(options),
      sessionId: resolved.sessionId,
      archive: opened.value,
    });
    // Keep viewed history hot without changing canonical transcript timestamps or bytes.
    const now = Date.now();
    for (const [id, until] of restoredUntil) {
      if (until <= now) {
        restoredUntil.delete(id);
      }
    }
    restoredUntil.set(key, now + RESTORE_COOLDOWN_MS);
  });
}

function configuredStores(
  config: OpenClawConfig,
): Array<{ agentId: string; storePath: string; ownerStorePath: string }> {
  return resolveSessionStoreTargets(config, { allAgents: true }).map((target) => {
    const resolved = resolveSqliteTranscriptReadScope({ ...target, sessionId: "cold-maintenance" });
    const options = toDatabaseOptions(resolved);
    return {
      agentId: options.agentId,
      storePath: resolveOpenClawAgentSqlitePath(options),
      ownerStorePath: target.storePath,
    };
  });
}

export async function runSessionColdStorageMaintenance(params: {
  config: OpenClawConfig;
  assertCurrent?: () => void;
  onProgress?: (progress: SessionColdMaintenanceResult) => void;
}): Promise<SessionColdMaintenanceResult> {
  const result: SessionColdMaintenanceResult = {
    archivedTranscripts: 0,
    externalizedTranscripts: 0,
  };
  const config = params.config.session?.maintenance?.coldStorage;
  if (!config?.enabled) {
    return result;
  }
  const beforeMs = Date.now() - (config.afterDays ?? 30) * 24 * 60 * 60 * 1000;
  const stores = configuredStores(params.config);
  const start = stores.length ? nextStore % stores.length : 0;
  nextStore = start + 1;
  let remainingTranscripts = MAX_TRANSCRIPTS_PER_PASS;
  let remainingBytes = MAX_BATCH_BYTES;
  for (const { agentId, storePath, ownerStorePath } of [
    ...stores.slice(start),
    ...stores.slice(0, start),
  ]) {
    if (remainingTranscripts <= 0 || remainingBytes <= 0) {
      break;
    }
    params.assertCurrent?.();
    const exists = withOpenClawAgentDatabaseReadOnly(() => true, { agentId, path: storePath });
    if (!exists.found) {
      continue;
    }
    const batch = await archiveSessionColdBatch({
      databaseOptions: { agentId, path: storePath },
      ownerStorePath,
      beforeMs,
      maxTranscripts: remainingTranscripts,
      maxBytes: remainingBytes,
      assertCurrent: params.assertCurrent,
    });
    result.archivedTranscripts += batch.archivedTranscripts;
    result.externalizedTranscripts += batch.externalizedTranscripts;
    remainingTranscripts -= batch.attemptedTranscripts;
    remainingBytes -= batch.envelopeBytes;
    params.onProgress?.({ ...result });
  }
  return result;
}

async function fileBytes(pathname: string): Promise<number> {
  try {
    return (await fs.stat(pathname)).size;
  } catch (error) {
    if (hasErrnoCode(error, "ENOENT")) {
      return 0;
    }
    throw error;
  }
}

export async function getSessionColdStorageStatus(config: OpenClawConfig): Promise<
  Array<{
    agentId: string;
    storePath: string;
    hotTranscripts: number;
    coldTranscripts: number;
    databaseBytes: number;
    walBytes: number;
    archiveBytes: number;
    embeddedArchiveBytes: number;
  }>
> {
  return Promise.all(
    configuredStores(config).map(async ({ agentId, storePath }) => {
      const counts = withOpenClawAgentDatabaseReadOnly(
        (database) =>
          runSqliteDeferredTransactionSync(
            database.db,
            () => {
              const db = getNodeSqliteKysely<DB>(database.db);
              return {
                hotTranscripts:
                  executeSqliteQueryTakeFirstSync(
                    database.db,
                    db
                      .selectFrom("session_windows as window")
                      .leftJoin(
                        "session_transcript_cold_archives as cold",
                        "cold.session_id",
                        "window.session_id",
                      )
                      .select((eb) => eb.fn.countAll<number>().as("count"))
                      .where("cold.session_id", "is", null)
                      .where((eb) =>
                        eb.exists(
                          eb
                            .selectFrom("transcript_events as event")
                            .select("event.seq")
                            .whereRef("event.session_id", "=", "window.session_id"),
                        ),
                      ),
                  )?.count ?? 0,
                embeddedArchiveBytes:
                  executeSqliteQueryTakeFirstSync(
                    database.db,
                    db
                      .selectFrom("session_transcript_cold_archives")
                      .select((eb) => eb.fn.sum<number>("archive_bytes").as("bytes"))
                      .where("storage", "=", "sqlite"),
                  )?.bytes ?? 0,
                coldTranscripts:
                  executeSqliteQueryTakeFirstSync(
                    database.db,
                    db
                      .selectFrom("session_transcript_cold_archives")
                      .select((eb) => eb.fn.countAll<number>().as("count")),
                  )?.count ?? 0,
              };
            },
            { databaseLabel: database.path, operationLabel: "session cold storage inventory" },
          ),
        { agentId, path: storePath },
        { throwOnMissingTable: true },
      );
      const directory = path.join(resolveSessionArtifactDirectory(storePath), "cold");
      const files = await fs.readdir(directory, { withFileTypes: true }).catch((error: unknown) => {
        if (hasErrnoCode(error, "ENOENT")) {
          return [];
        }
        throw error;
      });
      const archiveBytes = (
        await Promise.all(
          files
            .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl.zst"))
            .map((entry) => fileBytes(path.join(directory, entry.name))),
        )
      ).reduce((sum, bytes) => sum + bytes, 0);
      const { hotTranscripts, coldTranscripts, embeddedArchiveBytes } = counts.found
        ? counts.value
        : { hotTranscripts: 0, coldTranscripts: 0, embeddedArchiveBytes: 0 };
      return {
        agentId,
        storePath,
        hotTranscripts,
        coldTranscripts,
        embeddedArchiveBytes,
        databaseBytes: await fileBytes(storePath),
        walBytes: await fileBytes(`${storePath}-wal`),
        archiveBytes,
      };
    }),
  );
}
