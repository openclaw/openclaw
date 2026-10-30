import { AsyncLocalStorage } from "node:async_hooks";
import { afterEach, describe, expect, it } from "vitest";
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
  PluginRuntimeCloseCompletedError,
  PluginRuntimeCloseRetainedError,
} from "./runtime-close-error.js";
import {
  disposePluginRegistryInstances,
  getActivePluginRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "./runtime.js";

afterEach(() => resetPluginRuntimeStateForTest());
afterEach(resetPluginLoaderTestStateForTest);

type InspectionFixture = ReturnType<typeof createInspectionFixture>;
type Inspection = Awaited<ReturnType<typeof acquirePluginRegistryForInspection>>;

async function withInspection(
  fixtures: InspectionFixture[],
  run: (inspection: Inspection, retain: () => { release: () => Promise<void> }) => Promise<void>,
  acquire = () => acquireFixtureInspection(fixtures),
) {
  let inspection: Inspection | undefined;
  let borrowed: { release: () => Promise<void> } | undefined;
  try {
    inspection = await acquire();
    const resources = getPluginRegistryInspectionResources(inspection.registry)!;
    await run(inspection, () => (borrowed = resources.retain()));
  } finally {
    for (const fixture of fixtures) {
      fixture.state.resume.resolve();
      fixture.state.finishDisposal.resolve();
    }
    await fixtures[0]!.cleanup(inspection, borrowed);
    for (const fixture of fixtures.slice(1)) {
      await fixture.cleanup();
    }
  }
}

const scopedRuntime = { scopedRuntime: true };
function signalFor(registry: PluginRegistry) {
  return capturePluginRegistryLifecycleSignal(registry, undefined, scopedRuntime)!;
}
function authorityFor(registry: PluginRegistry) {
  return capturePluginLifecycleAuthority(registry, undefined, scopedRuntime)!;
}

function expectConnection(
  fixture: InspectionFixture,
  expected: Partial<ReturnType<InspectionFixture["connection"]>> & { open?: boolean },
) {
  const { open, ...fields } = expected;
  expect(fixture.connection()).toMatchObject(fields);
  if (open !== undefined) {
    expect(fixture.connection().database.isOpen).toBe(open);
  }
}

function readConnection(fixture: InspectionFixture) {
  return fixture.connection().database.prepare("SELECT 42 AS value").get();
}

function settled(promise: Promise<unknown>, phase: string) {
  return promise.then(
    () => ({ phase, error: undefined }),
    (error: unknown) => ({ phase, error }),
  );
}

function expectDisposed(fixture: InspectionFixture) {
  expectConnection(fixture, { disposals: 1, instanceDisposals: 1, open: false, cleanups: 0 });
}

function disposalError(fixture: InspectionFixture, cause = false) {
  return {
    errors: [
      expect.objectContaining({
        message: `Plugin inspection disposal failed: ${fixture.plugin.id}:native-resource`,
        ...(cause
          ? { cause: expect.objectContaining({ message: "fixture disposal failed" }) }
          : {}),
      }),
    ],
  };
}

describe("owned plugin inspections", () => {
  it.each([false, true])("preserves frozen disposal errors (retained: %s)", async (retained) => {
    const failure = retained
      ? new PluginRuntimeCloseRetainedError(new Error("Unfinished disposal"))
      : new Error("Completed disposal failed");
    Object.freeze(failure);
    const resources = new PluginRegistryInspectionResources(async () => {
      throw failure;
    });
    const outcome = await resources.release().catch((error: unknown) => error);
    expect(outcome).toBeInstanceOf(AggregateError);
    expect(outcome instanceof PluginRuntimeCloseCompletedError).toBe(!retained);
    expect(outcome).toMatchObject({ errors: [failure] });
  });

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
      const outcome = release.catch((error: unknown) => error);
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
    await withInspection([fixture], async (inspection, retain) => {
      const primary = inspection.registry;
      const copy = { ...primary };
      const resources = getPluginRegistryInspectionResources(primary)!;
      resources.attach(copy);
      const borrowed = retain();
      const views = [primary, copy];
      const authorities = views.map(authorityFor);
      const signals = views.map(signalFor);
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
          reentrant.push(inspection.release());
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
      expectConnection(fixture, { disposals: 0, open: true });
      await borrowed.release();
      expectConnection(fixture, { disposals: 1, open: false });
    });
  });

  it.each(
    (
      [
        ["async-context", false, false],
        ["work-tracker", true, false],
        ["work-tracker", false, true],
      ] as const
    ).flatMap(([capturedDisposal, disposalFailure, capturedInstanceDisposal]) =>
      [false, true].map((closedReleaseScope) => ({
        capturedDisposal,
        disposalFailure,
        capturedInstanceDisposal,
        closedReleaseScope,
      })),
    ),
  )(
    "keeps registration cleanup captured by $capturedDisposal after its caller closes (instance: $capturedInstanceDisposal, closed release scope: $closedReleaseScope)",
    async ({ capturedDisposal, disposalFailure, capturedInstanceDisposal, closedReleaseScope }) => {
      const fixture = createInspectionFixture({
        capturedDisposal,
        disposalFailure,
        capturedInstanceDisposal,
        pauseDisposal: true,
      });
      const caller = new AsyncWorkScope();
      const closer = new AsyncWorkScope();
      const releaseInScope = closer.run(() => AsyncLocalStorage.snapshot());
      try {
        await withInspection(
          [fixture],
          async (inspection, retain) => {
            const borrowed = retain();
            const authority = authorityFor(inspection.registry);
            await inspection.release();
            await caller.drain();
            expect(caller.signal.aborted).toBe(true);
            expect(authority()).toBe(false);
            expect(readConnection(fixture)).toEqual({ value: 42 });
            const registrationSignalAborted = fixture.state.captured.registrationSignal?.aborted;
            if (closedReleaseScope) {
              await closer.drain();
            }
            const released = settled(
              closedReleaseScope
                ? releaseInScope(() => borrowed.release())
                : closer.track(() => borrowed.release()),
              "released",
            );
            expect(
              await Promise.race([
                settled(fixture.state.disposalStarted.promise, "disposing"),
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
              expect(outcome.error).toMatchObject(disposalError(fixture, true));
            } else {
              expect(outcome.error).toBeUndefined();
            }
            expect(fixture.state.captured.read).toEqual({ value: 42 });
            if (capturedInstanceDisposal) {
              expect(fixture.state.captured.instanceSignal).toBe(
                fixture.state.captured.registrationSignal,
              );
            }
            expectDisposed(fixture);
          },
          () => caller.track(() => acquirePluginRegistryForInspection({ config: fixture.config })),
        );
      } finally {
        await Promise.all([caller.drain(), closer.drain()]);
      }
    },
  );

  it("releases an uncached inspection without disposing or changing the raw loader value", async () => {
    const fixture = createInspectionFixture({ pauseDisposal: true });
    const active = createEmptyPluginRegistry();
    setActivePluginRegistry(active);
    let inspection: Inspection | undefined;
    let raw: PluginRegistry | undefined;
    try {
      raw = loadPluginRegistryHandle({ config: fixture.config });
      inspection = await acquirePluginRegistryForInspection({ config: fixture.config });
      expect(inspection.registry).not.toBe(raw);
      expect(getActivePluginRegistry()).toBe(active);
      expect(fixture.state.connections).toHaveLength(2);
      expect(process.listenerCount(fixture.event)).toBe(2);
      const legacy = fixture.connection();
      const owned = fixture.connection(1);
      expect(owned.database.prepare("SELECT 42 AS value").get()).toEqual({ value: 42 });
      const release = inspection.release();
      await fixture.state.disposalStarted.promise;
      expect(owned.database.isOpen).toBe(true);
      fixture.state.finishDisposal.resolve();
      await release;
      expect(owned).toMatchObject({ disposals: 1, instanceDisposals: 1 });
      expect(process.listenerCount(fixture.event)).toBe(1);
      expect(owned.database.isOpen).toBe(false);
      expect(legacy.database.prepare("SELECT 42 AS value").get()).toEqual({ value: 42 });
      expect(legacy).toMatchObject({ disposals: 0, cleanups: 0, instanceDisposals: 0 });
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
      await withInspection([fixture], async (inspection, retain) => {
        const resources = getPluginRegistryInspectionResources(inspection.registry)!;
        const borrowed = retain();
        const signal = signalFor(inspection.registry);
        const authority = authorityFor(inspection.registry);
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
        expectConnection(fixture, { disposals: 0, instanceDisposals: 0 });
        expect(readConnection(fixture)).toEqual({ value: 42 });
        expect(getActivePluginRegistry()).toBe(active);
        expect(capturePluginRegistryLifecycleEpoch(active)).toBe(activeEpoch);

        const finalRelease = borrowed.release();
        expect(borrowed.release()).toBe(finalRelease);
        const finalCheck = disposalFailure
          ? expect(finalRelease).rejects.toMatchObject(disposalError(fixture))
          : expect(finalRelease).resolves.toBeUndefined();
        await fixture.state.disposalStarted.promise;
        expect(fixture.connection().database.isOpen).toBe(true);
        fixture.state.finishDisposal.resolve();
        await finalCheck;
        expectDisposed(fixture);
      });
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
      await withInspection([failed, successful], async (inspection, retain) => {
        const borrowed = retainSibling ? retain() : undefined;
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
        const invocations = getPluginRegistryInspectionResources(
          inspection.registry,
        )!.createInvocationScope(inspection.registry);
        try {
          expect(
            invocations.run(() =>
              successful.connection().database.prepare("SELECT 42 AS value").get(),
            ),
          ).toEqual({ value: 42 });
        } finally {
          invocations.release();
        }
        await expect(inspection.release()).rejects.toMatchObject(disposalError(failed));
        if (borrowed) {
          expect(successful.connection().disposals).toBe(0);
          expect(readConnection(successful)).toEqual({ value: 42 });
          await expect(borrowed.release()).resolves.toBeUndefined();
        }
        expectConnection(failed, { disposals: 1, instanceDisposals: 1 });
        expectConnection(successful, { disposals: 1, instanceDisposals: 1, open: false });
      });
    },
  );

  it.each(["same-turn", "abort-listener"] as const)(
    "assigns final disposal to the borrower released after the inspection (%s)",
    async (timing) => {
      const fixture = createInspectionFixture({ pauseDisposal: true, disposalFailure: true });
      await withInspection([fixture], async (inspection, retain) => {
        const borrowed = retain();
        const signal = signalFor(inspection.registry);
        let borrowedRelease: Promise<void> | undefined;
        if (timing === "abort-listener") {
          signal.addEventListener("abort", () => {
            borrowedRelease = borrowed.release();
          });
        }
        const inspectionRelease = inspection.release();
        if (timing === "same-turn") {
          borrowedRelease = borrowed.release();
        }
        expect(signal.aborted).toBe(true);
        expect(borrowedRelease).toBeDefined();
        const inspectionOutcome = settled(inspectionRelease, "inspection");
        const borrowerOutcome = settled(borrowedRelease!, "borrower");
        await fixture.state.disposalStarted.promise;
        expect(fixture.connection().database.isOpen).toBe(true);
        expect(await Promise.race([inspectionOutcome, borrowerOutcome])).toEqual({
          phase: "inspection",
          error: undefined,
        });
        fixture.state.finishDisposal.resolve();
        expect(await borrowerOutcome).toMatchObject({
          phase: "borrower",
          error: disposalError(fixture),
        });
        expectConnection(fixture, { disposals: 1, open: false, cleanups: 0 });
      });
    },
  );

  it("finishes construction rollback before rejecting an inspection", async () => {
    const fixture = createInspectionFixture({ registration: "throw" });
    try {
      await expect(
        acquirePluginRegistryForInspection({ config: fixture.config, throwOnLoadError: true }),
      ).rejects.toThrow();
      expect(fixture.state.connections).toHaveLength(1);
      expectConnection(fixture, { open: false, disposals: 1, instanceDisposals: 1 });
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
      await withInspection(fixtures, async (inspection) => {
        const release = inspection.release();
        const rejected = expect(release).rejects.toMatchObject({
          errors: fixtures.flatMap((fixture) => disposalError(fixture).errors),
        });
        // Neither paused disposer may prevent its sibling from starting.
        await Promise.all(fixtures.map((fixture) => fixture.state.disposalStarted.promise));
        for (const fixture of fixtures) {
          expect(fixture.connection().database.isOpen).toBe(true);
          fixture.state.finishDisposal.resolve();
        }
        await rejected;
        for (const fixture of fixtures) {
          expectConnection(fixture, { disposals: 1, open: false, cleanups: 0 });
        }
      });
    },
  );

  it.each([
    ["async-resolve", false],
    ["async-reject", false],
    ["thenable", false],
    ["tracked", false],
    ["async-reject", true],
  ] as const)(
    "waits for actual registration work before disposal (%s, retained sibling: %s)",
    async (registration, retainSibling) => {
      const sibling = createInspectionFixture();
      const fixture = createInspectionFixture({ registration });
      fixture.state.sibling.read = () =>
        sibling.connection().database.prepare("SELECT 42 AS value").get()?.value;
      await withInspection([sibling, fixture], async (inspection, retain) => {
        const borrowed = retainSibling ? retain() : undefined;
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
        expectConnection(fixture, { disposals: 0, instanceDisposals: 0 });
        expect(sibling.connection().instanceDisposals).toBe(0);
        fixture.state.resume.resolve();
        await release;
        expect(fixture.state.lateRead).toBe(42);
        expect(fixture.state.sibling.result).toBe(42);
        if (registration === "thenable") {
          expect(fixture.state.thenCalls).toBe(1);
        }
        expectConnection(fixture, { disposals: 1, instanceDisposals: 1, open: false });
        if (borrowed) {
          expect(sibling.connection().disposals).toBe(0);
          expect(readConnection(sibling)).toEqual({ value: 42 });
          await borrowed.release();
        }
        expectConnection(sibling, { open: false, disposals: 1, instanceDisposals: 1 });
      });
    },
  );

  it("joins queued registration-signal cleanup before disposing native resources", async () => {
    const fixture = createInspectionFixture({ queuedAbortCleanup: true });
    await withInspection([fixture], async (inspection) => {
      await inspection.release();
      await expect(fixture.state.captured.abortCleanup).resolves.toBeUndefined();
      expect(fixture.state.captured.abortRead).toEqual({ value: 42 });
      expectConnection(fixture, { disposals: 1, open: false, cleanups: 0 });
    });
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
      await Promise.race([fixture.state.disposalStarted.promise, warnings]);
      expect(fixture.state.connections).toHaveLength(1);
      let completed = false;
      void warnings.then(() => {
        completed = true;
      });
      await Promise.resolve();
      expect(completed).toBe(false);
      expect(fixture.state.factoryCalls).toBe(0);
      fixture.state.finishDisposal.resolve();
      expect((await warnings).join("\n")).toContain("registered for read-only discovery");
      expectConnection(fixture, { disposals: 1, open: false, cleanups: 0 });
    } finally {
      fixture.state.finishDisposal.resolve();
      await warnings?.catch(() => undefined);
      await fixture.cleanup();
    }
  });
});
