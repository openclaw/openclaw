import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
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
  activatePluginRecordLifecycleEpoch,
  capturePluginLifecycleAuthority,
  capturePluginRegistryLifecycleEpoch,
  capturePluginRegistryLifecycleSignal,
  isPluginRecordLifecycleEpochActive,
  isPluginRegistryActivated,
  isPluginRegistryLifecycleEpochActive,
  markPluginRegistryActive,
  markPluginRegistryRetired,
  revokePluginRecordLifecycleEpoch,
} from "./registry-lifecycle.js";
import type { PluginRegistry } from "./registry-types.js";
import {
  captureActivePluginRegistrySnapshot,
  commitStagedPluginRegistry,
  getActivePluginRegistry,
  resetPluginRuntimeStateForTest,
  rollbackStagedPluginRegistry,
  setActivePluginRegistry,
  stageActivePluginRegistry,
} from "./runtime.js";
import {
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeRegistryScope,
} from "./runtime/gateway-request-scope.js";
import { createPluginRecord } from "./status.test-helpers.js";

function captureActivation(registry: PluginRegistry) {
  const epoch = capturePluginRegistryLifecycleEpoch(registry)!;
  expect(epoch).toBeDefined();
  const signal = capturePluginRegistryLifecycleSignal(registry, epoch)!;
  expect(signal).toBeDefined();
  return { epoch, signal };
}

afterEach(() => resetPluginRuntimeStateForTest());
afterEach(resetPluginLoaderTestStateForTest);

