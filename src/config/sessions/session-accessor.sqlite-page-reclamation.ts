import { publishSqliteWalCheckpointObservation } from "../../infra/sqlite-wal-checkpoint.js";
import type { SqliteWalReclamationResult } from "../../infra/sqlite-wal.js";
import {
  assertExistingDatabaseIdentity,
  readDatabasePathIdentitySync,
} from "../../infra/sqlite-worker-identity.js";
import type { SqliteWorkerStore } from "../../infra/sqlite-worker-store.js";
import type { OpenClawAgentDatabaseOptions } from "../../state/openclaw-agent-db.js";
import type {
  AgentDatabaseExecutionFileIdentity,
  AgentDatabaseOperations,
} from "../../state/openclaw-agent-execution-contract.js";
import {
  captureOpenClawAgentDatabaseExecution,
  supportsOpenClawAgentDatabaseExecution,
} from "../../state/openclaw-agent-execution.js";
import { runExclusiveSqliteTranscriptArchiveWorker } from "./session-accessor.sqlite-archive.js";
import type { ReclamationDatabaseOptions } from "./session-accessor.sqlite-lifecycle-types.js";
import { resolveSessionReclamationDatabaseOptions } from "./session-accessor.sqlite-reclamation.js";
import {
  runExclusiveSqliteSessionWrite,
  withSqliteSessionDatabase,
} from "./session-accessor.sqlite-scope.js";
import { withSqliteMutationWorkerLifetime } from "./session-accessor.sqlite-worker-request.js";
import { captureSessionActorStorageOwner } from "./session-actor-storage-binding.js";
import {
  ARCHIVE_RETENTION_BATCH_SIZE,
  type SessionArchivePruningSnapshot,
  type SessionArchivePruningOperations,
} from "./session-history-archive-pruning.types.js";
import { maintenanceLane } from "./session-transcript-worker-resources.js";
import { withSessionHistoryWorkerDatabase } from "./session-transcript-worker-runtime.js";
import { createSessionWorkerExecutionSource } from "./session-worker-execution-source.js";

export type SqliteSessionPageReclaimer = (maxPages?: number) => Promise<SqliteWalReclamationResult>;

/** Preview reads share the history reader without waiting for archive or writer admission. */
export async function readSqliteSessionArchivePruning(
  input: OpenClawAgentDatabaseOptions,
): Promise<SessionArchivePruningSnapshot | null> {
  if (
    captureSessionActorStorageOwner(
      { ...input, storePath: input.path },
      { assertCurrent() {}, authorize() {} },
    )
  ) {
    return null;
  }
  const options = resolveSessionReclamationDatabaseOptions(input);
  if (!supportsOpenClawAgentDatabaseExecution(options)) {
    const { readSessionArchivePruningInDatabase } =
      await import("./session-history-archive-pruning.worker.js");
    return withSqliteSessionDatabase(options, (database) =>
      readSessionArchivePruningInDatabase(database),
    );
  }
  const physical = readDatabasePathIdentitySync(options.path);
  if (!physical.key.startsWith("file:")) {
    return null;
  }
  const databaseOptions = { ...options, path: physical.canonicalPath };
  const expectedIdentity: AgentDatabaseExecutionFileIdentity = {
    kind: "file",
    physicalIdentity: physical.key.slice("file:".length),
    nativeLocation: physical.canonicalPath,
  };
  assertExistingDatabaseIdentity(options.path, physical.key);
  return withSessionHistoryWorkerDatabase(
    { ...databaseOptions, requestedPaths: [options.path] },
    async (reader) => {
      assertExistingDatabaseIdentity(options.path, physical.key);
      const result = await reader.readArchivePruning({
        env: databaseOptions.env,
        expectedIdentity,
      });
      reader.assertCurrent();
      assertExistingDatabaseIdentity(options.path, physical.key);
      return result;
    },
  );
}

