import fsSync from "node:fs";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { StatementSync } from "node:sqlite";
import { vi } from "vitest";
import { createDeferredCore } from "../../shared/deferred.js";

const workerCounter = vi.hoisted(() => ({
  enabled: false,
  reads: 0,
  operations: 0,
  catalogPersisted: undefined as ((namespace: string) => void) | undefined,
  catalogPersistenceFailed: undefined as ((error: unknown) => void) | undefined,
}));
vi.mock("../../plugin-state/plugin-state-worker-client.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../plugin-state/plugin-state-worker-client.js")>();
  function count<Args extends unknown[], Result>(
    operation: (...args: Args) => Result,
    read = false,
  ) {
    return (...args: Args): Result => {
      if (workerCounter.enabled) {
        workerCounter.operations++;
        if (read) {
          workerCounter.reads++;
        }
      }
      return operation(...args);
    };
  }
  return {
    ...actual,
    executePluginStateOperationInWorker: count(actual.executePluginStateOperationInWorker),
    replacePluginStateInWorker: count(actual.replacePluginStateInWorker),
    replacePluginStateEntryInWorker: count(actual.replacePluginStateEntryInWorker),
    observePluginStateRowInWorker: count(actual.observePluginStateRowInWorker),
    observePluginStateInWorker: count(actual.observePluginStateInWorker, true),
    comparePluginStateUpdateInWorker: count(actual.comparePluginStateUpdateInWorker),
    comparePluginStateDeleteInWorker: count(actual.comparePluginStateDeleteInWorker),
    registerPluginStateIfAbsentInWorker: count(actual.registerPluginStateIfAbsentInWorker),
    deletePluginStateIfEqualInWorker: count(actual.deletePluginStateIfEqualInWorker),
    lookupPluginStateInWorker: count(actual.lookupPluginStateInWorker, true),
    lookupManyPluginStateInWorker: count(actual.lookupManyPluginStateInWorker, true),
    consumePluginStateInWorker: count(actual.consumePluginStateInWorker),
    deletePluginStateInWorker: count(actual.deletePluginStateInWorker),
    listPluginStateInWorker: count(actual.listPluginStateInWorker, true),
    clearPluginStateInWorker: count(actual.clearPluginStateInWorker),
    clearRuntimeHealthInWorker: count(actual.clearRuntimeHealthInWorker),
    countPluginStateInWorker: count(actual.countPluginStateInWorker, true),
    registerPluginStateJournalInWorker: count(actual.registerPluginStateJournalInWorker),
    listPluginStateInKeyRangeInWorker: count(actual.listPluginStateInKeyRangeInWorker, true),
    movePluginStateEntriesInWorker: count(actual.movePluginStateEntriesInWorker),
    registerPluginStateInWorker: async (
      params: Parameters<typeof actual.registerPluginStateInWorker>[0],
    ) => {
      if (workerCounter.enabled) {
        workerCounter.operations++;
      }
      const catalogState =
        params.pluginId === "codex" && params.namespace.startsWith("session-catalog-resident.");
      try {
        await actual.registerPluginStateInWorker(params);
      } catch (error) {
        if (catalogState) {
          workerCounter.catalogPersistenceFailed?.(error);
        }
        throw error;
      }
      if (catalogState && params.key === "complete") {
        workerCounter.catalogPersisted?.(params.namespace);
      }
    },
  };
});

const empty = () => ({
  sqliteReadCalls: 0,
  sqliteFreshnessReads: 0,
  sessionEntryReads: 0,
  sessionPayloadReads: 0,
  bindingAuthorityReads: 0,
  fileReadCalls: 0,
  ownershipFileReadCalls: 0,
  fileOpenCalls: 0,
  ownershipFileOpenCalls: 0,
  nativeRpcCalls: 0,
});

