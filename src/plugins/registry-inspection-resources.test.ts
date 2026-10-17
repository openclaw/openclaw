import { AsyncLocalStorage } from "node:async_hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  acquirePluginRegistryForInspection as acquireInspection,
  loadPluginRegistryHandle,
} from "./loader.js";
import { resetPluginLoaderTestStateForTest } from "./loader.test-fixtures.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import {
  getPluginRegistryInspectionResources as resourcesFor,
  PluginRegistryInspectionResources,
} from "./registry-inspection-resources.js";
import {
  acquireFixtureInspection,
  createInspectionFixture,
} from "./registry-inspection.test-helpers.js";
import * as lifecycle from "./registry-lifecycle.js";
import type { PluginRegistry } from "./registry-types.js";
import * as runtime from "./runtime.js";

type Inspection = Awaited<ReturnType<typeof acquireInspection>>;
type Fixture = ReturnType<typeof createInspectionFixture>;

async function inspectFixtures(
  fixtures: Fixture[],
  run: (inspection: Inspection, retain: () => { release: () => Promise<void> }) => Promise<void>,
  cleanupOrder = fixtures,
) {
  let inspection: Inspection | undefined;
  let borrowed: { release: () => Promise<void> } | undefined;
  try {
    inspection = await acquireFixtureInspection(fixtures);
    await run(inspection, () => (borrowed = resourcesFor(inspection!.registry)!.retain()));
  } finally {
    await cleanupOrder[0]!.cleanup(inspection, borrowed);
    for (const fixture of cleanupOrder.slice(1)) {
      await fixture.cleanup();
    }
  }
}

function readFixture(fixture: Fixture) {
  return fixture.connection().database.prepare("SELECT 42 AS value").get();
}

function scopedSignal(registry: PluginRegistry) {
  return lifecycle.capturePluginRegistryLifecycleSignal(registry, undefined, {
    scopedRuntime: true,
  })!;
}

function scopedAuthority(registry: PluginRegistry) {
  return lifecycle.capturePluginLifecycleAuthority(registry, undefined, { scopedRuntime: true })!;
}

function trackSiblingRead(source: Fixture, sibling: Fixture) {
  const handedOff = createDeferredCore();
  let work: Promise<void> | undefined;
  let reads: unknown;
  source.state.sibling.read = () => {
    work = sibling.state.captured.tracker!(async () => {
      await readFile(sibling.plugin.file);
      reads = { source: readFixture(source)?.value, sibling: readFixture(sibling)?.value };
    });
    void work.catch(() => undefined);
    handedOff.resolve();
  };
  return {
    handedOff: handedOff.promise,
    settle: () => work?.catch(() => undefined),
    async expectRead() {
      await expect(work).resolves.toBeUndefined();
      expect(reads).toEqual({ source: 42, sibling: 42 });
    },
  };
}

function disposalError(fixture: Fixture) {
  return expect.objectContaining({
    message: `Plugin inspection disposal failed: ${fixture.plugin.id}:native-resource`,
  });
}

function disposalFault(fixture: Fixture) {
  return { errors: [disposalError(fixture)] };
}

function settlement<T extends object>(promise: Promise<unknown>, tag: T) {
  return promise.then(
    () => ({ ...tag, error: undefined }),
    (error: unknown) => ({ ...tag, error }),
  );
}

function expectConnection(
  fixture: Fixture,
  expected: Partial<{
    disposals: number;
    cleanups: number;
    instanceDisposals: number;
    open: boolean;
  }>,
) {
  const { database, ...counts } = fixture.connection();
  expect({ ...counts, open: database.isOpen }).toMatchObject(expected);
}

function expectDisposed(fixture: Fixture) {
  expectConnection(fixture, { disposals: 1, open: false, cleanups: 0 });
}