/** Retain source custody across the sweep; archive removals and page units admit separately. */
export async function withSqliteSessionPageReclamation<T>(
  input: OpenClawAgentDatabaseOptions,
  run: (
    reclaim: SqliteSessionPageReclaimer,
    assertCurrent: () => void,
    databaseOptions: ReclamationDatabaseOptions,
    archives: SessionArchivePruningOperations,
  ) => Promise<T>,
  assertCallerCurrent?: () => void,
): Promise<T> {
  if (
    captureSessionActorStorageOwner(
      { ...input, storePath: input.path },
      { assertCurrent() {}, authorize() {} },
    )
  ) {
    throw new Error("Incognito sessions have no disk pages or archives to reclaim");
  }
  const options = resolveSessionReclamationDatabaseOptions(input);
  const nativeOwner = !supportsOpenClawAgentDatabaseExecution(options);
  // Capture the original alias before admission can wait. Workers use only this physical path.
  const physical = readDatabasePathIdentitySync(options.path);
  if (physical && !physical.key.startsWith("file:")) {
    throw new Error("SQLite archive pruning requires its existing database");
  }
  return withSqliteMutationWorkerLifetime(options, async (lifetime) => {
    const { signal } = lifetime;
    const assertCurrent = () => {
      lifetime.assertCurrent();
      assertCallerCurrent?.();
    };
    const withArchiveWriter = <Value>(
      databaseOptions: ReclamationDatabaseOptions,
      assertWriterCurrent: () => void,
      operation: () => Promise<Value>,
    ): Promise<Value> => {
      const write = () =>
        runExclusiveSqliteSessionWrite(
          databaseOptions,
          async () => {
            assertWriterCurrent();
            return operation();
          },
          "session.history.archive-prune",
        );
      // Cold restoration takes archive admission before its writer; pruning must keep that order.
      return physical ? runExclusiveSqliteTranscriptArchiveWorker(write, signal) : write();
    };
    if (nativeOwner) {
      // Explicit Doctor/cleanup maintenance retains its native owner.
      const {
        readSessionArchivePruningInDatabase,
        deletePublishedSessionArchiveInDatabase,
        removeLegacySessionArchiveInDatabase,
        pruneSessionArchivesByRetentionInDatabase,
      } = await import("./session-history-archive-pruning.worker.js");
      const databaseOptions = physical ? { ...options, path: physical.canonicalPath } : options;
      const assertNativeCurrent = () => {
        assertCurrent();
        if (physical) {
          assertExistingDatabaseIdentity(options.path, physical.key);
          assertExistingDatabaseIdentity(databaseOptions.path, physical.key);
        }
      };
      assertNativeCurrent();
      return run(
        (maxPages) =>
          runExclusiveSqliteSessionWrite(
            databaseOptions,
            async () =>
              withSqliteSessionDatabase(
                databaseOptions,
                (database) => {
                  assertNativeCurrent();
                  return database.walMaintenance.reclaimFreePages({
                    maxPages,
                    beforeMutation: assertNativeCurrent,
                    onCommit: assertNativeCurrent,
                  });
                },
                assertNativeCurrent,
              ),
            "session.history.free-pages",
          ),
        assertNativeCurrent,
        databaseOptions,
        {
          withWriter: (operation) =>
            withArchiveWriter(databaseOptions, assertNativeCurrent, operation),
          read: async () =>
            await withSqliteSessionDatabase(
              databaseOptions,
              (database) => {
                assertNativeCurrent();
                return readSessionArchivePruningInDatabase(database).archives[0] ?? null;
              },
              assertNativeCurrent,
            ),
          readRetentionCandidates: async (offset = 0) =>
            withSqliteSessionDatabase(
              databaseOptions,
              (database) =>
                readSessionArchivePruningInDatabase(database, ARCHIVE_RETENTION_BATCH_SIZE, offset)
                  .archives,
              assertNativeCurrent,
            ),
          pruneRetention: async (retention) =>
            withSqliteSessionDatabase(
              databaseOptions,
              (database) =>
                pruneSessionArchivesByRetentionInDatabase(
                  database,
                  databaseOptions,
                  retention,
                  assertNativeCurrent,
                ),
              assertNativeCurrent,
            ),
          removeLegacy: async (filePath) =>
            await withSqliteSessionDatabase(
              databaseOptions,
              (database) =>
                removeLegacySessionArchiveInDatabase(
                  database,
                  databaseOptions,
                  filePath,
                  assertNativeCurrent,
                ),
              assertNativeCurrent,
            ),
          deletePublished: async (row) =>
            await withSqliteSessionDatabase(
              databaseOptions,
              (database) => {
                deletePublishedSessionArchiveInDatabase(
                  database,
                  databaseOptions,
                  row,
                  assertNativeCurrent,
                );
              },
              assertNativeCurrent,
            ),
        },
      );
    }
    if (!physical) {
      throw new Error("SQLite archive pruning requires its existing file owner");
    }
    const databaseOptions = { ...options, path: physical.canonicalPath };
    const expectedIdentity: AgentDatabaseExecutionFileIdentity = {
      kind: "file",
      physicalIdentity: physical.key.slice("file:".length),
      nativeLocation: physical.canonicalPath,
    };
    // The owner also routes later captures through this alias; admission may have waited.
    assertExistingDatabaseIdentity(options.path, physical.key);
    const execution = captureOpenClawAgentDatabaseExecution(databaseOptions, {
      expectedIdentity,
      requestedPath: options.path,
    });
    const assertPruningCurrent = () => {
      assertCurrent();
      execution.assertCurrent();
      assertExistingDatabaseIdentity(options.path, physical.key);
      assertExistingDatabaseIdentity(databaseOptions.path, physical.key);
    };
    const source = createSessionWorkerExecutionSource(
      assertPruningCurrent,
      "SQLite archive pruning authority expired",
    );
    const write = async <Value>(
      operation: (
        worker: Pick<SqliteWorkerStore<AgentDatabaseOperations>, "execute">,
      ) => Promise<Value>,
      label: "session.history.free-pages" | "session.history.archive-prune",
    ): Promise<Value> => {
      const result = await runExclusiveSqliteSessionWrite(
        databaseOptions,
        async () => {
          assertPruningCurrent();
          return execution.runExisting(
            source,
            async (worker) => ({ value: await operation(worker) }),
            {
              retireNativeOnFailure: true,
            },
          );
        },
        label,
        undefined,
        "worker",
      );
      assertPruningCurrent();
      if (!result) {
        throw new Error("SQLite archive pruning lost its prepared database");
      }
      return result.value;
    };
    try {
      assertPruningCurrent();
      return await withSessionHistoryWorkerDatabase(
        { ...databaseOptions, requestedPaths: [options.path] },
        async (reader) => {
          assertPruningCurrent();
          return run(
            async (maxPages) => {
              const result = await write(
                (worker) =>
                  worker.execute({
                    type: "session.archivePruning.reclaimPages",
                    input: { maxPages },
                  }),
                "session.history.free-pages",
              );
              if (result.checkpoint) {
                result.checkpoint = publishSqliteWalCheckpointObservation(
                  databaseOptions.path,
                  result.checkpoint,
                );
              }
              return result;
            },
            assertPruningCurrent,
            databaseOptions,
            {
              withWriter: (operation) =>
                withArchiveWriter(databaseOptions, assertPruningCurrent, operation),
              read: async () => {
                assertPruningCurrent();
                const result = await reader.readArchivePruning({
                  env: databaseOptions.env,
                  expectedIdentity,
                });
                assertPruningCurrent();
                return result.archives[0] ?? null;
              },
              readRetentionCandidates: async (offset = 0) => {
                assertPruningCurrent();
                const result = await reader.readArchivePruning({
                  env: databaseOptions.env,
                  expectedIdentity,
                  limit: ARCHIVE_RETENTION_BATCH_SIZE,
                  offset,
                });
                assertPruningCurrent();
                return result.archives;
              },
              pruneRetention: (retention) =>
                write(
                  (worker) =>
                    worker.execute({
                      type: "session.archivePruning.pruneRetention",
                      input: retention,
                    }),
                  "session.history.archive-prune",
                ),
              removeLegacy: (filePath) =>
                write(
                  (worker) =>
                    worker.execute({
                      type: "session.archivePruning.removeLegacy",
                      input: { filePath },
                    }),
                  "session.history.archive-prune",
                ),
              deletePublished: (row) =>
                write(
                  (worker) =>
                    worker.execute({
                      type: "session.archivePruning.deletePublished",
                      input: row,
                    }),
                  "session.history.archive-prune",
                ),
            },
          );
        },
        maintenanceLane,
      );
    } finally {
      await execution.release();
    }
  });
}
