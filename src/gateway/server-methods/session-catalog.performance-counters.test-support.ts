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
}));
vi.mock("../../plugin-state/plugin-state-worker-client.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../plugin-state/plugin-state-worker-client.js")>();
  const counted = Object.fromEntries(
    Object.entries(actual).map(([name, value]) => [
      name,
      typeof value !== "function"
        ? value
        : (...args: unknown[]) => {
            if (workerCounter.enabled) {
              workerCounter.operations++;
              if (
                [
                  "lookupPluginStateInWorker",
                  "lookupManyPluginStateInWorker",
                  "listPluginStateInWorker",
                  "listPluginStateInKeyRangeInWorker",
                  "countPluginStateInWorker",
                  "observePluginStateInWorker",
                ].includes(name)
              ) {
                workerCounter.reads++;
              }
            }
            return Reflect.apply(value, undefined, args);
          },
    ]),
  );
  return {
    ...counted,
    registerPluginStateInWorker: async (
      params: Parameters<typeof actual.registerPluginStateInWorker>[0],
    ) => {
      if (workerCounter.enabled) {
        workerCounter.operations++;
      }
      await actual.registerPluginStateInWorker(params);
      if (
        params.pluginId === "codex" &&
        params.namespace.startsWith("session-catalog-resident.") &&
        params.key === "complete"
      ) {
        workerCounter.catalogPersisted?.(params.namespace);
      }
    },
  };
});

type Counts = {
  sqliteReadCalls: number;
  sqliteFreshnessReads: number;
  sessionEntryReads: number;
  sessionPayloadReads: number;
  bindingAuthorityReads: number;
  otherSqliteReads: number;
  fileReadCalls: number;
  fileOpenCalls: number;
  nativeRpcCalls: number;
  nativeThreadListCalls: number;
};
const empty = (): Counts => ({
  sqliteReadCalls: 0,
  sqliteFreshnessReads: 0,
  sessionEntryReads: 0,
  sessionPayloadReads: 0,
  bindingAuthorityReads: 0,
  otherSqliteReads: 0,
  fileReadCalls: 0,
  fileOpenCalls: 0,
  nativeRpcCalls: 0,
  nativeThreadListCalls: 0,
});

/** Call-through instrumentation records counts only, never SQLite or RPC result objects. */
export function createCatalogIoCounters() {
  let enabled = false;
  let counts = empty();
  const catalogPersistence = createDeferredCore<string>();
  workerCounter.catalogPersisted = catalogPersistence.resolve;
  const restore: Array<() => void> = [];
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
      if (enabled) {
        counts.sqliteReadCalls++;
        const sql = this.sourceSQL.toLowerCase();
        if (sql.includes("session_nodes") || sql.includes("session_participants")) {
          counts.sessionEntryReads++;
        }
        if (args.includes("app-server-thread-bindings")) {
          counts.bindingAuthorityReads++;
        } else if (
          sql.includes("pragma data_version") ||
          sql.includes("pragma schema_version") ||
          sql.includes("openclaw_session_nodes_cache_generation")
        ) {
          counts.sqliteFreshnessReads++;
        } else if (sql.includes("entry_json") || sql.includes("entry_list_json")) {
          counts.sessionPayloadReads++;
        } else {
          counts.otherSqliteReads++;
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
      if (enabled) {
        if (method === "open" || method === "openSync") {
          counts.fileOpenCalls++;
        } else {
          counts.fileReadCalls++;
        }
      }
      return Reflect.apply(original, this, args);
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
    catalogPersisted: catalogPersistence.promise,
    nativeRequest(method: string) {
      if (!enabled) {
        return;
      }
      counts.nativeRpcCalls++;
      if (method === "thread/list") {
        counts.nativeThreadListCalls++;
      }
    },
    begin() {
      counts = empty();
      workerCounter.reads = 0;
      workerCounter.operations = 0;
      workerCounter.enabled = true;
      enabled = true;
    },
    end() {
      enabled = false;
      workerCounter.enabled = false;
      return snapshot();
    },
    close() {
      workerCounter.catalogPersisted = undefined;
      enabled = false;
      workerCounter.enabled = false;
      for (const undo of restore.toReversed()) {
        undo();
      }
      syncBuiltinESMExports();
    },
  };
}