afterEach(() => runtime.resetPluginRuntimeStateForTest());
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
    await inspectFixtures([fixture], async (inspection, retain) => {
      const primary = inspection.registry;
      const copy = { ...primary };
      const resources = resourcesFor(primary)!;
      resources.attach(copy);
      const borrowed = retain();
      const views = [primary, copy];
      const authorities = views.map(scopedAuthority);
      const signals = views.map(scopedSignal);
      const keys = ["owned-primary", "owned-copy"];
      const pluginLoaderCacheState = lifecycle.getPluginLoaderCacheState();
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
      const captured = fixture.state.captured;
      const caller = new AsyncWorkScope();
      const closer = new AsyncWorkScope();
      const releaseInScope = closer.run(() => AsyncLocalStorage.snapshot());
      let inspection: Inspection | undefined;
      let borrowed: { release: () => Promise<void> } | undefined;
      try {
        inspection = await caller.track(() => acquireInspection({ config: fixture.config }));
        borrowed = resourcesFor(inspection.registry)!.retain();
        const authority = scopedAuthority(inspection.registry);
        await inspection.release();
        await caller.drain();
        expect(caller.signal.aborted).toBe(true);
        expect(authority()).toBe(false);
        expect(readFixture(fixture)).toEqual({
          value: 42,
        });
        const registrationSignalAborted = captured.registrationSignal?.aborted;
        if (closedReleaseScope) {
          await closer.drain();
        }
        const released = settlement(
          closedReleaseScope
            ? releaseInScope(() => borrowed!.release())
            : closer.track(() => borrowed!.release()),
          { phase: "released" },
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
        expect(captured.registrationSignal).not.toBe(caller.signal);
        expect(captured.disposalSignal).toBe(captured.registrationSignal);
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
        expect(captured.read).toEqual({ value: 42 });
        expect(fixture.connection().instanceDisposals).toBe(1);
        if (capturedInstanceDisposal) {
          expect(captured.instanceSignal).toBe(captured.registrationSignal);
        }
        expectDisposed(fixture);
      } finally {
        await fixture.cleanup(inspection, borrowed);
        await Promise.all([caller.drain(), closer.drain()]);
      }
    },
  );

  it("releases an uncached inspection without disposing or changing the raw loader value", async () => {
    const fixture = createInspectionFixture({ pauseDisposal: true });
    const active = createEmptyPluginRegistry();
    runtime.setActivePluginRegistry(active);
    let inspection: Inspection | undefined;
    let raw: PluginRegistry | undefined;
    try {
      raw = loadPluginRegistryHandle({ config: fixture.config });
      inspection = await acquireInspection({ config: fixture.config });
      expect(raw.plugins[0]?.id).toBe(fixture.plugin.id);
      expect(inspection.registry).not.toBe(raw);
      expect(runtime.getActivePluginRegistry()).toBe(active);
      expect(fixture.state.connections).toHaveLength(2);
      expect(process.listenerCount(fixture.event)).toBe(2);
      const legacy = fixture.connection();
      const owned = fixture.connection(1);
      expect(owned.database.prepare("SELECT 42 AS value").get()).toEqual({ value: 42 });
      const signal = scopedSignal(inspection.registry);
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
      expect(owned).toMatchObject({ disposals: 1, instanceDisposals: 1 });
      expect(process.listenerCount(fixture.event)).toBe(1);
      expect(owned.database.isOpen).toBe(false);
      expect(legacy.database.prepare("SELECT 42 AS value").get()).toEqual({ value: 42 });
      expect(legacy).toMatchObject({ disposals: 0, cleanups: 0, instanceDisposals: 0 });
      expect(loadPluginRegistryHandle({ config: fixture.config })).toBe(raw);
      expect(runtime.getActivePluginRegistry()).toBe(active);
    } finally {
      await fixture.cleanup(inspection);
      if (raw) {
        await runtime.disposePluginRegistryInstances(raw);
      }
    }
  });

  it.each([false, true])(
    "revokes a released inspection while retaining its native resources (disposal failure: %s)",
    async (disposalFailure) => {
      const fixture = createInspectionFixture({ pauseDisposal: true, disposalFailure });
      const active = createEmptyPluginRegistry();
      runtime.setActivePluginRegistry(active);
      const activeEpoch = lifecycle.capturePluginRegistryLifecycleEpoch(active);
      await inspectFixtures([fixture], async (inspection, retain) => {
        const resources = resourcesFor(inspection.registry)!;
        const borrowed = retain();
        const signal = scopedSignal(inspection.registry);
        const authority = scopedAuthority(inspection.registry);
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
        expect(connection).toMatchObject({ disposals: 0, instanceDisposals: 0 });
        expect(connection.database.prepare("SELECT 42 AS value").get()).toEqual({ value: 42 });
        expect(runtime.getActivePluginRegistry()).toBe(active);
        expect(lifecycle.capturePluginRegistryLifecycleEpoch(active)).toBe(activeEpoch);
        const finalRelease = borrowed.release();
        expect(borrowed.release()).toBe(finalRelease);
        const settled = disposalFailure
          ? expect(finalRelease).rejects.toMatchObject(disposalFault(fixture))
          : expect(finalRelease).resolves.toBeUndefined();
        await fixture.state.disposalStarted.promise;
        expect(connection.database.isOpen).toBe(true);
        fixture.state.finishDisposal.resolve();
        await settled;
        expect(connection).toMatchObject({ disposals: 1, instanceDisposals: 1 });
        expect(connection.database.isOpen).toBe(false);
        expect(connection.cleanups).toBe(0);
        expect(signal.aborted).toBe(true);
        expect(authority()).toBe(false);
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
      await inspectFixtures([failed, successful], async (inspection, retain) => {
        let borrowed: { release: () => Promise<void> } | undefined;
        if (retainSibling) {
          borrowed = retain();
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
        const invocations = resourcesFor(inspection.registry)!.createInvocationScope(
          inspection.registry,
        );
        try {
          expect(invocations.run(() => readFixture(successful))).toEqual({ value: 42 });
        } finally {
          invocations.release();
        }
        await expect(inspection.release()).rejects.toMatchObject(disposalFault(failed));
        if (borrowed) {
          expect(successful.connection().disposals).toBe(0);
          expect(readFixture(successful)).toEqual({
            value: 42,
          });
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
      await inspectFixtures([fixture], async (inspection, retain) => {
        const borrowed = retain();
        const signal = scopedSignal(inspection.registry);
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
        const inspectionOutcome = settlement(inspectionRelease, { owner: "inspection" });
        const borrowerOutcome = settlement(borrowedRelease!, { owner: "borrower" });
        await fixture.state.disposalStarted.promise;
        expect(fixture.connection().database.isOpen).toBe(true);
        expect(await Promise.race([inspectionOutcome, borrowerOutcome])).toEqual({
          owner: "inspection",
          error: undefined,
        });
        fixture.state.finishDisposal.resolve();
        expect(await borrowerOutcome).toMatchObject({
          owner: "borrower",
          error: disposalFault(fixture),
        });
        expectDisposed(fixture);
      });
    },
  );

  it("finishes construction rollback before rejecting an inspection", async () => {
    const fixture = createInspectionFixture({ registration: "throw" });
    try {
      await expect(
        acquireInspection({ config: fixture.config, throwOnLoadError: true }),
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
      let inspection: Inspection | undefined;
      try {
        inspection = await acquireFixtureInspection(fixtures);
        expect(inspection.registry.plugins.map((plugin) => plugin.id)).toEqual(
          fixtures.map((fixture) => fixture.plugin.id),
        );
        const release = inspection.release();
        const rejected = expect(release).rejects.toMatchObject({
          errors: fixtures.map((fixture) => disposalError(fixture)),
        });
        // Neither paused disposer may prevent its sibling from starting.
        await Promise.all(fixtures.map((fixture) => fixture.state.disposalStarted.promise));
        for (const fixture of fixtures) {
          expect(fixture.connection().database.isOpen).toBe(true);
          fixture.state.finishDisposal.resolve();
        }
        await rejected;
        for (const fixture of fixtures) {
          expectDisposed(fixture);
        }
      } finally {
        for (const fixture of fixtures) {
          fixture.state.finishDisposal.resolve();
        }
        await Promise.all(fixtures.map((fixture) => fixture.cleanup(inspection)));
      }
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
      fixture.state.sibling.read = () => readFixture(sibling)?.value;
      await inspectFixtures(
        [sibling, fixture],
        async (inspection, retain) => {
          const borrowed = retainSibling ? retain() : undefined;
          const record = inspection.registry.plugins.find(
            (entry) => entry.id === fixture.plugin.id,
          );
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
          expectConnection(sibling, { instanceDisposals: 0 });
          fixture.state.resume.resolve();
          await release;
          expect(fixture.state).toMatchObject({ lateRead: 42, sibling: { result: 42 } });
          if (registration === "thenable") {
            expect(fixture.state.thenCalls).toBe(1);
          }
          expectConnection(fixture, { disposals: 1, instanceDisposals: 1, open: false });
          expectConnection(sibling, {
            instanceDisposals: retainSibling ? 0 : 1,
            open: retainSibling,
          });
          if (borrowed) {
            expectConnection(sibling, { disposals: 0 });
            expect(readFixture(sibling)).toEqual({ value: 42 });
            await borrowed.release();
            expectConnection(sibling, { disposals: 1, open: false });
          }
        },
        [fixture, sibling],
      );
    },
  );

  it("joins queued registration-signal cleanup before disposing native resources", async () => {
    const fixture = createInspectionFixture({ queuedAbortCleanup: true });
    await inspectFixtures([fixture], async (inspection) => {
      await inspection.release();
      await expect(fixture.state.captured.abortCleanup).resolves.toBeUndefined();
      expect(fixture.state.captured.abortRead).toEqual({ value: 42 });
      expectDisposed(fixture);
    });
  });

  it("joins invalid registration work before releasing an inspection with a retained sibling", async () => {
    const sibling = createInspectionFixture();
    const fixture = createInspectionFixture({ registration: "async-reject" });
    fixture.state.sibling.read = () => readFixture(sibling)?.value;
    let inspection: Inspection | undefined;
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
      expect(readFixture(sibling)).toEqual({
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
      expectDisposed(fixture);
    } finally {
      fixture.state.finishDisposal.resolve();
      await warnings?.catch(() => undefined);
      await fixture.cleanup();
    }
  });
});
