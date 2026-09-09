import { readFile } from "node:fs/promises";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AsyncWorkScope,
  captureAsyncWorkTracker,
  getAsyncWorkSignal,
  trackAsyncWork,
} from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import { acquirePluginRegistryForInspection, loadPluginRegistryHandle } from "./loader.js";
import {
  resetPluginLoaderTestStateForTest,
  useNoBundledPlugins,
  writePlugin,
} from "./loader.test-fixtures.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import { getPluginRegistryInspectionResources } from "./registry-inspection-resources.js";
import {
  capturePluginLifecycleAuthority,
  capturePluginRegistryLifecycleEpoch,
  capturePluginRegistryLifecycleSignal,
  pluginLoaderCacheState,
} from "./registry-lifecycle.js";
import {
  getActivePluginRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "./runtime.js";

afterEach(() => resetPluginRuntimeStateForTest());
afterEach(resetPluginLoaderTestStateForTest);

type InspectionConnection = { database: DatabaseSync; disposals: number; cleanups: number };
let inspectionFixtureId = 0;

function createInspectionFixture(options?: {
  registration?: "throw" | "async-resolve" | "async-reject" | "thenable" | "tracked";
  pauseDisposal?: boolean;
  disposalFailure?: boolean;
  contextEngine?: boolean;
  capturedDisposal?: "async-context" | "work-tracker" | "sibling-tracker";
  queuedAbortCleanup?: boolean;
}) {
  useNoBundledPlugins();
  const id = `owned-inspection-${inspectionFixtureId++}`;
  const key = `__openclaw_${id}`;
  const connections: InspectionConnection[] = [];
  const resume = createDeferredCore();
  const finishDisposal = createDeferredCore();
  const disposalStarted = createDeferredCore();
  const disposed = createDeferredCore();
  const sibling: {
    read?: () => unknown;
    result?: unknown;
    track?: (run: () => Promise<void>) => Promise<void>;
  } = {};
  const captured: {
    registrationSignal?: AbortSignal;
    disposalSignal?: AbortSignal;
    read?: unknown;
    abortCleanup?: Promise<void>;
    abortRead?: unknown;
    tracker?: ReturnType<typeof captureAsyncWorkTracker>;
  } = {};
  const state = {
    connections,
    resume,
    finishDisposal,
    disposalStarted,
    disposed,
    sibling,
    captured,
    captureAsyncWorkTracker,
    getAsyncWorkSignal,
    trackAsyncWork,
    lateRead: 0,
    factoryCalls: 0,
    thenCalls: 0,
  };
  Object.defineProperty(globalThis, key, { value: state, configurable: true });
  const plugin = writePlugin({
    id,
    body: `const { DatabaseSync } = require("node:sqlite");
module.exports = {
  id: ${JSON.stringify(id)},
  register(api) {
    const state = globalThis[${JSON.stringify(key)}];
    const database = new DatabaseSync(":memory:");
    const connection = { database, disposals: 0, cleanups: 0 };
    state.connections.push(connection);
    const captureMode = ${JSON.stringify(options?.capturedDisposal)};
    class NativeLifecycle {
      id = " native-resource ";
      #database = database;
      async dispose() {
        connection.disposals++;
        if (captureMode) state.captured.disposalSignal = state.getAsyncWorkSignal();
        state.disposalStarted.resolve();
        if (${options?.pauseDisposal === true}) await state.finishDisposal.promise;
        if (captureMode === "sibling-tracker") state.sibling.result = state.sibling.read();
        if (captureMode) state.captured.read = this.#database.prepare("SELECT 42 AS value").get();
        this.#database.close();
        state.disposed.resolve();
        if (${options?.disposalFailure === true}) throw new Error("fixture disposal failed");
      }
      cleanup = () => {
        connection.cleanups++;
        if (database.isOpen) database.close();
      };
    }
    const lifecycle = new NativeLifecycle();
    if (${options?.queuedAbortCleanup === true}) {
      const track = state.captureAsyncWorkTracker();
      state.getAsyncWorkSignal().addEventListener("abort", () => queueMicrotask(() => {
        state.captured.abortCleanup = track(async () => {
          await require("node:fs/promises").readFile(__filename);
          state.captured.abortRead = database.prepare("SELECT 42 AS value").get();
          state.sibling.result = state.sibling.read?.();
        });
        void state.captured.abortCleanup.catch(() => {});
      }), { once: true });
    }
    if (captureMode) {
      state.captured.registrationSignal = state.getAsyncWorkSignal();
      const dispose = lifecycle.dispose.bind(lifecycle);
      const track = state.captured.tracker = state.captureAsyncWorkTracker();
      lifecycle.dispose = captureMode === "async-context"
        ? require("node:async_hooks").AsyncLocalStorage.bind(() => state.trackAsyncWork(dispose))
        : captureMode === "sibling-tracker" ? () => state.sibling.track(dispose) : () => track(dispose);
    }
    api.registerRuntimeLifecycle(lifecycle);
    if (${options?.contextEngine === true}) {
      api.registerContextEngine(${JSON.stringify(id)}, () => {
        state.factoryCalls++;
        throw new Error("Discovery must not invoke the context engine factory");
      });
    }
    const mode = ${JSON.stringify(options?.registration)};
    if (mode === "throw") throw new Error("fixture registration failed");
    const finishRegistration = async () => {
      await state.resume.promise;
      state.lateRead = database.prepare("SELECT 42 AS value").get().value;
      state.sibling.result = state.sibling.read?.();
      if (mode === "async-reject") throw new Error("late registration failure");
    };
    if (mode === "thenable") return { then(resolve, reject) {
      state.thenCalls++;
      finishRegistration().then(resolve, reject);
    } };
    if (mode === "tracked") {
      void state.trackAsyncWork(finishRegistration);
    } else if (mode?.startsWith("async")) return finishRegistration();
  },
};`,
  });
  const config = {
    plugins: {
      allow: [id],
      load: { paths: [plugin.file] },
      slots: { memory: "none", ...(options?.contextEngine ? { contextEngine: id } : {}) },
    },
  };
  return {
    plugin,
    config,
    state,
    connection(index = 0) {
      const connection = connections[index];
      if (!connection) {
        throw new Error(`Missing native inspection connection ${index}`);
      }
      return connection;
    },
    async cleanup(
      inspection?: Awaited<ReturnType<typeof acquirePluginRegistryForInspection>>,
      borrowed?: { release: () => Promise<void> },
    ) {
      resume.resolve();
      finishDisposal.resolve();
      await borrowed?.release().catch(() => undefined);
      await inspection?.release().catch(() => undefined);
      for (const connection of connections) {
        if (connection.database.isOpen) {
          connection.database.close();
        }
      }
      Reflect.deleteProperty(globalThis, key);
    },
  };
}

function acquireFixtureInspection(fixtures: Array<ReturnType<typeof createInspectionFixture>>) {
  return acquirePluginRegistryForInspection({
    config: {
      plugins: {
        allow: fixtures.map((fixture) => fixture.plugin.id),
        load: { paths: fixtures.map((fixture) => fixture.plugin.file) },
        slots: { memory: "none" },
      },
    },
  });
}

describe("owned plugin inspections", () => {
  it("revokes every owned view and cache identity before notifying retirement listeners", async () => {
    const fixture = createInspectionFixture();
    let inspection: Awaited<ReturnType<typeof acquirePluginRegistryForInspection>> | undefined;
    let borrowed: { release: () => Promise<void> } | undefined;
    try {
      inspection = await acquirePluginRegistryForInspection({ config: fixture.config });
      const primary = inspection.registry;
      const copy = { ...primary };
      const resources = getPluginRegistryInspectionResources(primary)!;
      resources.attach(copy);
      borrowed = resources.retain();
      const views = [primary, copy];
      const authorities = views.map((view) =>
        capturePluginLifecycleAuthority(view, undefined, { scopedRuntime: true })!,
      );
      const signals = views.map((view) =>
        capturePluginRegistryLifecycleSignal(view, undefined, { scopedRuntime: true })!,
      );
      const keys = ["owned-primary", "owned-copy"];
      views.forEach((view, index) => pluginLoaderCacheState.set(keys[index]!, view));
      const observations: boolean[][] = [];
      const reentrant: Array<Promise<void>> = [];
      for (const signal of signals) {
        signal.addEventListener("abort", () => {
          observations.push([
            ...authorities.map((current) => current()),
            ...keys.map((key) => pluginLoaderCacheState.get(key) !== undefined),
          ]);
          reentrant.push(inspection!.release());
        });
      }
      const release = inspection.release();
      expect(observations).toEqual([
        [false, false, false, false],
        [false, false, false, false],
      ]);
      expect(signals.every((signal) => signal.aborted)).toBe(true);
      expect(reentrant).toEqual([release, release]);
      await release;
      expect(fixture.connection().disposals).toBe(0);
      expect(fixture.connection().database.isOpen).toBe(true);
      await borrowed.release();
      expect(fixture.connection().disposals).toBe(1);
      expect(fixture.connection().database.isOpen).toBe(false);
    } finally {
      await fixture.cleanup(inspection, borrowed);
    }
  });

  it.each([
    { capturedDisposal: "async-context", disposalFailure: false },
    { capturedDisposal: "work-tracker", disposalFailure: true },
  ] as const)(
    "keeps registration cleanup captured by $capturedDisposal after its caller closes",
    async ({ capturedDisposal, disposalFailure }) => {
      const fixture = createInspectionFixture({
        capturedDisposal,
        disposalFailure,
        pauseDisposal: true,
      });
      const caller = new AsyncWorkScope();
      const closer = new AsyncWorkScope();
      let inspection: Awaited<ReturnType<typeof acquirePluginRegistryForInspection>> | undefined;
      let borrowed: { release: () => Promise<void> } | undefined;
      try {
        inspection = await caller.track(() =>
          acquirePluginRegistryForInspection({ config: fixture.config }),
        );
        borrowed = getPluginRegistryInspectionResources(inspection.registry)!.retain();
        const authority = capturePluginLifecycleAuthority(inspection.registry, undefined, {
          scopedRuntime: true,
        })!;
        await inspection.release();
        await caller.drain();
        expect(caller.signal.aborted).toBe(true);
        expect(authority()).toBe(false);
        expect(fixture.connection().database.prepare("SELECT 42 AS value").get()).toEqual({
          value: 42,
        });
        const registrationSignalAborted = fixture.state.captured.registrationSignal?.aborted;
        const released = closer
          .track(() => borrowed!.release())
          .then(
            () => ({ phase: "released", error: undefined }),
            (error: unknown) => ({ phase: "released", error }),
          );
        expect(
          await Promise.race([
            fixture.state.disposalStarted.promise.then(() => ({
              phase: "disposing",
              error: undefined,
            })),
            released,
          ]),
        ).toEqual({ phase: "disposing", error: undefined });
        expect(registrationSignalAborted).toBe(false);
        expect(fixture.state.captured.registrationSignal).not.toBe(caller.signal);
        expect(fixture.state.captured.disposalSignal).toBe(
          fixture.state.captured.registrationSignal,
        );
        expect(fixture.connection().database.isOpen).toBe(true);
        expect(authority()).toBe(false);
        fixture.state.finishDisposal.resolve();
        const outcome = await released;
        if (disposalFailure) {
          expect(outcome.error).toMatchObject({
            errors: [
              expect.objectContaining({
                message: `Plugin inspection disposal failed: ${fixture.plugin.id}:native-resource`,
                cause: expect.objectContaining({ message: "fixture disposal failed" }),
              }),
            ],
          });
        } else {
          expect(outcome.error).toBeUndefined();
        }
        expect(fixture.state.captured.read).toEqual({ value: 42 });
        expect(fixture.connection().disposals).toBe(1);
        expect(fixture.connection().database.isOpen).toBe(false);
        expect(fixture.connection().cleanups).toBe(0);
      } finally {
        await fixture.cleanup(inspection, borrowed);
        await Promise.all([caller.drain(), closer.drain()]);
      }
    },
  );

  it("releases an uncached inspection without disposing or changing the raw loader value", async () => {
    const fixture = createInspectionFixture({ pauseDisposal: true });
    const active = createEmptyPluginRegistry();
    setActivePluginRegistry(active);
    let inspection: Awaited<ReturnType<typeof acquirePluginRegistryForInspection>> | undefined;
    try {
      const raw = loadPluginRegistryHandle({ config: fixture.config });
      inspection = await acquirePluginRegistryForInspection({ config: fixture.config });
      expect(raw.plugins[0]?.id).toBe(fixture.plugin.id);
      expect(inspection.registry).not.toBe(raw);
      expect(getActivePluginRegistry()).toBe(active);
      expect(fixture.state.connections).toHaveLength(2);
      const legacy = fixture.connection();
      const owned = fixture.connection(1);
      expect(owned.database.prepare("SELECT 42 AS value").get()).toEqual({ value: 42 });
      const signal = capturePluginRegistryLifecycleSignal(inspection.registry, undefined, {
        scopedRuntime: true,
      });
      let reentrantRelease: Promise<void> | undefined;
      signal?.addEventListener("abort", () => {
        reentrantRelease = inspection?.release();
      });
      const release = inspection.release();
      expect(signal?.aborted).toBe(true);
      expect(reentrantRelease).toBe(release);
      expect(inspection.release()).toBe(release);
      await fixture.state.disposalStarted.promise;
      expect(owned.database.isOpen).toBe(true);
      fixture.state.finishDisposal.resolve();
      await release;
      expect(owned.disposals).toBe(1);
      expect(owned.database.isOpen).toBe(false);
      expect(legacy.database.prepare("SELECT 42 AS value").get()).toEqual({ value: 42 });
      expect(legacy.disposals).toBe(0);
      expect(legacy.cleanups).toBe(0);
      expect(loadPluginRegistryHandle({ config: fixture.config })).toBe(raw);
      expect(getActivePluginRegistry()).toBe(active);
    } finally {
      await fixture.cleanup(inspection);
    }
  });

  it.each([false, true])(
    "revokes a released inspection while retaining its native resources (disposal failure: %s)",
    async (disposalFailure) => {
      const fixture = createInspectionFixture({ pauseDisposal: true, disposalFailure });
      const active = createEmptyPluginRegistry();
      setActivePluginRegistry(active);
      const activeEpoch = capturePluginRegistryLifecycleEpoch(active);
      let inspection: Awaited<ReturnType<typeof acquirePluginRegistryForInspection>> | undefined;
      let borrowed: { release: () => Promise<void> } | undefined;
      try {
        inspection = await acquirePluginRegistryForInspection({ config: fixture.config });
        const resources = getPluginRegistryInspectionResources(inspection.registry)!;
        borrowed = resources.retain();
        const signal = capturePluginRegistryLifecycleSignal(inspection.registry, undefined, {
          scopedRuntime: true,
        })!;
        const authority = capturePluginLifecycleAuthority(inspection.registry, undefined, {
          scopedRuntime: true,
        })!;
        let reentrantRelease: Promise<void> | undefined;
        signal.addEventListener("abort", () => {
          expect(authority()).toBe(false);
          expect(() => resources.retain()).toThrow("inspection resources have been released");
          reentrantRelease = inspection?.release();
        });

        const release = inspection.release();
        expect(signal.aborted).toBe(true);
        expect(authority()).toBe(false);
        expect(reentrantRelease).toBe(release);
        await release;
        expect(inspection.release()).toBe(release);
        const connection = fixture.connection();
        expect(connection.disposals).toBe(0);
        expect(connection.database.prepare("SELECT 42 AS value").get()).toEqual({ value: 42 });
        expect(getActivePluginRegistry()).toBe(active);
        expect(capturePluginRegistryLifecycleEpoch(active)).toBe(activeEpoch);

        const finalRelease = borrowed.release();
        expect(borrowed.release()).toBe(finalRelease);
        const settled = disposalFailure
          ? expect(finalRelease).rejects.toMatchObject({
              errors: [
                expect.objectContaining({
                  message: `Plugin inspection disposal failed: ${fixture.plugin.id}:native-resource`,
                }),
              ],
            })
          : expect(finalRelease).resolves.toBeUndefined();
        await fixture.state.disposalStarted.promise;
        expect(connection.database.isOpen).toBe(true);
        fixture.state.finishDisposal.resolve();
        await settled;
        expect(connection.disposals).toBe(1);
        expect(connection.database.isOpen).toBe(false);
        expect(connection.cleanups).toBe(0);
        expect(signal.aborted).toBe(true);
        expect(authority()).toBe(false);
      } finally {
        await fixture.cleanup(inspection, borrowed);
      }
    },
  );

  it.each([false, true])(
    "disposes a failed registration without closing a successful sibling (borrowed: %s)",
    async (retainSibling) => {
      const failed = createInspectionFixture({ registration: "throw", disposalFailure: true });
      const successful = createInspectionFixture();
      let inspection: Awaited<ReturnType<typeof acquirePluginRegistryForInspection>> | undefined;
      let borrowed: { release: () => Promise<void> } | undefined;
      try {
        inspection = await acquireFixtureInspection([failed, successful]);
        if (retainSibling) {
          borrowed = getPluginRegistryInspectionResources(inspection.registry)!.retain();
        }
        expect(
          inspection.registry.plugins.find((entry) => entry.id === failed.plugin.id),
        ).toMatchObject({
          status: "error",
          failurePhase: "register",
        });
        expect(inspection.registry.runtimeLifecycles.map((entry) => entry.pluginId)).toEqual([
          successful.plugin.id,
        ]);
        await failed.state.disposed.promise;
        expect(failed.connection().database.isOpen).toBe(false);
        expect(successful.connection().database.prepare("SELECT 42 AS value").get()).toEqual({
          value: 42,
        });
        await expect(inspection.release()).rejects.toMatchObject({
          errors: [
            expect.objectContaining({
              message: `Plugin inspection disposal failed: ${failed.plugin.id}:native-resource`,
            }),
          ],
        });
        if (borrowed) {
          expect(successful.connection().disposals).toBe(0);
          expect(successful.connection().database.prepare("SELECT 42 AS value").get()).toEqual({
            value: 42,
          });
          await expect(borrowed.release()).resolves.toBeUndefined();
        }
        expect(failed.connection().disposals).toBe(1);
        expect(successful.connection().disposals).toBe(1);
        expect(successful.connection().database.isOpen).toBe(false);
      } finally {
        await failed.cleanup(inspection, borrowed);
        await successful.cleanup();
      }
    },
  );

  it.each(["same-turn", "abort-listener"] as const)(
    "assigns final disposal to the borrower released after the inspection (%s)",
    async (timing) => {
      const fixture = createInspectionFixture({ pauseDisposal: true, disposalFailure: true });
      let inspection: Awaited<ReturnType<typeof acquirePluginRegistryForInspection>> | undefined;
      let borrowed: { release: () => Promise<void> } | undefined;
      try {
        inspection = await acquirePluginRegistryForInspection({ config: fixture.config });
        borrowed = getPluginRegistryInspectionResources(inspection.registry)!.retain();
        const signal = capturePluginRegistryLifecycleSignal(inspection.registry, undefined, {
          scopedRuntime: true,
        })!;
        let borrowedRelease: Promise<void> | undefined;
        if (timing === "abort-listener") {
          signal.addEventListener("abort", () => {
            borrowedRelease = borrowed?.release();
          });
        }
        const inspectionRelease = inspection.release();
        if (timing === "same-turn") {
          borrowedRelease = borrowed.release();
        }
        expect(signal.aborted).toBe(true);
        expect(borrowedRelease).toBeDefined();
        const inspectionOutcome = inspectionRelease.then(
          () => ({ owner: "inspection", error: undefined }),
          (error: unknown) => ({ owner: "inspection", error }),
        );
        const borrowerOutcome = borrowedRelease!.then(
          () => ({ owner: "borrower", error: undefined }),
          (error: unknown) => ({ owner: "borrower", error }),
        );
        await fixture.state.disposalStarted.promise;
        expect(fixture.connection().database.isOpen).toBe(true);
        expect(await Promise.race([inspectionOutcome, borrowerOutcome])).toEqual({
          owner: "inspection",
          error: undefined,
        });
        fixture.state.finishDisposal.resolve();
        expect(await borrowerOutcome).toMatchObject({
          owner: "borrower",
          error: {
            errors: [
              expect.objectContaining({
                message: `Plugin inspection disposal failed: ${fixture.plugin.id}:native-resource`,
              }),
            ],
          },
        });
        expect(fixture.connection().disposals).toBe(1);
        expect(fixture.connection().database.isOpen).toBe(false);
        expect(fixture.connection().cleanups).toBe(0);
      } finally {
        await fixture.cleanup(inspection, borrowed);
      }
    },
  );

  it("finishes construction rollback before rejecting an inspection", async () => {
    const fixture = createInspectionFixture({ registration: "throw" });
    try {
      await expect(
        acquirePluginRegistryForInspection({ config: fixture.config, throwOnLoadError: true }),
      ).rejects.toThrow();
      expect(fixture.state.connections).toHaveLength(1);
      expect(fixture.connection().database.isOpen).toBe(false);
      expect(fixture.connection().disposals).toBe(1);
    } finally {
      await fixture.cleanup();
    }
  });

  it.each([true, false])(
    "reports mixed cleanup failures in registration order (failed registration first: %s)",
    async (failedFirst) => {
      const fixtures = [failedFirst, !failedFirst].map((failsRegistration) =>
        createInspectionFixture({
          registration: failsRegistration ? "throw" : undefined,
          disposalFailure: true,
          pauseDisposal: true,
        }),
      );
      let inspection: Awaited<ReturnType<typeof acquirePluginRegistryForInspection>> | undefined;
      try {
        inspection = await acquirePluginRegistryForInspection({
          config: {
            plugins: {
              allow: fixtures.map((fixture) => fixture.plugin.id),
              load: { paths: fixtures.map((fixture) => fixture.plugin.file) },
              slots: { memory: "none" },
            },
          },
        });
        expect(inspection.registry.plugins.map((plugin) => plugin.id)).toEqual(
          fixtures.map((fixture) => fixture.plugin.id),
        );
        const release = inspection.release();
        const rejected = expect(release).rejects.toMatchObject({
          errors: fixtures.map((fixture) =>
            expect.objectContaining({
              message: `Plugin inspection disposal failed: ${fixture.plugin.id}:native-resource`,
            }),
          ),
        });
        // Neither paused disposer may prevent its sibling from starting.
        await Promise.all(fixtures.map((fixture) => fixture.state.disposalStarted.promise));
        for (const fixture of fixtures) {
          expect(fixture.connection().database.isOpen).toBe(true);
          fixture.state.finishDisposal.resolve();
        }
        await rejected;
        for (const fixture of fixtures) {
          expect(fixture.connection().disposals).toBe(1);
          expect(fixture.connection().database.isOpen).toBe(false);
          expect(fixture.connection().cleanups).toBe(0);
        }
      } finally {
        for (const fixture of fixtures) {
          fixture.state.finishDisposal.resolve();
        }
        await Promise.all(fixtures.map((fixture) => fixture.cleanup(inspection)));
      }
    },
  );

  it.each(["async-resolve", "async-reject", "thenable", "tracked"] as const)(
    "waits for actual registration work before disposal (%s)",
    async (registration) => {
      const sibling = createInspectionFixture();
      const fixture = createInspectionFixture({ registration });
      fixture.state.sibling.read = () =>
        sibling.connection().database.prepare("SELECT 42 AS value").get()?.value;
      let inspection: Awaited<ReturnType<typeof acquirePluginRegistryForInspection>> | undefined;
      try {
        inspection = await acquireFixtureInspection([sibling, fixture]);
        const record = inspection.registry.plugins.find((entry) => entry.id === fixture.plugin.id);
        if (registration === "tracked") {
          expect(record?.status).toBe("loaded");
        } else {
          expect(record?.error).toContain("plugin register must be synchronous");
        }
        expect(inspection.registry.runtimeLifecycles).toHaveLength(
          registration === "tracked" ? 2 : 1,
        );
        let released = false;
        const release = inspection.release().then(() => {
          released = true;
        });
        await Promise.resolve();
        expect(released).toBe(false);
        expect(fixture.connection().disposals).toBe(0);
        fixture.state.resume.resolve();
        await release;
        expect(fixture.state.lateRead).toBe(42);
        expect(fixture.state.sibling.result).toBe(42);
        if (registration === "thenable") {
          expect(fixture.state.thenCalls).toBe(1);
        }
        expect(sibling.connection().database.isOpen).toBe(false);
        expect(fixture.connection().disposals).toBe(1);
        expect(fixture.connection().database.isOpen).toBe(false);
      } finally {
        await fixture.cleanup(inspection);
        await sibling.cleanup();
      }
    },
  );

  it("joins queued registration-signal cleanup before disposing native resources", async () => {
    const fixture = createInspectionFixture({ queuedAbortCleanup: true });
    let inspection: Awaited<ReturnType<typeof acquirePluginRegistryForInspection>> | undefined;
    try {
      inspection = await acquirePluginRegistryForInspection({ config: fixture.config });
      await inspection.release();
      await expect(fixture.state.captured.abortCleanup).resolves.toBeUndefined();
      expect(fixture.state.captured.abortRead).toEqual({ value: 42 });
      expect(fixture.connection().disposals).toBe(1);
      expect(fixture.connection().database.isOpen).toBe(false);
      expect(fixture.connection().cleanups).toBe(0);
    } finally {
      await fixture.cleanup(inspection);
    }
  });

  it.each([false, true])(
    "joins cross-registration abort work before last-borrower disposal (descendant: %s)",
    async (descendant) => {
      const first = createInspectionFixture({ queuedAbortCleanup: true });
      const sibling = createInspectionFixture(
        descendant ? { capturedDisposal: "work-tracker" } : undefined,
      );
      let siblingWork: Promise<void> | undefined;
      let siblingReads: unknown;
      first.state.sibling.read = descendant
        ? () => {
            siblingWork = sibling.state.captured.tracker!(async () => {
              await readFile(sibling.plugin.file);
              siblingReads = {
                first: first.connection().database.prepare("SELECT 42 AS value").get()?.value,
                sibling: sibling.connection().database.prepare("SELECT 42 AS value").get()?.value,
              };
            });
            // A deliberately returns before B's admitted descendant settles.
            void siblingWork.catch(() => undefined);
          }
        : () => sibling.connection().database.prepare("SELECT 42 AS value").get()?.value;
      let inspection: Awaited<ReturnType<typeof acquirePluginRegistryForInspection>> | undefined;
      let borrowed: { release: () => Promise<void> } | undefined;
      try {
        inspection = await acquireFixtureInspection([first, sibling]);
        borrowed = getPluginRegistryInspectionResources(inspection.registry)!.retain();
        await inspection.release();
        expect(first.connection().disposals).toBe(0);
        expect(sibling.connection().disposals).toBe(0);
        await borrowed.release();
        expect(first.state.captured.abortRead).toEqual({ value: 42 });
        await expect(first.state.captured.abortCleanup).resolves.toBeUndefined();
        if (descendant) {
          await expect(siblingWork).resolves.toBeUndefined();
          expect(siblingReads).toEqual({ first: 42, sibling: 42 });
        } else {
          expect(first.state.sibling.result).toBe(42);
        }
        for (const fixture of [first, sibling]) {
          expect(fixture.connection().disposals).toBe(1);
          expect(fixture.connection().database.isOpen).toBe(false);
          expect(fixture.connection().cleanups).toBe(0);
        }
      } finally {
        await first.cleanup(inspection, borrowed);
        await siblingWork?.catch(() => undefined);
        await sibling.cleanup();
      }
    },
  );

  it("joins rollback abort work handed to an open retained sibling", async () => {
    const sibling = createInspectionFixture({ capturedDisposal: "work-tracker" });
    const failed = createInspectionFixture({ registration: "throw", queuedAbortCleanup: true });
    const handedOff = createDeferredCore();
    let siblingWork: Promise<void> | undefined;
    let reads: unknown;
    failed.state.sibling.read = () => {
      siblingWork = sibling.state.captured.tracker!(async () => {
        await readFile(sibling.plugin.file);
        reads = {
          failed: failed.connection().database.prepare("SELECT 42 AS value").get()?.value,
          sibling: sibling.connection().database.prepare("SELECT 42 AS value").get()?.value,
        };
      });
      void siblingWork.catch(() => undefined);
      handedOff.resolve();
    };
    let inspection: Awaited<ReturnType<typeof acquirePluginRegistryForInspection>> | undefined;
    let borrowed: { release: () => Promise<void> } | undefined;
    try {
      inspection = await acquireFixtureInspection([sibling, failed]);
      borrowed = getPluginRegistryInspectionResources(inspection.registry)!.retain();
      await handedOff.promise;
      await expect(siblingWork).resolves.toBeUndefined();
      expect(reads).toEqual({ failed: 42, sibling: 42 });
      await failed.state.disposed.promise;
      expect(failed.connection().disposals).toBe(1);
      expect(sibling.connection().disposals).toBe(0);
      expect(sibling.state.captured.registrationSignal?.aborted).toBe(false);
      await inspection.release();
      expect(sibling.connection().database.isOpen).toBe(true);
      await borrowed.release();
      expect(sibling.connection().database.isOpen).toBe(false);
      expect(sibling.connection().disposals).toBe(1);
    } finally {
      await failed.cleanup(inspection, borrowed);
      await siblingWork?.catch(() => undefined);
      await sibling.cleanup();
    }
  });

  it("keeps a sibling resource alive while a disposer explicitly uses its work owner", async () => {
    const first = createInspectionFixture({
      capturedDisposal: "sibling-tracker",
      pauseDisposal: true,
    });
    const sibling = createInspectionFixture({ capturedDisposal: "work-tracker" });
    first.state.sibling.track = (run) => sibling.state.captured.tracker!(run);
    first.state.sibling.read = () =>
      sibling.connection().database.prepare("SELECT 42 AS value").get()?.value;
    let inspection: Awaited<ReturnType<typeof acquirePluginRegistryForInspection>> | undefined;
    try {
      inspection = await acquireFixtureInspection([first, sibling]);
      const released = inspection.release();
      await first.state.disposalStarted.promise;
      await readFile(first.plugin.file);
      expect(first.connection().database.isOpen).toBe(true);
      expect(sibling.connection().database.isOpen).toBe(true);
      expect(sibling.connection().disposals).toBe(0);
      first.state.finishDisposal.resolve();
      await released;
      expect(first.state.sibling.result).toBe(42);
      for (const fixture of [first, sibling]) {
        expect(fixture.connection().disposals).toBe(1);
        expect(fixture.connection().database.isOpen).toBe(false);
        expect(fixture.connection().cleanups).toBe(0);
      }
    } finally {
      await first.cleanup(inspection);
      await sibling.cleanup();
    }
  });

  it("joins invalid registration work before releasing an inspection with a retained sibling", async () => {
    const sibling = createInspectionFixture();
    const fixture = createInspectionFixture({ registration: "async-reject" });
    fixture.state.sibling.read = () =>
      sibling.connection().database.prepare("SELECT 42 AS value").get()?.value;
    let inspection: Awaited<ReturnType<typeof acquirePluginRegistryForInspection>> | undefined;
    let borrowed: { release: () => Promise<void> } | undefined;
    try {
      inspection = await acquireFixtureInspection([sibling, fixture]);
      borrowed = getPluginRegistryInspectionResources(inspection.registry)!.retain();
      let released = false;
      const release = inspection.release().then(() => {
        released = true;
      });
      await Promise.resolve();
      expect(released).toBe(false);
      expect(fixture.connection().disposals).toBe(0);
      fixture.state.resume.resolve();
      await release;
      expect(fixture.state.lateRead).toBe(42);
      expect(fixture.state.sibling.result).toBe(42);
      expect(fixture.connection().database.isOpen).toBe(false);
      expect(fixture.connection().disposals).toBe(1);
      expect(sibling.connection().disposals).toBe(0);
      expect(sibling.connection().database.prepare("SELECT 42 AS value").get()).toEqual({
        value: 42,
      });
      await borrowed.release();
      expect(sibling.connection().database.isOpen).toBe(false);
      expect(sibling.connection().disposals).toBe(1);
    } finally {
      await fixture.cleanup(inspection, borrowed);
      await sibling.cleanup();
    }
  });

  it("releases Doctor discovery resources without invoking the context engine factory", async () => {
    const fixture = createInspectionFixture({ contextEngine: true, pauseDisposal: true });
    const { collectContextEngineHostCompatibilityWarnings } =
      await import("../commands/doctor/shared/context-engine-host-compat.js");
    let warnings: Promise<string[]> | undefined;
    try {
      warnings = collectContextEngineHostCompatibilityWarnings({
        cfg: fixture.config,
        doctorFixCommand: "openclaw doctor --fix",
      });
      await vi.waitFor(() => expect(fixture.state.connections).toHaveLength(1));
      let completed = false;
      void warnings.then(() => {
        completed = true;
      });
      await Promise.resolve();
      expect(completed).toBe(false);
      expect(fixture.state.factoryCalls).toBe(0);
      fixture.state.finishDisposal.resolve();
      expect((await warnings).join("\n")).toContain("registered for read-only discovery");
      expect(fixture.connection().disposals).toBe(1);
      expect(fixture.connection().database.isOpen).toBe(false);
      expect(fixture.connection().cleanups).toBe(0);
    } finally {
      fixture.state.finishDisposal.resolve();
      await warnings?.catch(() => undefined);
      await fixture.cleanup();
    }
  });
});
