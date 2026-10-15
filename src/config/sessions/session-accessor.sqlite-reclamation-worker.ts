import path from "node:path";
import { sqliteReaderDatabasePathKey } from "../../infra/sqlite-reader-lifecycle.js";
import { assertExistingDatabaseIdentity } from "../../infra/sqlite-worker-identity.js";
import { KeyedAsyncQueue } from "../../plugin-sdk/keyed-async-queue.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import type { OpenClawAgentDatabaseClaim } from "../../state/openclaw-agent-db-identity.js";
import { registerOpenClawAgentDatabaseAsyncResource } from "../../state/openclaw-agent-db-lifecycle.js";
import { runOutsideOpenClawDatabaseMaintenanceScope } from "../../state/openclaw-state-db-async-lifecycle.js";
import { runExclusiveSqliteTranscriptArchiveWorker } from "./session-accessor.sqlite-archive.js";
import {
  captureCanonicalValidationWorkerPool,
  type CanonicalWorkerPool,
} from "./session-accessor.sqlite-canonical-worker-pool.js";
import type { SqliteSessionReclamationPlan } from "./session-accessor.sqlite-lifecycle-types.js";
import { SqliteReclamationWorker } from "./session-accessor.sqlite-reclamation-worker-lifetime.js";
import type {
  SqliteReclamationClaim,
  SqliteReclamationExistingSource,
} from "./session-accessor.sqlite-reclamation-worker.types.js";

type DatabaseOptions = SqliteSessionReclamationPlan["databaseOptions"];
type ReclamationWorkerSlot = {
  worker?: SqliteReclamationWorker;
  execution?: CanonicalWorkerPool;
  retain?: (worker: SqliteReclamationWorker) => void;
  retire?: (worker: SqliteReclamationWorker) => void;
  alias?: string;
};
const retained = resolveGlobalSingleton(
  Symbol.for("openclaw.sessionReclamationWorkers"),
  () => new Map<string, SqliteReclamationWorker>(),
);
// Workers run at the physical path, but cleanup selects the locators callers captured.
// A retained Worker keeps every requester's alias registered until it retires.
const retainedAliases = resolveGlobalSingleton(
  Symbol.for("openclaw.sessionReclamationWorkerAliases"),
  () => new WeakMap<SqliteReclamationWorker, Map<string, () => void>>(),
);

function retainWorkerAlias(
  worker: SqliteReclamationWorker,
  options: DatabaseOptions,
  requestedPath: string,
): void {
  const alias = path.resolve(requestedPath);
  const aliases = retainedAliases.get(worker) ?? new Map<string, () => void>();
  if (alias === options.path || aliases.has(alias)) {
    return;
  }
  try {
    // The physical registration owns the Worker; an alias only selects it for cleanup.
    const unregister = runOutsideOpenClawDatabaseMaintenanceScope(() =>
      registerOpenClawAgentDatabaseAsyncResource({
        agentId: options.agentId,
        path: alias,
        revoke: () => worker.revoke(),
        close: () => worker.close(),
      }),
    );
    aliases.set(alias, unregister);
    retainedAliases.set(worker, aliases);
  } catch (error) {
    // A drain already selected this locator, so the reused Worker must retire with it.
    worker.revoke();
    throw error;
  }
}

function releaseWorkerAliases(worker: SqliteReclamationWorker): void {
  for (const unregister of retainedAliases.get(worker)?.values() ?? []) {
    unregister();
  }
  retainedAliases.delete(worker);
}

export type ClaimedReclamationWorkerUse = <T>(
  options: DatabaseOptions,
  claim: SqliteReclamationClaim,
  run: (worker: SqliteReclamationWorker) => Promise<T>,
  assertRequestCurrent: () => void,
  signal?: AbortSignal,
) => Promise<T>;

/**
 * The global archive FIFO bounds ordinary reclamation's whole-buffer heaps.
 * `requestedPath` is the caller's locator before it pinned `options.path` to the physical file.
 */