describe("plugin registry retirement notifications", () => {
  it.each(["retire", "activate"] as const)(
    "notifies a scoped loader handle on %s without inventing an activation epoch",
    (action) => {
      const registry = loadPluginRegistryHandle({ onlyPluginIds: [] });
      const record = createPluginRecord({ id: "scoped-owner" });
      registry.plugins.push(record);
      expect(capturePluginRegistryLifecycleSignal(registry, undefined)).toBeUndefined();
      const { signal, authority } = withPluginRuntimeRegistryScope(registry, () => {
        const scopedRuntime = getPluginRuntimeGatewayRequestScope()?.pluginRegistry === registry;
        const epoch = capturePluginRegistryLifecycleEpoch(registry);
        const options = { scopedRuntime };
        return {
          signal: capturePluginRegistryLifecycleSignal(registry, epoch, options)!,
          authority: capturePluginLifecycleAuthority(registry, record, options)!,
        };
      });
      expect(signal?.aborted).toBe(false);
      expect(authority()).toBe(true);
      expect(capturePluginRegistryLifecycleEpoch(registry)).toBeUndefined();
      expect(isPluginRegistryActivated(registry)).toBe(false);
      expect(activatePluginRecordLifecycleEpoch(registry, record)).toBeUndefined();
      expect(capturePluginRegistryLifecycleSignal(registry, undefined)).toBeUndefined();
      expect(
        capturePluginRegistryLifecycleSignal(registry, undefined, { scopedRuntime: true }),
      ).toBe(signal);
      const observations: boolean[] = [];
      signal.addEventListener("abort", () => observations.push(authority()));

      if (action === "retire") {
        markPluginRegistryRetired(registry);
      } else {
        markPluginRegistryActive(registry);
      }

      expect(observations).toEqual([false]);
      expect(signal.aborted).toBe(true);
      expect(
        capturePluginRegistryLifecycleSignal(registry, undefined, { scopedRuntime: true }),
      ).toBeUndefined();
      markPluginRegistryActive(registry);
      expect(captureActivation(registry).signal.aborted).toBe(false);
      expect(signal.aborted).toBe(true);
      expect(authority()).toBe(false);
      expect(observations).toHaveLength(1);
    },
  );

  it("keeps epoch identity opaque and rejects missing or mismatched activation signals", () => {
    const registry = createEmptyPluginRegistry();
    const other = createEmptyPluginRegistry();
    expect(capturePluginRegistryLifecycleSignal(registry, {})).toBeUndefined();
    expect(capturePluginLifecycleAuthority(registry)).toBeUndefined();
    const scopedAuthority = capturePluginLifecycleAuthority(registry, undefined, {
      scopedRuntime: true,
    });
    expect(scopedAuthority?.()).toBe(true);

    markPluginRegistryActive(registry);
    const { epoch, signal } = captureActivation(registry);
    expect(Object.isFrozen(epoch)).toBe(true);
    for (const property of ["abort", "controller", "signal"]) {
      expect(epoch).not.toHaveProperty(property);
    }
    expect(capturePluginRegistryLifecycleEpoch(registry)).toBe(epoch);
    expect(capturePluginRegistryLifecycleSignal(registry, epoch)).toBe(signal);
    expect(capturePluginRegistryLifecycleSignal(other, epoch)).toBeUndefined();
    expect(capturePluginRegistryLifecycleSignal(registry, { ...epoch })).toBeUndefined();
    expect(scopedAuthority?.()).toBe(false);
  });

  it.each(["retire", "reactivate"] as const)(
    "revokes registry and record authority before %s listeners run",
    (action) => {
      const registry = createEmptyPluginRegistry();
      const record = createPluginRecord({ id: "lifecycle-owner" });
      registry.plugins.push(record);
      markPluginRegistryActive(registry);
      const { epoch, signal } = captureActivation(registry);
      const recordEpoch = activatePluginRecordLifecycleEpoch(registry, record)!;
      const authority = capturePluginLifecycleAuthority(registry, record)!;
      expect(isPluginRecordLifecycleEpochActive(registry, record, recordEpoch)).toBe(true);
      expect(authority()).toBe(true);
      const observations: unknown[] = [];
      signal.addEventListener("abort", () => {
        const nextEpoch = capturePluginRegistryLifecycleEpoch(registry);
        observations.push({
          registryActive: isPluginRegistryLifecycleEpochActive(registry, epoch),
          recordActive: isPluginRecordLifecycleEpochActive(registry, record, recordEpoch),
          authorityActive: authority(),
          oldSignal: capturePluginRegistryLifecycleSignal(registry, epoch),
          nextActive: nextEpoch ? isPluginRegistryLifecycleEpochActive(registry, nextEpoch) : false,
          nextSignalAborted: nextEpoch
            ? capturePluginRegistryLifecycleSignal(registry, nextEpoch)?.aborted
            : undefined,
        });
      });

      if (action === "retire") {
        markPluginRegistryRetired(registry);
      } else {
        markPluginRegistryActive(registry);
      }

      expect(signal.aborted).toBe(true);
      expect(observations).toEqual([
        {
          registryActive: false,
          recordActive: false,
          authorityActive: false,
          oldSignal: undefined,
          nextActive: action === "reactivate",
          nextSignalAborted: action === "reactivate" ? false : undefined,
        },
      ]);
      markPluginRegistryActive(registry);
      const next = captureActivation(registry);
      expect(next.epoch).not.toBe(epoch);
      expect(next.signal.aborted).toBe(false);
      expect(signal.aborted).toBe(true);
      expect(authority()).toBe(false);
      expect(observations).toHaveLength(1);
    },
  );

  it("does not retire a registry or sibling record when one record is revoked", () => {
    const registry = createEmptyPluginRegistry();
    const first = createPluginRecord({ id: "first-owner" });
    const sibling = createPluginRecord({ id: "sibling-owner" });
    registry.plugins.push(first, sibling);
    markPluginRegistryActive(registry);
    const { epoch, signal } = captureActivation(registry);
    const firstEpoch = activatePluginRecordLifecycleEpoch(registry, first)!;
    const siblingEpoch = activatePluginRecordLifecycleEpoch(registry, sibling)!;

    revokePluginRecordLifecycleEpoch(registry, first);

    expect(isPluginRecordLifecycleEpochActive(registry, first, firstEpoch)).toBe(false);
    expect(isPluginRecordLifecycleEpochActive(registry, sibling, siblingEpoch)).toBe(true);
    expect(isPluginRegistryLifecycleEpochActive(registry, epoch)).toBe(true);
    expect(signal.aborted).toBe(false);
  });

  it.each(["commit", "rollback"] as const)(
    "retires only the abandoned activation after staged %s",
    (action) => {
      const original = createEmptyPluginRegistry();
      const candidate = createEmptyPluginRegistry();
      setActivePluginRegistry(original);
      const first = captureActivation(original);
      const snapshot = captureActivePluginRegistrySnapshot();

      stageActivePluginRegistry(candidate, "candidate", "default");
      const second = captureActivation(candidate);
      expect(first.signal.aborted).toBe(false);

      if (action === "commit") {
        commitStagedPluginRegistry(original, candidate);
      } else {
        rollbackStagedPluginRegistry(snapshot);
      }

      expect(first.signal.aborted).toBe(action === "commit");
      expect(second.signal.aborted).toBe(action === "rollback");
      const retained = action === "commit" ? second : first;
      const current = captureActivation(action === "commit" ? candidate : original);
      expect(current.epoch).toBe(retained.epoch);
      expect(current.signal).toBe(retained.signal);
    },
  );
});