/** Call-through instrumentation records counts only, never SQLite or RPC result objects. */
export function createCatalogIoCounters() {
  let counts = empty();
  let ownershipFile: Pick<fsSync.BigIntStats, "dev" | "ino"> | undefined;
  const catalogPersistence = createDeferredCore<string>();
  const catalogStarted = createDeferredCore();
  // Persistence may fail before the public setup request returns and joins this promise.
  void catalogPersistence.promise.catch(() => {});
  void catalogStarted.promise.catch(() => {});
  workerCounter.catalogPersistenceFailed = (error) => {
    catalogStarted.reject(error);
    catalogPersistence.reject(error);
  };
  const setupProgress = { nativeListRequests: 0, catalogPersisted: false };
  workerCounter.catalogPersisted = (namespace) => {
    setupProgress.catalogPersisted = true;
    catalogPersistence.resolve(namespace);
  };
  const restore: Array<() => void> = [];
  const isOwnershipFile = (fd: unknown): boolean => {
    if (!ownershipFile || typeof fd !== "number") {
      return false;
    }
    try {
      const current = fsSync.fstatSync(fd, { bigint: true });
      return current.dev === ownershipFile.dev && current.ino === ownershipFile.ino;
    } catch {
      // Instrumentation must leave descriptor errors to the original operation.
      return false;
    }
  };
  function replace(target: object, key: string, value: unknown) {
    const descriptor = Object.getOwnPropertyDescriptor(target, key);
    if (!descriptor) {
      throw new Error(`Missing instrumented method ${key}`);
    }
    Object.defineProperty(target, key, { ...descriptor, value });
    restore.push(() => Object.defineProperty(target, key, descriptor));
  }
  for (const method of ["get", "all", "iterate"] as const) {
    const original = StatementSync.prototype[method];
    replace(StatementSync.prototype, method, function (this: StatementSync, ...args: unknown[]) {
      if (workerCounter.enabled) {
        counts.sqliteReadCalls++;
        const sql = this.sourceSQL.toLowerCase();
        if (sql.includes("session_nodes") || sql.includes("session_participants")) {
          counts.sessionEntryReads++;
        }
        if (args.includes("app-server-thread-bindings")) {
          counts.bindingAuthorityReads++;
        } else if (sql.includes("pragma data_version") || sql.includes("pragma schema_version")) {
          counts.sqliteFreshnessReads++;
        } else if (sql.includes("entry_json") || sql.includes("entry_list_json")) {
          counts.sessionPayloadReads++;
        }
      }
      return Reflect.apply(original, this, args);
    });
  }
  for (const [target, method] of [
    [fsSync, "readFileSync"],
    [fsSync, "readSync"],
    [fsSync, "openSync"],
    [fsSync, "read"],
    [fsSync, "readFile"],
    [fsSync, "open"],
    [fs, "readFile"],
    [fs, "open"],
  ] as const) {
    const original = Reflect.get(target, method);
    replace(target, method, function (this: unknown, ...args: unknown[]) {
      const opening = method === "open" || method === "openSync";
      if (workerCounter.enabled) {
        counts[opening ? "fileOpenCalls" : "fileReadCalls"]++;
        if (!opening && isOwnershipFile(args[0])) {
          counts.ownershipFileReadCalls++;
        }
      }
      const result = Reflect.apply(original, this, args);
      if (workerCounter.enabled && method === "openSync" && isOwnershipFile(result)) {
        counts.ownershipFileOpenCalls++;
      }
      return result;
    });
  }
  syncBuiltinESMExports();
  const snapshot = () => ({
    ...counts,
    pluginStateWorkerReadOperations: workerCounter.reads,
    pluginStateWorkerOperations: workerCounter.operations,
  });
  return {
    snapshot,
    observeOwnershipFile(pathname: string) {
      // Classify the acquired lease's physical file, independently of bundled module identities.
      ownershipFile = fsSync.statSync(pathname, { bigint: true });
    },
    catalogPersisted: catalogPersistence.promise,
    catalogStarted: catalogStarted.promise,
    setupProgress: () => ({ ...setupProgress }),
    nativeRequest(method: string) {
      if (method === "thread/list") {
        setupProgress.nativeListRequests++;
        catalogStarted.resolve();
      }
      if (!workerCounter.enabled) {
        return;
      }
      counts.nativeRpcCalls++;
    },
    begin() {
      counts = empty();
      workerCounter.reads = 0;
      workerCounter.operations = 0;
      workerCounter.enabled = true;
    },
    end() {
      workerCounter.enabled = false;
      return snapshot();
    },
    close() {
      workerCounter.catalogPersisted = undefined;
      workerCounter.catalogPersistenceFailed = undefined;
      workerCounter.enabled = false;
      for (const undo of restore.toReversed()) {
        undo();
      }
      syncBuiltinESMExports();
    },
  };
}
