import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import { acquirePluginRegistryForInspection, loadPluginRegistryHandle } from "./loader.js";
import { resetPluginLoaderTestStateForTest } from "./loader.test-fixtures.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import {
  getPluginRegistryInspectionResources,
  PluginRegistryInspectionResources,
} from "./registry-inspection-resources.js";
import {
  acquireFixtureInspection,
  createInspectionFixture,
} from "./registry-inspection.test-helpers.js";
import {
  capturePluginLifecycleAuthority,
  capturePluginRegistryLifecycleEpoch,
  capturePluginRegistryLifecycleSignal,
  getPluginLoaderCacheState,
} from "./registry-lifecycle.js";
import type { PluginRegistry } from "./registry-types.js";
import {
  disposePluginRegistryInstances,
  getActivePluginRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "./runtime.js";

afterEach(() => resetPluginRuntimeStateForTest());
afterEach(resetPluginLoaderTestStateForTest);

describe("owned plugin inspections", () => {
  it.each([false, true])(
    "keeps borrowed sources through final native cleanup (failure: %s)",
    async (fails) => {
      const order: string[] = [];
      const entered = createDeferredCore();
      const finish = createDeferredCore();
      const failure = new Error("primary native cleanup failed");
      const donor = new PluginRegistryInspectionResources(async () => {
        order.push("donor");
      });
      const primary = new PluginRegistryInspectionResources(async () => {
        order.push("primary");
        entered.resolve();
        await finish.promise;
        expect(order).toEqual(["primary"]);
        if (fails) {
          throw failure;
        }
      });
      primary.retainDependency(donor);
      await donor.release();
      const release = primary.release();
      const outcome = release.then(
        () => undefined,
        (error: unknown) => error,
      );
      try {
        await expect(
          Promise.race([entered.promise.then(() => "entered"), outcome.then(() => "released")]),
        ).resolves.toBe("entered");
        expect(order).toEqual(["primary"]);
        finish.resolve();
        if (fails) {
          expect(await outcome).toMatchObject({ errors: [failure] });
        } else {
          expect(await outcome).toBeUndefined();
        }
        expect(order).toEqual(["primary", "donor"]);
        expect(primary.release()).toBe(release);
      } finally {
        finish.resolve();
        await primary.release().catch(() => {});
        await donor.release().catch(() => {});
      }
    },
  );

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
      const pluginLoaderCacheState = getPluginLoaderCacheState();
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
    { capturedDisposal: "async-context", disposalFailure: false, capturedInstanceDisposal: false },
    { capturedDisposal: "work-tracker", disposalFailure: true, capturedInstanceDisposal: false },
    { capturedDisposal: "work-tracker", disposalFailure: false, capturedInstanceDisposal: true },
  ] as const)(
    "keeps registration cleanup captured by $capturedDisposal after its caller closes (instance: $capturedInstanceDisposal)",
    async ({ capturedDisposal, disposalFailure, capturedInstanceDisposal }) => {
      const fixture = createInspectionFixture({
        capturedDisposal,
        disposalFailure,
        capturedInstanceDisposal,
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
        expect(fixture.connection().instanceDisposals).toBe(1);
        if (capturedInstanceDisposal) {
          expect(fixture.state.captured.instanceSignal).toBe(
            fixture.state.captured.registrationSignal,
          );
        }
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
    let raw: PluginRegistry | undefined;
    try {
      raw = loadPluginRegistryHandle({ config: fixture.config });
      inspection = await acquirePluginRegistryForInspection({ config: fixture.config });
      expect(raw.plugins[0]?.id).toBe(fixture.plugin.id);
      expect(inspection.registry).not.toBe(raw);
      expect(getActivePluginRegistry()).toBe(active);
      expect(fixture.state.connections).toHaveLength(2);
      expect(process.listenerCount(fixture.event)).toBe(2);
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
      expect(owned.instanceDisposals).toBe(1);
      expect(process.listenerCount(fixture.event)).toBe(1);
      expect(owned.database.isOpen).toBe(false);
      expect(legacy.database.prepare("SELECT 42 AS value").get()).toEqual({ value: 42 });
      expect(legacy.disposals).toBe(0);
      expect(legacy.cleanups).toBe(0);
      expect(legacy.instanceDisposals).toBe(0);
      expect(loadPluginRegistryHandle({ config: fixture.config })).toBe(raw);
      expect(getActivePluginRegistry()).toBe(active);
    } finally {
      await fixture.cleanup(inspection);
      if (raw) {
        await disposePluginRegistryInstances(raw);
      }
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
        expect(connection.instanceDisposals).toBe(0);
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
        expect(connection.instanceDisposals).toBe(1);
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
      const failed = createInspectionFixture({
        registration: "throw",
        disposalFailure: true,
        capturedInstanceDisposal: true,
      });
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
        expect(failed.connection().instanceDisposals).toBe(1);
        expect(successful.connection().disposals).toBe(1);
        expect(successful.connection().instanceDisposals).toBe(1);
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
      expect(fixture.connection().instanceDisposals).toBe(1);
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
        expect(fixture.connection().instanceDisposals).toBe(0);
        expect(sibling.connection().instanceDisposals).toBe(0);
        fixture.state.resume.resolve();
        await release;
        expect(fixture.state.lateRead).toBe(42);
        expect(fixture.state.sibling.result).toBe(42);
        if (registration === "thenable") {
          expect(fixture.state.thenCalls).toBe(1);
        }
        expect(sibling.connection().database.isOpen).toBe(false);
        expect(fixture.connection().disposals).toBe(1);
        expect(fixture.connection().instanceDisposals).toBe(1);
        expect(sibling.connection().instanceDisposals).toBe(1);
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
