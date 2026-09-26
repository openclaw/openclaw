import { registerSqliteWalWorkerMaintenance } from "../infra/sqlite-wal-write-admission.js";
import { createSqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import {
  runQueuedStoreWrite,
  type StoreWriterQueue,
  type StoreWriterTiming,
} from "../shared/store-writer-queue.js";
import type {
  OpenClawAgentDatabase,
  OpenClawAgentDatabaseOptions,
} from "./openclaw-agent-db-contract.js";
import { readOpenClawAgentDatabaseIdentity } from "./openclaw-agent-db-identity.js";
import { agentDatabaseLifecycle, retainAgentDatabase } from "./openclaw-agent-db-lifecycle.js";
import { registerOpenClawAgentDatabaseAsyncResource } from "./openclaw-agent-db-resources.js";
import { resolveOpenClawAgentSqlitePath } from "./openclaw-agent-db.paths.js";

// Native and SDK module graphs share the same queue and worker reservation.
// A second queue would admit a foreground writer while reclamation owns SQLite.
const admission = resolveGlobalSingleton(
  Symbol.for("openclaw.agentDatabaseWriteAdmission"),
  () => ({
    queues: new Map<string, StoreWriterQueue>(),
    workers: new Map<string, object>(),
  }),
);

export const SQLITE_SESSION_WRITER_QUEUES = admission.queues;

/** Keep the published timer's exact native owner pinned through worker settlement. */
export function registerOpenClawAgentWalMaintenance(
  database: OpenClawAgentDatabase,
  env: NodeJS.ProcessEnv,
): void {
  const options = { agentId: database.agentId, path: database.path, env };
  const identity = readOpenClawAgentDatabaseIdentity(database);
  if (typeof identity.identity !== "string") {
    return;
  }
  const expectedIdentity = {
    kind: "file" as const,
    physicalIdentity: identity.identity,
    birthtime: identity.birthtime,
    nativeLocation: identity.filename,
  };
  const controller = new AbortController();
  let pending: Promise<unknown> | undefined;
  let unregister: (() => void) | undefined;
  const cancel = () => {
    controller.abort();
  };
  const assertCurrent = () => {
    controller.signal.throwIfAborted();
    if (agentDatabaseLifecycle.databases.get(database.path) !== database || !database.db.isOpen) {
      throw new Error("Agent WAL maintenance owner changed");
    }
  };
  registerSqliteWalWorkerMaintenance(
    database.db,
    async (request) => {
      if (controller.signal.aborted) {
        return undefined;
      }
      const release = retainAgentDatabase(database.db);
      const active = runOpenClawAgentWorkerWrite(
        options,
        async () => {
          assertCurrent();
          unregister = registerOpenClawAgentDatabaseAsyncResource({
            ...options,
            revoke: cancel,
            async close() {
              cancel();
              await pending?.catch(() => {});
            },
          });
          const { captureOpenClawAgentDatabaseExecution } =
            await import("./openclaw-agent-execution.js");
          assertCurrent();
          const execution = captureOpenClawAgentDatabaseExecution(options, { expectedIdentity });
          try {
            const result = await execution.runExisting(
              {
                assertCurrent,
                createAdmission: (binding) => () => ({
                  nativeLocations: binding.nativeLocations,
                  admission: createSqliteWorkerOperationAdmission((authority, grant) => {
                    binding.authorize(authority);
                    assertCurrent();
                    if (!grant()) {
                      throw new Error("Agent WAL maintenance authority expired");
                    }
                  }, binding.attachment),
                }),
              },
              (worker) => worker.execute({ type: "database.walMaintenance", input: request }),
            );
            assertCurrent();
            execution.assertCurrent();
            return result;
          } finally {
            await execution.release();
          }
        },
        undefined,
        controller.signal,
      );
      pending = active;
      try {
        return await active;
      } finally {
        release();
        pending = undefined;
        unregister?.();
        unregister = undefined;
      }
    },
    cancel,
  );
}

export function runOpenClawAgentWriteAdmission<T>(
  options: OpenClawAgentDatabaseOptions,
  run: () => Promise<T> | T,
  reentrant = false,
  timing?: StoreWriterTiming,
  signal?: AbortSignal,
): Promise<T> {
  const storePath = resolveOpenClawAgentSqlitePath(options);
  return runQueuedStoreWrite({
    queues: admission.queues,
    storePath,
    label: "agent database write admission",
    // Worker callbacks inherit their parent's async context, but not its native
    // writer lock. Their foreground writes must queue, never reenter that owner.
    reentrant: reentrant && !admission.workers.has(storePath),
    fn: async () => await run(),
    timing,
    signal,
  });
}

/** Reserve a native write permit without admitting inherited foreground callbacks. */
export function runOpenClawAgentWorkerWrite<T>(
  options: OpenClawAgentDatabaseOptions,
  run: () => Promise<T>,
  timing?: StoreWriterTiming,
  signal?: AbortSignal,
): Promise<T> {
  const storePath = resolveOpenClawAgentSqlitePath(options);
  return runOpenClawAgentWriteAdmission(
    options,
    async () => {
      const owner = {};
      admission.workers.set(storePath, owner);
      try {
        return await run();
      } finally {
        if (admission.workers.get(storePath) === owner) {
          admission.workers.delete(storePath);
        }
      }
    },
    true,
    timing,
    signal,
  );
}
