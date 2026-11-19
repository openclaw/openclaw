import { AsyncLocalStorage } from "node:async_hooks";
import { spawn } from "node:child_process";
import { mkdirSync, readdirSync } from "node:fs";
import nodePath from "node:path";
import { afterEach, beforeEach, expect, it, vi, afterAll, describe } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createContextEngineLogicalTurnLease } from "../agents/harness/context-engine-logical-turn.js";
import { ensureCliPluginRegistryLoaded } from "../cli/plugin-registry-loader.js";
import type { OpenClawConfig } from "../config/types.js";
import { settleWithCleanup, throwCollectedErrors } from "../infra/error-graph-internal.js";
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
import { waitForPluginCacheRetirement } from "../plugins/plugin-cache.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import * as pluginRuntime from "../plugins/runtime.js";
import {
  captureActivePluginRegistrySnapshot as captureRegistry,
  restoreActivePluginRegistrySnapshot as restoreGlobalRegistry,
  setActivePluginRegistry,
  stageActivePluginRegistry,
} from "../plugins/runtime.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import { setPluginEnabledInConfig } from "../plugins/toggle-config.js";
import { AsyncWorkScope, getAsyncWorkSignal, trackAsyncWork } from "../shared/async-work-scope.js";
import { getProcessStartTime } from "../shared/pid-alive.js";
import { seedNativeVersionZeroState } from "../state/native-version-zero.test-support.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import { LegacyContextEngine } from "./legacy.js";
import { registerLegacyContextEngine } from "./legacy.registration.js";
import {
  clearPersistedContextEngineQuarantineForProcess as clearPersisted,
  listPersistedContextEngineQuarantines as listPersisted,
  recordPersistedContextEngineQuarantine as recordPersisted,
} from "./quarantine-health.js";
import {
  getContextEngineQuarantine,
  recordContextEngineQuarantine,
} from "./registry-quarantine.js";
import {
  createNativeSource,
  createRegistryFixture,
  resolveFixtureEngine,
} from "./registry-resources.test-support.js";
import {
  listContextEngineQuarantines,
  registerContextEngineInRegistry,
  resolveContextEngine,
  resolveContextEngineOwnerPluginId,
  resolveLogicalTurnContextEngines,
  listContextEngineQuarantines as listQuarantines,
  registerContextEngineForOwner,
} from "./registry.js";
import {
  resetContextEngineRuntimeQuarantineForTests,
  resetContextEngineRuntimeQuarantineForTests as resetQuarantine,
  gateContextEngineHealthCleanupForTest,
} from "./registry.test-support.js";
import type { ContextEngine } from "./types.js";

