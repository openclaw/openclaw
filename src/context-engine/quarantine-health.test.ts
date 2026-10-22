import { spawn } from "node:child_process";
import { mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { ensureCliPluginRegistryLoaded } from "../cli/plugin-registry-loader.js";
import {
  onInternalDiagnosticEvent,
  waitForDiagnosticEventsDrained,
} from "../infra/diagnostic-events.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import {
  createCorePluginStateSyncKeyedStore,
  resetPluginStateStoreForTests,
} from "../plugin-state/plugin-state-store.js";
import * as pluginStateWorker from "../plugin-state/plugin-state-worker-client.js";
import type { ContextEngineQuarantineRecord } from "../plugin-state/runtime-health-records.js";
import { createRuntimeHealthRecordEnvelope } from "../plugin-state/runtime-health-store.js";
import { loadOpenClawPlugins } from "../plugins/loader-runtime-load.js";
import {
  cleanupPluginLoaderFixturesForTest,
  resetPluginLoaderTestStateForTest,
  useNoBundledPlugins,
  writePlugin,
} from "../plugins/loader.test-fixtures.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import * as pluginRuntime from "../plugins/runtime.js";
import {
  captureActivePluginRegistrySnapshot as captureRegistry,
  restoreActivePluginRegistrySnapshot as restoreRegistry,
  setActivePluginRegistry,
  stageActivePluginRegistry,
} from "../plugins/runtime.js";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import { getProcessStartTime } from "../shared/pid-alive.js";
import { seedNativeVersionZeroState } from "../state/native-version-zero.test-support.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import { MockContextEngine } from "./context-engine.test-support.js";
import { ensureContextEnginesInitialized } from "./init.js";
import {
  clearPersistedContextEngineQuarantineForProcess as clearPersisted,
  listPersistedContextEngineQuarantines as listPersisted,
  recordPersistedContextEngineQuarantine as recordPersisted,
} from "./quarantine-health.js";
import {
  getContextEngineQuarantine,
  recordContextEngineQuarantine,
} from "./registry-quarantine.js";
import * as engines from "./registry.js";
import { resetContextEngineRuntimeQuarantineForTests as resetQuarantine } from "./registry.test-support.js";

// Sibling records need a verifiable /proc starttime, so sibling-visibility
// coverage only runs where that identity source exists.
const hasProcessStartTimes = process.platform === "linux";

async function withLiveSiblingProcess<T>(fn: (pid: number) => Promise<T>): Promise<T> {
  return await withStateDirEnv("openclaw-context-engine-sibling-", async () => {
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30_000)"], {
      stdio: "ignore",
    });
    if (!child.pid) {
      throw new Error("failed to start live sibling process");
    }
    try {
      return await fn(child.pid);
    } finally {
      child.kill();
    }
  });
}

function seedRecord(record: ContextEngineQuarantineRecord): void {
  createCorePluginStateSyncKeyedStore<ContextEngineQuarantineRecord>({
    ownerId: "core:context-engine-quarantine-health",
    namespace: "runtime-quarantines",
    maxEntries: 64,
  }).register(JSON.stringify([record.engineId, record.processId]), record);
}

function makeQuarantine(overrides: Partial<Parameters<typeof recordPersisted>[0]> = {}) {
  return {
    engineId: "lossless-claw",
    owner: "plugin:lossless-claw",
    operation: "bootstrap",
    reason: "current process failure",
    failedAt: new Date(123),
    ...overrides,
  };
}

function seedSiblingQuarantineForTest(params: {
  processId: number;
  processStartTime: number | null;
  reason: string;
  failedAtMs: number;
}): void {
  seedRecord({
    engineId: "lossless-claw",
    owner: "plugin:lossless-claw",
    operation: "bootstrap",
    ...params,
    processToken: "sibling-process-token",
  });
}

function gateHealthCleanup() {
  const reached = createDeferredCore();
  const release = createDeferredCore();
  const clear = pluginStateWorker.clearRuntimeHealthInWorker;
  const observer = vi
    .spyOn(pluginStateWorker, "clearRuntimeHealthInWorker")
    .mockImplementation(async (params) => {
      reached.resolve();
      await release.promise;
      await clear(params);
    });
  return { reached, release, observer };
}