type InspectionConnection = { database: DatabaseSync; disposals: number; cleanups: number };
let inspectionFixtureId = 0;

function createInspectionFixture(options?: {
  registration?: "throw" | "async-resolve" | "async-reject";
  pauseDisposal?: boolean;
  disposalFailure?: boolean;
  contextEngine?: boolean;
}) {
  useNoBundledPlugins();
  const id = `owned-inspection-${inspectionFixtureId++}`;
  const key = `__openclaw_${id}`;
  const connections: InspectionConnection[] = [];
  const resume = createDeferredCore();
  const finishDisposal = createDeferredCore();
  const disposalStarted = createDeferredCore();
  const disposed = createDeferredCore();
  const sibling: { read?: () => unknown; result?: unknown } = {};
  const state = {
    connections,
    resume,
    finishDisposal,
    disposalStarted,
    disposed,
    sibling,
    lateRead: 0,
    factoryCalls: 0,
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
    class NativeLifecycle {
      id = " native-resource ";
      #database = database;
      async dispose() {
        connection.disposals++;
        state.disposalStarted.resolve();
        if (${options?.pauseDisposal === true}) await state.finishDisposal.promise;
        this.#database.close();
        state.disposed.resolve();
        if (${options?.disposalFailure === true}) throw new Error("fixture disposal failed");
      }
      cleanup = () => {
        connection.cleanups++;
        if (database.isOpen) database.close();
      };
    }
    api.registerRuntimeLifecycle(new NativeLifecycle());
    if (${options?.contextEngine === true}) {
      api.registerContextEngine(${JSON.stringify(id)}, () => {
        state.factoryCalls++;
        throw new Error("Discovery must not invoke the context engine factory");
      });
    }
    const mode = ${JSON.stringify(options?.registration)};
    if (mode === "throw") throw new Error("fixture registration failed");
    if (mode?.startsWith("async")) return (async () => {
      await state.resume.promise;
      state.lateRead = database.prepare("SELECT 42 AS value").get().value;
      state.sibling.result = state.sibling.read?.();
      if (mode === "async-reject") throw new Error("late registration failure");
    })();
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

describe("owned plugin inspections", () => {
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
        inspection = await acquirePluginRegistryForInspection({
          config: {
            plugins: {
              allow: [failed.plugin.id, successful.plugin.id],
              load: { paths: [failed.plugin.file, successful.plugin.file] },
              slots: { memory: "none" },
            },
          },
        });
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

  it.each(["async-resolve", "async-reject"] as const)(
    "waits for actual invalid registration work before disposal (%s)",
    async (registration) => {
      const sibling = createInspectionFixture();
      const fixture = createInspectionFixture({ registration });
      fixture.state.sibling.read = () =>
        sibling.connection().database.prepare("SELECT 42 AS value").get()?.value;
      let inspection: Awaited<ReturnType<typeof acquirePluginRegistryForInspection>> | undefined;
      try {
        inspection = await acquirePluginRegistryForInspection({
          config: {
            plugins: {
              allow: [sibling.plugin.id, fixture.plugin.id],
              load: { paths: [sibling.plugin.file, fixture.plugin.file] },
              slots: { memory: "none" },
            },
          },
        });
        expect(
          inspection.registry.plugins.find((entry) => entry.id === fixture.plugin.id)?.error,
        ).toContain("plugin register must be synchronous");
        expect(inspection.registry.runtimeLifecycles).toHaveLength(1);
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
        expect(sibling.connection().database.isOpen).toBe(false);
        expect(fixture.connection().disposals).toBe(1);
        expect(fixture.connection().database.isOpen).toBe(false);
      } finally {
        await fixture.cleanup(inspection);
        await sibling.cleanup();
      }
    },
  );

  it("joins invalid registration work before releasing an inspection with a retained sibling", async () => {
    const sibling = createInspectionFixture();
    const fixture = createInspectionFixture({ registration: "async-reject" });
    fixture.state.sibling.read = () =>
      sibling.connection().database.prepare("SELECT 42 AS value").get()?.value;
    let inspection: Awaited<ReturnType<typeof acquirePluginRegistryForInspection>> | undefined;
    let borrowed: { release: () => Promise<void> } | undefined;
    try {
      inspection = await acquirePluginRegistryForInspection({
        config: {
          plugins: {
            allow: [sibling.plugin.id, fixture.plugin.id],
            load: { paths: [sibling.plugin.file, fixture.plugin.file] },
            slots: { memory: "none" },
          },
        },
      });
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
