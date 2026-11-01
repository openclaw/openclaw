import { setImmediate as nextEventLoopTurn } from "node:timers/promises";
import { afterEach, expect, it, vi, describe } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createContextEngineLogicalTurnLease as createLease } from "../agents/harness/context-engine-logical-turn.js";
import { createAgentCleanupScope } from "../agents/run-cleanup-timeout.js";
import { projectPluginContributions } from "../plugins/registry-contributions.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { PluginRegistryInspectionResources } from "../plugins/registry-inspection-resources.js";
import { retireInspectionInstances } from "../plugins/registry-inspection.test-support.js";
import { withPluginRuntimeRegistryScope as withRegistry } from "../plugins/runtime/gateway-request-scope.js";
import { bindPluginRuntimeLoadContextState } from "../plugins/runtime/load-context-state.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import { AsyncWorkScope, getAsyncWorkSignal, trackAsyncWork } from "../shared/async-work-scope.js";
import * as initialization from "./init.js";
import { LegacyContextEngine } from "./legacy.js";
import * as health from "./quarantine-health.js";
import { createNativeSource, resolveFixtureEngine } from "./registry-resources.test-support.js";
import * as contextEngineRegistry from "./registry.js";
import {
  adoptRuntimeContextEngineRegistrations,
  registerContextEngineInRegistry as registerEngine,
  resolveLogicalTurnContextEngines,
  type ContextEngineFactory,
} from "./registry.js";
import { resetContextEngineRuntimeQuarantineForTests as resetQuarantine } from "./registry.test-support.js";
import type { ContextEngine } from "./types.js";