export function withSqliteReclamationWorker<T>(
  options: DatabaseOptions,
  source: SqliteReclamationClaim | SqliteReclamationExistingSource,
  run: (worker: SqliteReclamationWorker) => Promise<T>,
  assertRequestCurrent: () => void,
  signal?: AbortSignal,
  requestedPath?: string,
): Promise<T> {
  if (
    "key" in source &&
    (!source.key.startsWith("file:") || options.path !== source.canonicalPath)
  ) {
    return Promise.reject(new Error("SQLite reclamation requires its captured existing source"));
  }
  const expectedIdentity = "key" in source ? source.key.slice(5) : source.identity;
  const assertSourceCurrent = () => {
    if ("key" in source) {
      assertExistingDatabaseIdentity(options.path, source.key, source.birthtime);
    } else {
      source.assertCurrent();
    }
  };
  return runExclusiveSqliteTranscriptArchiveWorker(() => {
    const key = sqliteReaderDatabasePathKey(options.path);
    return useReclamationWorker(
      {
        worker: retained.get(key),
        retain: (worker) => retained.set(key, worker),
        retire: (worker) => {
          if (retained.get(key) === worker) {
            retained.delete(key);
          }
          releaseWorkerAliases(worker);
        },
        alias: requestedPath,
      },
      options,
      expectedIdentity,
      run,
      assertRequestCurrent,
      assertSourceCurrent,
    );
  }, signal);
}

/** Startup bounds these scopes; each keeps one worker through certification and native close. */
export async function withSqliteCanonicalValidationWorker<T>(
  run: (withWorker: ClaimedReclamationWorkerUse) => Promise<T>,
): Promise<T> {
  const slot: ReclamationWorkerSlot = { execution: captureCanonicalValidationWorkerPool() };
  const queue = new KeyedAsyncQueue();
  let closed = false;
  try {
    return await run((options, claim, consume, assertCurrent) =>
      queue.enqueue("canonical-validation", () => {
        if (closed) {
          throw new Error("Canonical validation Worker scope is closed");
        }
        return useReclamationWorker(slot, options, claim.identity, consume, assertCurrent, () =>
          claim.assertCurrent(),
        );
      }),
    );
  } finally {
    closed = true;
    await queue.enqueue("canonical-validation", async () => {
      await slot.worker?.close("exclusive-handoff");
    });
  }
}

async function useReclamationWorker<T>(
  slot: ReclamationWorkerSlot,
  options: DatabaseOptions,
  expectedIdentity: OpenClawAgentDatabaseClaim["identity"],
  run: (worker: SqliteReclamationWorker) => Promise<T>,
  assertRequestCurrent: () => void,
  assertSourceCurrent: () => void,
): Promise<T> {
  assertRequestCurrent();
  assertSourceCurrent();
  if (slot.worker && !slot.worker.matches(options, expectedIdentity)) {
    await slot.worker.close("matches-mismatch");
    slot.worker = undefined;
  }
  assertRequestCurrent();
  const worker = (slot.worker ??= new SqliteReclamationWorker(
    options,
    expectedIdentity,
    slot.execution,
    slot.retire,
  ));
  slot.retain?.(worker);
  try {
    if (slot.alias !== undefined) {
      retainWorkerAlias(worker, options, slot.alias);
    }
    return await worker.use(() => run(worker));
  } catch (error) {
    let reusable = false;
    try {
      assertSourceCurrent();
      worker.assertSourceCurrent(options, expectedIdentity);
      reusable = true;
    } catch {
      // Physical replacement, revocation and transport failures retire the connection.
    }
    if (reusable) {
      throw error;
    }
    // An uncertain mutation is never replayed; a replacement serves only a later request.
    try {
      await worker.close("failure");
      if (slot.worker === worker) {
        slot.worker = undefined;
      }
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "SQLite reclamation and cleanup failed", {
        cause: cleanupError,
      });
    }
    throw error;
  }
}