describe("selection", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  const engineId = "synthetic-engine";
  const ownerId = "synthetic-owner";
  const selectedConfig = { plugins: { slots: { contextEngine: engineId } } };
  const legacySelection = { id: "legacy", owner: undefined, failure: undefined };

  beforeEach(async () => {
    vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("context-engine-selection-"));
    await resetContextEngineRuntimeQuarantineForTests();
  });
  afterEach(async () => {
    await resetContextEngineRuntimeQuarantineForTests();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  function fixture(owner = engineId, registered = true, selectedId = engineId) {
    const registry = createEmptyPluginRegistry();
    const factory = vi.fn(() =>
      Object.assign(new LegacyContextEngine(), { info: { id: selectedId, name: "Synthetic" } }),
    );
    registerContextEngineInRegistry(registry, "legacy", () => new LegacyContextEngine(), "core");
    if (registered) {
      registerContextEngineInRegistry(registry, selectedId, factory, `plugin:${owner}`);
    }
    return { registry, factory };
  }

  async function resolve(path: "standalone" | "logical-turn", config: OpenClawConfig) {
    const turn =
      path === "logical-turn" ? await resolveLogicalTurnContextEngines(config) : undefined;
    const engine = turn?.configured.engine ?? (await resolveContextEngine(config));
    const result = {
      id: turn?.configuredId ?? engine.info.id,
      owner: turn ? turn.configured.ownerPluginId : resolveContextEngineOwnerPluginId(engine),
      failure: turn?.configuredFailure,
    };
    await engine.dispose?.();
    if (turn && turn.configured !== turn.fallback) {
      await turn.fallback.engine.dispose?.();
    }
    return result;
  }

  it.each(["custom", "rejected", "default", "disabled", "owner-disabled"] as const)(
    "settles workspace attribution before constructing only a selected custom engine (%s)",
    async (mode) => {
      const { registry, factory } = fixture(engineId, mode !== "owner-disabled");
      using warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const entered = createDeferred();
      const baseline = createDeferred();
      const beforeCustomEngine = vi.fn(async () => {
        entered.resolve();
        await baseline.promise;
      });
      const config: OpenClawConfig = {
        plugins: {
          enabled: mode !== "disabled",
          entries: mode === "owner-disabled" ? { [engineId]: { enabled: false } } : undefined,
          slots: { contextEngine: mode === "default" ? "legacy" : engineId },
        },
      };
      const pending = withPluginRuntimeRegistryScope(registry, () =>
        createContextEngineLogicalTurnLease({
          identity: { runId: `attribution-${mode}`, sessionId: "attribution-session" },
          config,
          awaitSessionDiffBaseline: beforeCustomEngine,
        }),
      );
      try {
        if (mode === "default" || mode === "disabled" || mode === "owner-disabled") {
          const lease = await awaitGateBeforeSettlement(
            pending,
            entered.promise,
            "Default context engine waited for workspace attribution",
          );
          lease.begin();
          expect(lease.effectiveEngineId).toBe("legacy");
          expect(lease.degraded).toBe(false);
          await lease.engine.assemble({ sessionId: "attribution-session", messages: [] });
          expect(beforeCustomEngine).not.toHaveBeenCalled();
          expect(factory).not.toHaveBeenCalled();
          expect(await listContextEngineQuarantines()).toEqual([]);
          expect(warn).not.toHaveBeenCalled();
        } else {
          await awaitGateBeforeSettlement(
            entered.promise,
            pending,
            "Custom factory bypassed attribution",
          );
          expect(factory).not.toHaveBeenCalled();
          if (mode === "rejected") {
            const failure = new Error("workspace attribution failed");
            baseline.reject(failure);
            await expect(pending).rejects.toBe(failure);
            expect(factory).not.toHaveBeenCalled();
            expect(await listContextEngineQuarantines()).toEqual([]);
          } else {
            baseline.resolve();
            expect((await pending).effectiveEngineId).toBe(engineId);
            expect(factory).toHaveBeenCalledOnce();
          }
        }
      } finally {
        baseline.resolve();
        await pending.then(
          (lease) => lease.dispose(),
          () => undefined,
        );
      }
    },
  );

  it.each([
    ["standalone", "missing"],
    ["standalone", "factory"],
    ["logical-turn", "missing"],
    ["logical-turn", "factory"],
  ] as const)("preserves enabled %s %s failure", async (path, failure) => {
    const { registry, factory } = fixture(engineId, failure !== "missing");
    factory.mockImplementation(() => {
      throw new Error("Async work scope is closed");
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    await withPluginRuntimeRegistryScope(registry, async () => {
      const result = await resolve(path, selectedConfig);
      if (path === "logical-turn") {
        expect(result.failure).toContain(
          failure === "missing" ? "not registered" : "Async work scope is closed",
        );
      } else {
        expect(result.id).toBe("legacy");
        expect(await listContextEngineQuarantines()).toEqual([
          expect.objectContaining({
            engineId,
            operation: failure === "missing" ? "resolve" : "factory",
          }),
        ]);
        if (failure === "factory") {
          expect((await resolve(path, selectedConfig)).id).toBe("legacy");
          expect(factory).toHaveBeenCalledOnce();
        }
      }
    });
  });

  it.each([
    ["standalone", ownerId],
    ["standalone", engineId],
    ["logical-turn", ownerId],
    ["logical-turn", engineId],
  ] as const)(
    "%s disables then re-enables owner %s without clearing its engine slot or registering again",
    async (path, owner) => {
      const { registry, factory } = fixture(owner);
      const disabled = setPluginEnabledInConfig(selectedConfig, owner, false);
      await withPluginRuntimeRegistryScope(registry, async () => {
        expect(await resolve(path, disabled)).toEqual(legacySelection);
        expect(factory).not.toHaveBeenCalled();
        expect(await resolve(path, setPluginEnabledInConfig(disabled, owner, true))).toEqual({
          id: engineId,
          owner,
          failure: undefined,
        });
        expect(await listContextEngineQuarantines()).toEqual([]);
      });
      expect(disabled.plugins?.slots?.contextEngine).toBe(engineId);
      expect(factory).toHaveBeenCalledOnce();
    },
  );

  const deniedPolicies = [
    {},
    { allow: [engineId] },
    { allow: [engineId], entries: { [ownerId]: { enabled: true } } },
  ];
  const ownerPolicies = [{ allow: [ownerId] }];
  const unrelatedPolicies = [{ allow: ["unrelated"] }];
  const disabledPolicies = [{ enabled: false }];
  it.each([
    ["standalone", engineId, "legacy", disabledPolicies, false],
    ["standalone", ownerId, "Synthetic-Engine", ownerPolicies, true],
    ["logical-turn", ownerId, "Synthetic-Engine", ownerPolicies, true],
    ["standalone", engineId, engineId, unrelatedPolicies, true],
    ["logical-turn", engineId, engineId, unrelatedPolicies, true],
    ["standalone", ownerId, engineId, deniedPolicies, false],
    ["logical-turn", ownerId, engineId, deniedPolicies, false],
  ] as const)(
    "%s applies owner %s policy to exact engine ID %s (%j)",
    async (path, owner, selectedId, policies, allowed) => {
      for (const policy of policies) {
        const { registry, factory } = fixture(owner, true, selectedId);
        using warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        using error = vi.spyOn(console, "error").mockImplementation(() => {});
        await withPluginRuntimeRegistryScope(registry, async () => {
          expect(
            await resolve(path, {
              plugins: { ...policy, slots: { contextEngine: selectedId } },
            }),
          ).toEqual(allowed ? { id: selectedId, owner, failure: undefined } : legacySelection);
          expect(await listContextEngineQuarantines()).toEqual([]);
        });
        expect(factory).toHaveBeenCalledTimes(allowed ? 1 : 0);
        expect(warn).not.toHaveBeenCalled();
        expect(error).not.toHaveBeenCalled();
      }
    },
  );
});

describe("foreground admission", () => {
  beforeEach(() => resetQuarantine());

  afterEach(async () => {
    await resetQuarantine();
    vi.restoreAllMocks();
  });

  it.each(["closed-scope", "released-source"] as const)(
    "propagates host admission failure without quarantining an uncalled factory (%s)",
    async (mode) => {
      const { registry, resources, retired: retire } = createRegistryFixture();
      const selectedId = `admission-${mode}`;
      const configuredFactory = vi.fn(() => new LegacyContextEngine());
      const fallbackFactory = vi.fn(() => new LegacyContextEngine());
      registerContextEngineInRegistry(registry, selectedId, configuredFactory, "plugin:fixture");
      registerContextEngineInRegistry(registry, "legacy", fallbackFactory, "core");
      const resolve = () => resolveFixtureEngine(registry, selectedId);
      const work = new AsyncWorkScope();
      const continuation = work.run(() => AsyncLocalStorage.snapshot());
      await work.drain();
      if (mode === "released-source") {
        await resources.release();
      }
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        await expect(mode === "closed-scope" ? continuation(resolve) : resolve()).rejects.toThrow(
          mode === "closed-scope"
            ? "Async work scope is closed"
            : "Plugin inspection resources have been released",
        );
        expect(configuredFactory).not.toHaveBeenCalled();
        expect(fallbackFactory).not.toHaveBeenCalled();
        expect(await listQuarantines()).toEqual([]);
        expect(log).not.toHaveBeenCalled();
        if (mode === "closed-scope") {
          // The same registration remains usable by a fresh caller, without reactivation.
          const engine = await resolve();
          expect(configuredFactory).toHaveBeenCalledOnce();
          expect(fallbackFactory).not.toHaveBeenCalled();
          await resources.release();
          expect(retire).not.toHaveBeenCalled();
          await engine.dispose?.();
        }
      } finally {
        await resources.release();
      }
      expect(retire).toHaveBeenCalledOnce();
    },
  );

  it.each(["reason", "wrapped-reason", "abort-error", "unrelated-error"] as const)(
    "distinguishes factory cancellation from plugin failure (%s)",
    async (mode) => {
      const { registry, resources, retired } = createRegistryFixture();
      const started = createDeferred();
      const fail = createDeferred();
      const cleanupGate = createDeferred();
      const owner = new AsyncWorkScope();
      const reason = new Error("host request cancelled");
      const failure =
        mode === "reason"
          ? reason
          : mode === "wrapped-reason"
            ? new Error("factory interrupted", { cause: reason })
            : mode === "abort-error"
              ? new DOMException("factory interrupted", "AbortError")
              : new Error("independent factory defect");
      const fallback = vi.fn(() => new LegacyContextEngine());
      registerContextEngineInRegistry(registry, "legacy", fallback, "core");
      registerContextEngineInRegistry(
        registry,
        "cancelled-factory",
        async () => {
          void trackAsyncWork(() => cleanupGate.promise);
          const signal = getAsyncWorkSignal();
          started.resolve();
          await fail.promise;
          expect(signal?.reason).toBe(reason);
          throw failure;
        },
        "plugin:fixture",
      );
      vi.spyOn(console, "error").mockImplementation(() => {});
      const result = owner
        .run(() => resolveFixtureEngine(registry, "cancelled-factory"))
        .then(
          (engine) => ({ engine }),
          (error: unknown) => ({ error }),
        );
      try {
        await started.promise;
        owner.beginClose(reason);
        fail.resolve();
        const outcome = await result;
        if (mode === "unrelated-error") {
          expect(fallback).toHaveBeenCalledOnce();
          expect(await listQuarantines()).toMatchObject([
            { engineId: "cancelled-factory", operation: "factory", reason: failure.message },
          ]);
        } else {
          expect(outcome).toEqual({ error: failure });
          expect(fallback).not.toHaveBeenCalled();
          expect(await listQuarantines()).toEqual([]);
        }
        if ("engine" in outcome) {
          await outcome.engine.dispose?.();
        }
        await resources.release();
        // A rejected factory may still own cooperative descendants; admission joins them.
        expect(owner.hasPendingWork).toBe(true);
        expect(retired).not.toHaveBeenCalled();
        cleanupGate.resolve();
        await owner.drain();
        expect(retired).toHaveBeenCalledOnce();
      } finally {
        fail.resolve();
        cleanupGate.resolve();
        await result;
        await owner.drain();
        await resources.release();
      }
    },
  );
  it.each(["success", "failure", "abort"] as const)(
    "retains the foreground source until initialization settles (%s)",
    async (mode) => {
      const source = createNativeSource();
      const factory = vi.fn(() => {
        expect(source.read()).toBe(42);
        return new LegacyContextEngine();
      });
      registerContextEngineInRegistry(
        source.registry,
        "initialized-source",
        factory,
        "plugin:fixture",
      );
      const started = createDeferred();
      const gate = createDeferred();
      const owner = new AsyncWorkScope();
      const failure = new Error("initialization rejected");
      const pending = owner.run(() =>
        resolveFixtureEngine(source.registry, "initialized-source", {
          initialize: async () => {
            await registerLegacyContextEngine();
            started.resolve();
            await gate.promise;
          },
        }),
      );
      void pending.catch(() => {});
      let engine: ContextEngine | undefined;
      try {
        await started.promise;
        await source.resources.release();
        expect(source.database.isOpen).toBe(true);
        expect(factory).not.toHaveBeenCalled();
        if (mode === "success") {
          gate.resolve();
          engine = await pending;
          expect(factory).toHaveBeenCalledOnce();
          await engine.dispose?.();
        } else {
          if (mode === "failure") {
            gate.reject(failure);
          } else {
            owner.beginClose(failure);
            gate.resolve();
          }
          await expect(pending).rejects.toBe(failure);
          expect(factory).not.toHaveBeenCalled();
          expect(await listQuarantines()).toEqual([]);
        }
        await owner.drain();
        expect(source.retired).toHaveBeenCalledOnce();
        expect(source.database.isOpen).toBe(false);
      } finally {
        gate.resolve();
        await pending.catch(() => {});
        await engine?.dispose?.();
        await owner.drain();
        await source.close();
      }
    },
  );
});

describe("quarantine health", () => {
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

  function seedRecord(overrides: Partial<ContextEngineQuarantineRecord>): void {
    const { failedAt, ...quarantine } = makeQuarantine();
    const record = { ...quarantine, ...createRuntimeHealthRecordEnvelope(failedAt), ...overrides };
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

  afterEach(() => resetPluginStateStoreForTests());
  afterAll(cleanupPluginLoaderFixturesForTest);

  it("warns when persisted quarantine inventory cannot be read", async () => {
    using read = vi
      .spyOn(pluginStateWorker, "listPluginStateInWorker")
      .mockRejectedValueOnce(new Error("synthetic health read failure: sensitive-row-fragment"));
    using warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await listPersisted()).toEqual([]);
    expect(read).toHaveBeenCalledOnce();
    expect(warning).toHaveBeenCalledExactlyOnceWith(
      "[runtime-health] Persisted quarantine inventory is unavailable for runtime-quarantines; health warnings may be incomplete. Run openclaw doctor to inspect state storage.",
    );
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
      seedRecord({ reason: "native registration" });
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
        expect(databasePath.startsWith(`${stateDir}${nodePath.sep}`)).toBe(true);
        mkdirSync(nodePath.dirname(databasePath), { recursive: true });
        const schemaSql = "SELECT type, name, sql FROM sqlite_schema ORDER BY type, name";
        const before = (() => {
          using database = new DatabaseSync(databasePath);
          seedNativeVersionZeroState(database, false);
          return database.prepare(schemaSql).all();
        })();
        await clearPersisted(undefined, process.pid);
        using readOnly = new DatabaseSync(databasePath, { readOnly: true });
        expect(readOnly.prepare("PRAGMA user_version").get()).toEqual({ user_version: 0 });
        expect(readOnly.prepare(schemaSql).all()).toEqual(before);
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
        const engineId = `health-registration-${superseded}`;
        const record = makeQuarantine({ engineId });
        await recordPersisted(record);
        const { reached, release, observer } = gateContextEngineHealthCleanupForTest();
        const registration = registerContextEngineForOwner(
          engineId,
          () => new LegacyContextEngine(),
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
              previous.runtimeSubagentMode,
              previous.workspaceDir ?? undefined,
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
          restoreGlobalRegistry(previous);
        }
      });
    },
  );

  it.runIf(process.platform === "linux").each(["engine", "process"])(
    "clears the selected %s records while preserving live sibling quarantines",
    async (scope) => {
      await withLiveSiblingProcess(async (siblingProcessId) => {
        const record = makeQuarantine();
        await recordPersisted(record);
        expect(await listContextEngineQuarantines()).toEqual([record]);
        if (scope === "process") {
          seedRecord({
            engineId: "local-b",
            operation: "assemble",
            reason: "current process failure b",
          });
        }
        seedRecord({
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
        expect(await listContextEngineQuarantines()).toEqual([
          makeQuarantine({
            reason: "sibling process failure",
            failedAt: new Date(789),
          }),
        ]);
      });
    },
  );

  it("drops records from an unverified sibling", async () => {
    await withLiveSiblingProcess(async (siblingProcessId) => {
      await resetQuarantine();
      seedRecord({
        processToken: "stale-incarnation-token",
        processId: siblingProcessId,
        processStartTime: null,
      });
      expect(await listContextEngineQuarantines()).toEqual([]);
    });
  });

  it.runIf(process.platform === "linux")("drops records from a reused sibling PID", async () => {
    await withLiveSiblingProcess(async (processId) => {
      await resetQuarantine();
      seedRecord({
        processId,
        processStartTime: (getProcessStartTime(processId) ?? 0) + 1,
      });
      expect(await listContextEngineQuarantines()).toEqual([]);
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
      if (mode === "cached" || mode === "cached publication throws") {
        await ensureCliPluginRegistryLoaded({ scope: "all", config });
      }
      const quarantine = {
        engineId,
        operation: "resolve",
        error: new Error("previous failure"),
        defaultEngineId: "legacy",
      };
      await recordContextEngineQuarantine(quarantine);
      const original = getContextEngineQuarantine(engineId);
      const { reached, release, observer } = gateContextEngineHealthCleanupForTest();
      const failure = new Error("publication rejected");
      const commit = vi.spyOn(pluginRuntime, "commitStagedPluginRegistry");
      if (publicationThrows) {
        commit.mockImplementationOnce(() => {
          throw failure;
        });
      }
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
      let retirement: Promise<unknown> | undefined;
      await settleWithCleanup(
        (async () => {
          expect(
            await Promise.race([
              reached.promise.then(() => "worker"),
              loading.then(() => "settled"),
            ]),
          ).toBe("worker");
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
        })(),
        async () => {
          release.resolve();
          await [
            () => loading.then(() => retirement),
            () => commit.mockRestore(),
            () => resetQuarantine(),
            () => resetPluginLoaderTestStateForTest(),
            async () => {
              const { failures } = await waitForPluginCacheRetirement(true);
              const errors = failures.map(({ error }) => error);
              throwCollectedErrors(errors, "Plugin cleanup failed");
            },
            () => observer.mockRestore(),
            () => restoreGlobalRegistry(previous),
          ].reduceRight<() => Promise<void>>(
            (next, run) => async () => {
              await settleWithCleanup(Promise.resolve().then(run), next, "Cleanup failed");
            },
            async () => {},
          )();
        },
        "Activation health proof and cleanup failed",
      );
    });
  });
});