describe("logical-turn native resources", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it.each([
    "factory-tail",
    "abort-factory-tail",
    "dispose",
    "dispose-tail",
    "abort-tail",
    "parent-abort",
    "invalid-tail",
    "invalid-factory-tail",
    "closing-factory",
    "last-user",
    "raw-view",
    "initialization",
    "initialization-error",
    "initialization-abort",
    "shared",
  ] as const)("retains the adopted engine's native source through %s", async (mode) => {
    const donor = createEmptyPluginRegistry();
    const supplyingView = createEmptyPluginRegistry();
    const viewSource = new PluginRegistryInspectionResources(retireInspectionInstances);
    const plugin = { id: "engine-source-fixture", source: "/synthetic/plugin.cjs" };
    donor.plugins.push(createPluginRecord(plugin));
    supplyingView.plugins.push(createPluginRecord(plugin));
    if (mode !== "raw-view") {
      viewSource.attach(supplyingView);
    }
    const native = createNativeSource(":memory:", donor, plugin.id, () => {
      if (mode === "closing-factory") {
        throw new Error("registration disposer failed");
      }
    });
    const { database, resources: source } = native;
    const reads: number[] = [];
    const read = () => {
      try {
        reads.push(native.read());
      } catch {
        reads.push(-1);
      }
    };
    const factoryStarted = createDeferred();
    const factoryGate = createDeferred();
    const factoryTail = createDeferred();
    const disposeStarted = createDeferred();
    const disposeGate = createDeferred();
    const disposeTail = createDeferred();
    const tails: Promise<unknown>[] = [];
    const readAfter = (gate: { promise: PromiseLike<unknown> }, readValue = read) =>
      trackAsyncWork(async () => {
        await gate.promise;
        readValue();
      });
    const contexts: Array<string | undefined> = [];
    const signals: AbortSignal[] = [];
    let engineDisposals = 0;
    let cleanupSignal: AbortSignal | undefined;
    let factoryWorker: Promise<void> | undefined;
    let factoryWorkFinished = false;
    let abortInOrigin = false;
    let sharedEngine: ContextEngine | undefined;
    class NativeEngine extends LegacyContextEngine {
      #read = read;
      override readonly info = {
        id: mode === "invalid-tail" || mode === "invalid-factory-tail" ? "" : "native-engine",
        name: "Native engine",
      };
      override async assemble(params: Parameters<ContextEngine["assemble"]>[0]) {
        this.#read();
        return await super.assemble(params);
      }
      async dispose() {
        engineDisposals++;
        disposeStarted.resolve();
        // A factory's accepted background work may require disposal to let it finish.
        if (mode !== "abort-factory-tail" && mode !== "invalid-factory-tail") {
          factoryTail.resolve();
        }
        if (mode === "invalid-factory-tail") {
          cleanupSignal = getAsyncWorkSignal();
          await factoryWorker;
        }
        if (mode === "dispose" || mode === "invalid-factory-tail") {
          await disposeGate.promise;
        }
        if (mode === "dispose-tail" || mode === "invalid-tail" || mode === "shared") {
          cleanupSignal = getAsyncWorkSignal();
          tails.push(readAfter(disposeTail, () => this.#read()));
        }
        this.#read();
      }
    }
    const factory: ContextEngineFactory = async (context) => {
      contexts.push(context.agentDir);
      const signal = getAsyncWorkSignal();
      if (signal) {
        signals.push(signal);
        if (mode === "abort-tail" || mode === "parent-abort") {
          signal.addEventListener(
            "abort",
            () => {
              abortInOrigin = getAsyncWorkSignal() === signal;
              tails.push(readAfter(disposeTail));
            },
            { once: true },
          );
        }
      }
      factoryStarted.resolve();
      if (mode === "closing-factory") {
        await factoryGate.promise;
      }
      if (mode === "factory-tail" || mode === "closing-factory") {
        const tail = readAfter(factoryTail);
        void tail.catch(() => {});
        tails.push(tail);
      }
      if (mode === "abort-factory-tail" || mode === "invalid-factory-tail") {
        if (!signal) {
          throw new Error("Managed factory did not receive its work signal");
        }
        const stopped = createDeferred();
        signal.addEventListener("abort", () => stopped.resolve(), { once: true });
        factoryWorker = trackAsyncWork(async () => {
          await Promise.race([stopped.promise, factoryTail.promise]);
          read();
          factoryWorkFinished = true;
        });
        tails.push(factoryWorker);
      }
      read();
      if (mode === "closing-factory") {
        throw new Error("original factory failure");
      }
      return mode === "shared" ? (sharedEngine ??= new NativeEngine()) : new NativeEngine();
    };
    source.runRegistration(plugin.id, () => {
      registerEngine(donor, "selected", factory, `plugin:${plugin.id}`);
      if (mode === "shared") {
        registerEngine(donor, "legacy", factory, "core");
      }
    });
    const copiedView = adoptRuntimeContextEngineRegistrations(supplyingView, donor);
    if (mode === "shared") {
      copiedView.contextEngines.set("legacy", donor.contextEngines.get("legacy")!);
    }
    if (mode !== "raw-view") {
      viewSource.attach(copiedView);
    }
    const config = {
      plugins: {
        entries: { [plugin.id]: { enabled: true } },
        slots: { contextEngine: "selected" },
      },
    };
    const cleanupScope = createAgentCleanupScope();
    const parent = new AsyncWorkScope();
    const foreign = new AsyncWorkScope();
    type Lease = Pick<
      Awaited<ReturnType<typeof createLease>>,
      "engine" | "dispose" | "degradedReason"
    >;
    const leases: Lease[] = [];
    const pending: Array<Promise<unknown>> = [];
    const initializationStarted = createDeferred();
    const initializationGate = createDeferred();
    const initialize = initialization.ensureContextEnginesInitialized;
    const initializeSpy =
      mode === "initialization" ||
      mode === "initialization-error" ||
      mode === "initialization-abort"
        ? vi
            .spyOn(initialization, "ensureContextEnginesInitialized")
            .mockImplementation(async () => {
              await initialize();
              initializationStarted.resolve();
              await initializationGate.promise;
            })
        : undefined;
    const start = async () => {
      const create = () =>
        cleanupScope.run(() =>
          withRegistry(copiedView, async (): Promise<Lease> => {
            const options = {
              agentDir: "/synthetic/staged-agent",
              workspaceDir: "/synthetic/workspace",
            };
            // Keep the acquired alias pair even though lease initialization refreshes legacy.
            if (mode === "shared") {
              const pair = await resolveLogicalTurnContextEngines(config, options);
              using resolution = vi
                .spyOn(contextEngineRegistry, "resolveLogicalTurnContextEngines")
                .mockResolvedValueOnce(pair);
              const lease = await createLease({
                identity: { runId: "alias", sessionId: "alias" },
                config,
              });
              expect(resolution).toHaveBeenCalledOnce();
              return lease;
            }
            return createLease({
              identity: { runId: "fixture-run", sessionId: "fixture-session" },
              config,
              ...options,
            });
          }),
        );
      const lease = await (mode === "abort-factory-tail" || mode === "invalid-factory-tail"
        ? create()
        : mode === "closing-factory"
          ? parent.run(create)
          : parent.track(create));
      leases.push(lease);
      return lease;
    };
    const first = start();
    pending.push(first);
    try {
      if (initializeSpy) {
        await source.release();
        await initializationStarted.promise;
        expect(database.isOpen).toBe(true);
        expect(contexts).toEqual([]);
        if (mode === "initialization-error" || mode === "initialization-abort") {
          const failure = new Error("initialization failed");
          if (mode === "initialization-error") {
            initializationGate.reject(failure);
          } else {
            parent.beginClose(failure);
            initializationGate.resolve();
          }
          await expect(first).rejects.toBe(failure);
          await parent.drain();
          expect(native.state).toMatchObject({ disposals: 1, open: false });
          expect(engineDisposals).toBe(0);
          return;
        }
        const replacement = vi.fn(() => new LegacyContextEngine());
        registerEngine(copiedView, "selected", replacement, `plugin:${plugin.id}`, {
          allowSameOwnerRefresh: true,
        });
        initializationGate.resolve();
        await first;
        expect(replacement).not.toHaveBeenCalled();
      }
      await factoryStarted.promise;
      expect(signals.every((signal) => !signal.aborted)).toBe(true);
      if (mode === "invalid-factory-tail") {
        await disposeStarted.promise;
      }
      if (mode === "last-user") {
        await first;
        await start();
      }
      await source.release();
      expect.soft(native.state).toMatchObject({ open: true, disposals: 0 });
      if (mode === "closing-factory") {
        let parentDrained = false;
        pending.push(
          parent.drain().then(() => {
            parentDrained = true;
          }),
        );
        await Promise.resolve();
        expect.soft(parentDrained).toBe(false);
      }
      if (mode === "invalid-factory-tail") {
        await nextEventLoopTurn();
        expect.soft(signals.every((signal) => signal.aborted)).toBe(true);
        expect.soft([factoryWorkFinished, cleanupSignal?.aborted]).toEqual([true, false]);
        factoryTail.resolve();
        disposeGate.resolve();
      }
      factoryGate.resolve();
      const lease = await first;
      expect(contexts.every((value) => value === "/synthetic/staged-agent")).toBe(true);
      if (mode === "closing-factory") {
        expect(lease.degradedReason).toBe("original factory failure");
        factoryTail.resolve();
      } else if (mode === "invalid-tail" || mode === "invalid-factory-tail") {
        expect(lease.degradedReason).toContain("missing info.id");
      } else {
        await lease.engine.assemble({ sessionId: "fixture-session", messages: [] });
      }
      if (mode === "parent-abort") {
        const reason = new Error("original parent abort");
        foreign.run(() => parent.beginClose(reason));
        expect(signals.every((signal) => signal.reason === reason)).toBe(true);
        let foreignDrained = false;
        pending.push(
          foreign.drain().then(() => {
            foreignDrained = true;
          }),
        );
        await nextEventLoopTurn();
        expect.soft(foreignDrained).toBe(true);
      }
      vi.useFakeTimers();
      vi.stubEnv("OPENCLAW_AGENT_CLEANUP_TIMEOUT_MS", "25");
      const cleanup = cleanupScope.run(() => lease.dispose());
      pending.push(cleanup);
      await vi.advanceTimersByTimeAsync(25);
      await cleanup;
      if (
        mode === "dispose" ||
        mode === "dispose-tail" ||
        mode === "abort-tail" ||
        mode === "parent-abort" ||
        mode === "shared"
      ) {
        expect.soft(cleanupScope.outcome).toBe("uncertain");
        expect.soft(database.isOpen).toBe(true);
      }
      if (mode === "shared") {
        expect.soft([engineDisposals, native.state.disposals]).toEqual([1, 0]);
      }
      if (mode === "abort-tail" || mode === "parent-abort") {
        expect.soft(abortInOrigin).toBe(true);
      }
      if (mode === "last-user") {
        expect.soft(native.state.disposals).toBe(0);
        await leases[1]!.dispose();
      }
      if (mode === "dispose-tail" || mode === "invalid-tail") {
        expect.soft(cleanupSignal?.aborted).toBe(false);
      }
      if (mode === "abort-factory-tail") {
        expect.soft(cleanupScope.outcome).toBe("closed");
        factoryTail.resolve();
      }
      disposeGate.resolve();
      disposeTail.resolve();
      const settledTails = await Promise.allSettled(tails);
      expect.soft(settledTails.every((tail) => tail.status === "fulfilled")).toBe(true);
      await parent.drain();
      await native.disposed.promise;
      expect(native.state).toMatchObject({ disposals: 1, open: false });
      if (mode === "closing-factory") {
        expect.soft(cleanupScope.outcome).toBe("uncertain");
      }
      expect.soft(new Set(reads)).toEqual(new Set([42]));
      expect(engineDisposals).toBe(mode === "closing-factory" ? 0 : mode === "last-user" ? 2 : 1);
      await lease.dispose();
    } finally {
      vi.useRealTimers();
      initializationGate.resolve();
      factoryGate.resolve();
      factoryTail.resolve();
      disposeGate.resolve();
      disposeTail.resolve();
      await Promise.allSettled(pending);
      await Promise.allSettled(leases.map((lease) => lease.dispose()));
      await Promise.allSettled(tails);
      await parent.drain();
      await foreign.drain();
      await native.close();
      await viewSource.release();
      initializeSpy?.mockRestore();
    }
  });
});

describe("lazy fallback native resources", () => {
  it.each(["rejected-factory", "primary-failure", "shared"] as const)(
    "releases foreground factory resources after lazy fallback (%s)",
    async (mode) => {
      const { registry, resources, database, read, state, close } = createNativeSource();
      const fallbackStarted = createDeferred();
      const fallbackGate = createDeferred();
      const cleanupGate = createDeferred();
      const factoryFailure = new Error("fallback factory failed");
      let rawCleanup: Promise<void> | undefined;
      const cleanupReads: number[] = [];
      const primaryFailure = new Error("configured cleanup failed");
      let primaryDisposals = 0;
      let fallbackDisposals = 0;
      let fallbackFactories = 0;
      let fallbackClosedAfterDisposalStarted: boolean | undefined;
      let primaryCalls = 0;
      class SelectedEngine extends LegacyContextEngine {
        override async assemble(params: Parameters<ContextEngine["assemble"]>[0]) {
          if (++primaryCalls === 1 || mode !== "shared") {
            throw new Error("configured store unavailable");
          }
          return await super.assemble(params);
        }
        async dispose() {
          primaryDisposals++;
          expect(read()).toBe(42);
          if (mode === "primary-failure") {
            throw primaryFailure;
          }
        }
      }
      class FallbackEngine extends LegacyContextEngine {
        async dispose() {
          fallbackDisposals++;
          expect(read()).toBe(42);
        }
      }
      const primary = new SelectedEngine();
      registerEngine(
        registry,
        "legacy",
        async () => {
          fallbackFactories++;
          getAsyncWorkSignal()?.addEventListener(
            "abort",
            () => {
              fallbackClosedAfterDisposalStarted =
                (mode === "shared" ? primaryDisposals : fallbackDisposals) > 0;
            },
            { once: true },
          );
          fallbackStarted.resolve();
          if (mode === "rejected-factory") {
            rawCleanup = trackAsyncWork(async () => {
              await cleanupGate.promise;
              cleanupReads.push(read());
            });
            await fallbackGate.promise;
            throw factoryFailure;
          }
          return mode === "shared" ? primary : new FallbackEngine();
        },
        "core",
      );
      const selectedId = `fallback-resources-${mode}`;
      registerEngine(registry, selectedId, () => primary, "plugin:fixture");
      const warn = vi.spyOn(console, "error").mockImplementation(() => {});
      const params = { sessionId: "fallback-session", messages: [] };
      let engine: ContextEngine | undefined;
      let operation: Promise<unknown> | undefined;
      let cleanup: Promise<void> | undefined;
      try {
        engine = await resolveFixtureEngine(registry, selectedId);
        operation = withRegistry(registry, () => engine!.assemble(params));
        if (mode === "rejected-factory") {
          operation = expect(operation).rejects.toThrow("configured store unavailable");
        }
        await fallbackStarted.promise;
        if (mode !== "rejected-factory") {
          await operation;
        }
        await resources.release();
        let settled = false;
        cleanup = Promise.resolve(engine.dispose?.()).finally(() => {
          settled = true;
        });
        const outcome = cleanup.then(
          () => undefined,
          (error: unknown) => error,
        );
        if (mode === "rejected-factory") {
          await nextEventLoopTurn();
          expect.soft({ settled, open: database.isOpen }).toEqual({ settled: false, open: true });
          fallbackGate.resolve();
          await operation;
          await nextEventLoopTurn();
          expect.soft({ settled, open: database.isOpen }).toEqual({ settled: false, open: true });
          cleanupGate.resolve();
          await rawCleanup;
        }
        expect(await outcome).toBe(
          mode === "primary-failure"
            ? primaryFailure
            : mode === "rejected-factory"
              ? factoryFailure
              : undefined,
        );
        expect.soft(primaryDisposals).toBe(1);
        expect
          .soft(fallbackDisposals)
          .toBe(mode === "shared" || mode === "rejected-factory" ? 0 : 1);
        if (mode === "rejected-factory") {
          expect(cleanupReads).toEqual([42]);
        }
        if (mode !== "rejected-factory") {
          expect.soft(fallbackClosedAfterDisposalStarted).toBe(true);
        }
        expect.soft(state).toMatchObject({ disposals: 1, open: false });
        await Promise.resolve(engine.dispose?.()).catch(() => {});
        expect.soft(primaryDisposals).toBe(1);
        // A saved ordinary method cannot reopen the lazy factory after its owner closes.
        await expect(withRegistry(registry, () => engine!.assemble(params))).rejects.toThrow();
        expect(fallbackFactories).toBe(1);
      } finally {
        fallbackGate.resolve();
        cleanupGate.resolve();
        await rawCleanup;
        await operation?.catch(() => {});
        await cleanup?.catch(() => {});
        await close();
        warn.mockRestore();
      }
    },
  );

  it.each(["missing", "factory", "guarded"] as const)(
    "retains a distinct fallback source while recording quarantine (%s)",
    async (mode) => {
      const {
        registry: donor,
        resources,
        read,
        state,
        close,
      } = createNativeSource(":memory:", undefined, "fallback");
      const registry = createEmptyPluginRegistry();
      const fallback = vi.fn(() => {
        expect(read()).toBe(42);
        return new LegacyContextEngine();
      });
      registerEngine(donor, "legacy", fallback, "core");
      // A copied registration still belongs to the donor, not this unowned view.
      registry.contextEngines.set("legacy", donor.contextEngines.get("legacy")!);
      const id = `quarantine-source-${mode}`;
      const failure = new Error("configured engine failed");
      if (mode !== "missing") {
        registerEngine(
          registry,
          id,
          () => {
            if (mode === "factory") {
              throw failure;
            }
            return Object.assign(new LegacyContextEngine(), {
              assemble: async () => {
                throw failure;
              },
            });
          },
          "plugin:fixture",
        );
      }
      const started = createDeferred();
      const gate = createDeferred();
      const record = health.recordPersistedContextEngineQuarantine;
      const recording = vi
        .spyOn(health, "recordPersistedContextEngineQuarantine")
        .mockImplementation(async (...args) => {
          started.resolve();
          await gate.promise;
          await record(...args);
        });
      const warn = vi.spyOn(console, "error").mockImplementation(() => {});
      let engine: ContextEngine | undefined;
      let operation: Promise<unknown> | undefined;
      try {
        const resolve = () => resolveFixtureEngine(registry, id);
        if (mode === "guarded") {
          engine = await resolve();
          operation = withRegistry(registry, () =>
            engine!.assemble({ sessionId: "recording-source", messages: [] }),
          );
        } else {
          operation = resolve().then((resolved) => {
            engine = resolved;
          });
        }
        void operation.catch(() => {});
        await started.promise;
        await resources.release();
        expect(state).toMatchObject({ open: true, disposals: 0 });
        expect(fallback).not.toHaveBeenCalled();
        const replacement = vi.fn(() => new LegacyContextEngine());
        registerEngine(registry, "legacy", replacement, "core", {
          allowSameOwnerRefresh: true,
        });
        gate.resolve();
        await operation;
        expect(fallback).toHaveBeenCalledOnce();
        expect(replacement).not.toHaveBeenCalled();
        await engine?.dispose?.();
        expect(state).toMatchObject({ disposals: 1, open: false });
      } finally {
        gate.resolve();
        await operation?.catch(() => {});
        await engine?.dispose?.();
        await close();
        recording.mockRestore();
        warn.mockRestore();
        await resetQuarantine();
      }
    },
  );
});

describe("registry adoption", () => {
  it("does not treat an uncovered view as a retired donor's owner after a failed dependency", async () => {
    const donor = createEmptyPluginRegistry();
    const target = createEmptyPluginRegistry();
    const donorSource = new PluginRegistryInspectionResources(retireInspectionInstances);
    const primarySource = new PluginRegistryInspectionResources(retireInspectionInstances);
    donorSource.attach(donor);
    primarySource.attach(target);
    const record = { id: "uncovered-engine", source: "/synthetic/uncovered-engine.cjs" };
    donor.plugins.push(createPluginRecord(record));
    target.plugins.push(createPluginRecord(record));
    let calls = 0;
    let primaryDisposals = 0;
    primarySource.register(record.id, {
      id: "primary",
      dispose() {
        primaryDisposals++;
      },
    });
    registerEngine(
      donor,
      record.id,
      () => {
        calls++;
        return new LegacyContextEngine();
      },
      `plugin:${record.id}`,
    );
    const copied = adoptRuntimeContextEngineRegistrations(target, donor);
    primarySource.attach(copied);
    await donorSource.release();
    expect(() => primarySource.retainDependency(donorSource)).toThrow(/released/);
    let lease: Awaited<ReturnType<typeof createLease>> | undefined;
    try {
      lease = await withRegistry(copied, () =>
        createLease({
          identity: { runId: "uncovered-run", sessionId: "uncovered-session" },
          config: { plugins: { slots: { contextEngine: record.id } } },
        }),
      );
      expect(lease.degraded).toBe(true);
      expect(calls).toBe(0);
      await primarySource.release();
      await lease.dispose();
      expect(primaryDisposals).toBe(1);
    } finally {
      await lease?.dispose();
      await primarySource.release();
    }
  });

  const unusedFactory: ContextEngineFactory = async () => {
    throw new Error("context engine factory should not run");
  };

  function registryWithPluginEngine(
    params: {
      lifecycle?: "runtime" | "readOnlyDiscovery" | null;
      source?: string;
      status?: "loaded" | "disabled" | "error";
      factory?: ContextEngineFactory;
    } = {},
  ) {
    const registry = createEmptyPluginRegistry();
    registry.plugins.push(
      createPluginRecord({
        id: "ce-probe",
        source: params.source ?? "/tmp/ce-probe",
        status: params.status ?? "loaded",
      }),
    );
    if (params.lifecycle !== null) {
      registry.contextEngines.set("ce-probe", {
        factory: params.factory ?? unusedFactory,
        owner: "plugin:ce-probe",
        lifecycle: params.lifecycle ?? "runtime",
      });
    }
    return registry;
  }

  it.each([
    ["readOnlyDiscovery", "/tmp/ce-probe", "loaded", false],
    ["runtime", "/tmp/ce-probe", "loaded", false],
    [null, "/tmp/shadow-ce-probe", "loaded", false],
    [null, "/tmp/ce-probe", "disabled", true],
  ] as const)(
    "adopts only matching discovery entries (%s, %s, %s)",
    (lifecycle, source, status, core) => {
      const scopedFactory = vi.fn(unusedFactory);
      const rootFactory = vi.fn(unusedFactory);
      const scoped = registryWithPluginEngine({
        lifecycle,
        source,
        status,
        factory: scopedFactory,
      });
      const root = registryWithPluginEngine({ factory: rootFactory });
      if (core) {
        root.contextEngines.set("legacy", {
          factory: unusedFactory,
          owner: "core",
          lifecycle: "runtime",
        });
      }
      const adopted = adoptRuntimeContextEngineRegistrations(scoped, root);
      const original = lifecycle === null ? undefined : scopedFactory;
      const expected = lifecycle === "readOnlyDiscovery" ? rootFactory : original;
      expect(scoped.contextEngines.get("ce-probe")?.factory).toBe(original);
      expect(adopted.contextEngines.get("ce-probe")?.factory).toBe(expected);
      if (lifecycle !== null) {
        expect(adopted.contextEngines.get("ce-probe")?.lifecycle).toBe("runtime");
      }
      if (lifecycle !== "readOnlyDiscovery") {
        expect(adopted).toBe(scoped);
      }
    },
  );

  // A retained or full-only factory cannot bypass the target generation's selected owner.
  it.each(["adopt", "retain"] as const)("enforces prepared ownership during %s", (operation) => {
    const root = registryWithPluginEngine();
    for (const owner of ["plugin:new-owner", "plugin:ce-probe", null]) {
      const target = createEmptyPluginRegistry();
      target.plugins.push(...root.plugins);
      bindPluginRuntimeLoadContextState(target, {
        workspaceDir: undefined,
        rawConfig: {},
        activationInputFingerprint: "synthetic",
        controlPlaneFingerprint: "synthetic",
        registrationConfigKey: "synthetic",
        declaredProviderOwners: new Map(),
        selectedContextEngine: { engineId: "ce-probe", owner },
      });
      let result = target;
      if (operation === "adopt") {
        result = adoptRuntimeContextEngineRegistrations(target, root);
      } else {
        projectPluginContributions(root, root.plugins[0]!, target);
      }
      expect(result.contextEngines.has("ce-probe")).toBe(owner === "plugin:ce-probe");
      expect(root.contextEngines.has("ce-probe")).toBe(true);
    }
  });
});