afterEach(() => {
  resetPluginStateStoreForTests();
});
afterAll(cleanupPluginLoaderFixturesForTest);

describe("context engine quarantine health", () => {
  it("warns when persisted quarantine inventory cannot be read", async () => {
    const read = vi
      .spyOn(pluginStateWorker, "listPluginStateInWorker")
      .mockRejectedValueOnce(new Error("synthetic health read failure: sensitive-row-fragment"));
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(await listPersisted()).toEqual([]);
      expect(warning).toHaveBeenCalledExactlyOnceWith(
        "[runtime-health] Persisted quarantine inventory is unavailable for runtime-quarantines; health warnings may be incomplete. Run openclaw doctor to inspect state storage.",
      );
    } finally {
      warning.mockRestore();
      read.mockRestore();
    }
  });

  it("does not dispatch health cleanup again on an empty warm turn", async () => {
    await withStateDirEnv("openclaw-context-engine-warm-health-", async () => {
      const previous = captureRegistry();
      setActivePluginRegistry(createEmptyPluginRegistry());
      // Keep a different engine's health row so the empty receipt must be selection-scoped.
      await recordPersisted(makeQuarantine());
      await ensureContextEnginesInitialized();
      await waitForDiagnosticEventsDrained();
      const queued: string[] = [];
      const unsubscribe = onInternalDiagnosticEvent(
        (event) => {
          if (
            event.type === "worker.request" &&
            event.requestClass === "plugin_state" &&
            event.phase === "queued"
          ) {
            queued.push(event.kind);
          }
        },
        { include: ["worker.request"] },
      );
      try {
        await ensureContextEnginesInitialized();
        await waitForDiagnosticEventsDrained();
        expect(queued).toEqual([]);
        expect(await listPersisted()).toEqual([makeQuarantine()]);
        await clearPersisted("lossless-claw", process.pid);
        expect(await listPersisted()).toEqual([]);
      } finally {
        unsubscribe();
        restoreRegistry(previous);
      }
    });
  });

  it("invalidates empty health receipts after worker and native registrations", async () => {
    await withStateDirEnv("openclaw-context-engine-health-receipt-", async () => {
      await recordPersisted(makeQuarantine({ engineId: "other" }));
      await clearPersisted("lossless-claw", process.pid);
      // Queue without awaiting: the clear must follow the accepted namespace write.
      const write = recordPersisted(makeQuarantine());
      await clearPersisted("lossless-claw", process.pid);
      await write;
      expect((await listPersisted()).map((record) => record.engineId)).toEqual(["other"]);

      await clearPersisted("lossless-claw", process.pid);
      seedRecord({
        engineId: "lossless-claw",
        operation: "bootstrap",
        reason: "native registration",
        ...createRuntimeHealthRecordEnvelope(new Date(123)),
      });
      await clearPersisted("lossless-claw", process.pid);
      expect((await listPersisted()).map((record) => record.engineId)).toEqual(["other"]);
    });
  });

  it.each(["absent", "native-only"])(
    "does not create or adopt %s state during health cleanup",
    async (mode) => {
      await withStateDirEnv("openclaw-context-engine-quarantine-", async ({ stateDir }) => {
        if (mode === "absent") {
          expect(readdirSync(stateDir)).toEqual([]);
          await clearPersisted(undefined, process.pid);
          expect(readdirSync(stateDir)).toEqual([]);
          return;
        }
        const { DatabaseSync } = requireNodeSqlite();
        const databasePath = resolveOpenClawStateSqlitePath();
        expect(databasePath.startsWith(`${stateDir}${path.sep}`)).toBe(true);
        mkdirSync(path.dirname(databasePath), { recursive: true });
        const schemaSql = "SELECT type, name, sql FROM sqlite_schema ORDER BY type, name";
        const before = (() => {
          const database = new DatabaseSync(databasePath);
          try {
            seedNativeVersionZeroState(database, false);
            return database.prepare(schemaSql).all();
          } finally {
            database.close();
          }
        })();
        await clearPersisted(undefined, process.pid);
        const readOnly = new DatabaseSync(databasePath, { readOnly: true });
        try {
          expect(readOnly.prepare("PRAGMA user_version").get()).toEqual({ user_version: 0 });
          expect(readOnly.prepare(schemaSql).all()).toEqual(before);
        } finally {
          readOnly.close();
        }
      });
    },
  );

  it.each([false, true])(
    "keeps accepted registration when its health cleanup is superseded (%s)",
    async (superseded) => {
      await withStateDirEnv("openclaw-context-engine-registration-", async () => {
        const previous = captureRegistry();
        const registry = previous.activeRegistry ?? createEmptyPluginRegistry();
        if (!previous.activeRegistry) {
          setActivePluginRegistry(registry);
        }
        const publication = captureRegistry();
        const engineId = `health-registration-${superseded}`;
        const record = makeQuarantine({
          engineId,
          owner: "plugin:health-registration",
          operation: "resolve",
          reason: "not registered",
        });
        await recordPersisted(record);
        const { reached, release, observer } = gateHealthCleanup();
        const registration = engines.registerContextEngineForOwner(
          engineId,
          () => new MockContextEngine(),
          "test:health-registration",
        );
        const observed = registration.then(
          (result) => ({ result }),
          (error: unknown) => ({ error }),
        );
        try {
          await reached.promise;
          if (superseded) {
            stageActivePluginRegistry(
              createEmptyPluginRegistry(),
              null,
              publication.runtimeSubagentMode,
              publication.workspaceDir ?? undefined,
            );
          }
          release.resolve();
          expect(await observed).toEqual({ result: { ok: true } });
          expect(registry.contextEngines.get(engineId)?.owner).toBe("test:health-registration");
          expect(await listPersisted()).toEqual(superseded ? [record] : []);
        } finally {
          release.resolve();
          await observed;
          observer.mockRestore();
          registry.contextEngines.delete(engineId);
          restoreRegistry(previous);
        }
      });
    },
  );

  it.runIf(hasProcessStartTimes).each(["engine", "process"])(
    "clears the selected %s records while preserving live sibling quarantines",
    async (scope) => {
      await withLiveSiblingProcess(async (siblingProcessId) => {
        const record = makeQuarantine();
        await recordPersisted(record);
        expect(await engines.listContextEngineQuarantines()).toEqual([record]);
        if (scope === "process") {
          seedRecord({
            engineId: "local-b",
            operation: "assemble",
            reason: "current process failure b",
            ...createRuntimeHealthRecordEnvelope(new Date(234)),
          });
        }
        seedSiblingQuarantineForTest({
          reason: "sibling process failure",
          failedAtMs: 789,
          processId: siblingProcessId,
          processStartTime: getProcessStartTime(siblingProcessId),
        });
        if (scope === "engine") {
          await clearPersisted("lossless-claw", process.pid);
        } else {
          await resetQuarantine();
        }
        expect(await engines.listContextEngineQuarantines()).toEqual([
          makeQuarantine({
            reason: "sibling process failure",
            failedAt: new Date(789),
          }),
        ]);
      });
    },
  );

  it.each(["stale incarnation", "unverified sibling"])("drops %s records", async (mode) => {
    await withLiveSiblingProcess(async (siblingProcessId) => {
      await resetQuarantine();
      seedRecord({
        engineId: "lossless-claw",
        owner: "plugin:lossless-claw",
        operation: "bootstrap",
        reason: "stale process failure",
        ...createRuntimeHealthRecordEnvelope(new Date(123)),
        processToken: "stale-incarnation-token",
        ...(mode === "unverified sibling"
          ? { processId: siblingProcessId, processStartTime: null }
          : {}),
      });
      expect(await engines.listContextEngineQuarantines()).toEqual([]);
    });
  });

  it.runIf(hasProcessStartTimes)("drops records from a reused sibling PID", async () => {
    await withLiveSiblingProcess(async (processId) => {
      await resetQuarantine();
      seedSiblingQuarantineForTest({
        reason: "stale process failure",
        failedAtMs: 123,
        processId,
        processStartTime: (getProcessStartTime(processId) ?? 0) + 1,
      });
      expect(await engines.listContextEngineQuarantines()).toEqual([]);
    });
  });

  it.each([
    "cold",
    "cached",
    "sync",
    "sync superseded",
    "superseded",
    "new failure",
    "publication throws",
    "cached publication throws",
  ] as const)("joins worker-backed activation health cleanup (%s)", async (mode) => {
    await withStateDirEnv("openclaw-activation-quarantine-", async () => {
      useNoBundledPlugins();
      const previous = captureRegistry();
      const engineId = "activation-health";
      const plugin = writePlugin({
        id: engineId,
        registration: `api.registerContextEngine(${JSON.stringify(engineId)}, () => ({}));`,
      });
      const config = {
        plugins: {
          allow: [plugin.id],
          load: { paths: [plugin.file] },
          slots: { memory: "none" },
        },
      };
      const publicationThrows =
        mode === "publication throws" || mode === "cached publication throws";
      let cachedRegistry: ReturnType<typeof pluginRuntime.getActivePluginRegistry> | undefined;
      if (mode === "cached" || mode === "cached publication throws") {
        await ensureCliPluginRegistryLoaded({ scope: "all", config });
        cachedRegistry = pluginRuntime.getActivePluginRegistry();
      }
      const quarantine = {
        engineId,
        operation: "resolve",
        error: new Error("previous failure"),
        defaultEngineId: "legacy",
      };
      await recordContextEngineQuarantine(quarantine);
      const original = getContextEngineQuarantine(engineId);
      const { reached, release, observer } = gateHealthCleanup();
      const failure = new Error("publication rejected");
      const commit = vi.spyOn(pluginRuntime, "commitStagedPluginRegistry");
      if (publicationThrows) {
        commit.mockImplementationOnce(() => {
          throw failure;
        });
      }
      const { DatabaseSync } = requireNodeSqlite();
      const prepare = vi.spyOn(DatabaseSync.prototype, "prepare");
      const activate = engines.activateContextEngineRegistrations;
      let activationHostPrepares = 0;
      const activationObserver = vi
        .spyOn(engines, "activateContextEngineRegistrations")
        .mockImplementation((...args) => {
          const before = prepare.mock.calls.length;
          try {
            return activate(...args);
          } finally {
            activationHostPrepares += prepare.mock.calls.length - before;
          }
        });
      let settled = false;
      const load = () => {
        if (mode === "sync" || mode === "sync superseded") {
          const work = new AsyncWorkScope();
          work.run(() => loadOpenClawPlugins({ config }));
          return work.drain();
        }
        return ensureCliPluginRegistryLoaded({ scope: "all", config });
      };
      const loading = load()
        .then(
          () => undefined,
          (error: unknown) => error,
        )
        .finally(() => {
          settled = true;
        });
      let retirement: ReturnType<typeof pluginRuntime.waitForPluginRegistryRetirement> | undefined;
      try {
        const phase = await Promise.race([
          reached.promise.then(() => "worker"),
          loading.then(() => "settled"),
        ]);
        expect.soft(activationHostPrepares).toBe(0);
        expect(phase).toBe("worker");
        if (cachedRegistry) {
          expect(activationObserver.mock.calls[0]?.[0]).toBe(cachedRegistry);
        }
        prepare.mockRestore();
        expect(settled).toBe(false);
        expect(getContextEngineQuarantine(engineId)).toBeUndefined();
        if (mode === "superseded" || mode === "sync superseded") {
          const supersededRegistry = pluginRuntime.getActivePluginRegistry();
          pluginRuntime.setActivePluginRegistry(createEmptyPluginRegistry());
          if (supersededRegistry) {
            retirement = pluginRuntime.waitForPluginRegistryRetirement(supersededRegistry);
          }
        } else if (mode === "new failure") {
          await recordContextEngineQuarantine({
            ...quarantine,
            error: new Error("new failure"),
          });
        }
        release.resolve();
        expect(await loading).toBe(publicationThrows ? failure : undefined);
        await retirement;
        expect(await listPersisted()).toEqual(
          mode === "new failure"
            ? [getContextEngineQuarantine(engineId)]
            : mode === "superseded" || mode === "sync superseded" || publicationThrows
              ? [original]
              : [],
        );
      } finally {
        prepare.mockRestore();
        release.resolve();
        await loading;
        await retirement;
        observer.mockRestore();
        activationObserver.mockRestore();
        commit.mockRestore();
        await resetQuarantine();
        resetPluginLoaderTestStateForTest();
        restoreRegistry(previous);
      }
    });
  });
});
