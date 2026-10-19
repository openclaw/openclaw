import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { expect, it, vi } from "vitest";
import { createModelRuntimeChoiceOwnerFixture } from "../agents/model-runtime-choice.test-support.js";
import { scopePreparedModelRuntimeLease } from "../agents/prepared-model-runtime-generation-scope.js";
import { retainRuntimePluginWork } from "../agents/runtime-plugin-work.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getPluginInstance } from "../plugins/plugin-instance-scope.js";
import type { PluginInstanceConsumer } from "../plugins/plugin-instance.types.js";
import { createDeferredCore } from "../shared/deferred.js";
import type { GatewayRequestHandlerOptions } from "./server-methods/types.js";
import {
  reloadFailure,
  firstReloaded,
  observeSettlement,
} from "./server-plugin-reload.fixture-tools.test-support.js";
import {
  expectSiblingUnchanged,
  observeRetainedWork,
  type RecoveryFixtureFactory,
} from "./server-plugin-reload.recovery.test-support.js";

type RecoveryFixture = Awaited<ReturnType<RecoveryFixtureFactory>>;

async function readResource(fixture: RecoveryFixture) {
  const method = "first.resource";
  const handler = fixture.registryOwner.registry.gatewayHandlers[method];
  assert(handler);
  const respond = vi.fn();
  await handler({
    req: { type: "req", id: "resource-reload", method },
    params: {},
    client: null,
    isWebchatConnect: () => false,
    respond,
    context: {} as GatewayRequestHandlerOptions["context"],
  });
  expect(respond).toHaveBeenCalledOnce();
  return respond.mock.calls[0]?.[1];
}

function resourceConfig(mode: string): OpenClawConfig {
  return { plugins: { allow: ["first", "sibling"], entries: { first: { config: { mode } } } } };
}

export async function verifySharedResourceReplacement(
  createFixture: RecoveryFixtureFactory,
  cleanup: "gateway_stop" | "runtime-lifecycle",
) {
  const events: string[] = [];
  let shared: { closed: boolean; mode: unknown } | undefined;
  const fixture = await createFixture({
    config: resourceConfig("old"),
    abortOnCandidateStart: false,
    registerFirst(api) {
      const mode = api.config.plugins?.entries?.first?.config?.mode;
      assert(typeof mode === "string");
      events.push(`register:${mode}`);
      const borrowed = shared;
      const resource = borrowed ?? { closed: false, mode };
      shared = resource;
      api.registerGatewayMethod("first.resource", ({ respond }) => {
        if (resource.closed) {
          throw new Error("shared connection was closed by the previous registration");
        }
        respond(true, { mode: resource.mode });
      });
      // Published Lossless similarly borrows the owner's engine and returns before
      // registering lifecycle hooks when the same database path is already open.
      if (borrowed) {
        return;
      }
      const close = () => {
        events.push(`stop:${mode}`);
        resource.closed = true;
        shared = undefined;
      };
      if (cleanup === "gateway_stop") {
        api.on("gateway_stop", close);
      } else {
        api.lifecycle.registerRuntimeLifecycle({
          id: "shared-resource",
          cleanup({ reason }) {
            if (reason === "restart" || reason === "disable") {
              close();
            }
          },
        });
      }
    },
  });
  const sibling = fixture.previousRegistry.plugins.find((record) => record.id === "sibling");
  expect(await readResource(fixture)).toEqual({ mode: "old" });

  await fixture.reload(resourceConfig("new"), ["first"], ["plugins.entries.first.config.mode"]);

  expect(await readResource(fixture)).toEqual({ mode: "new" });
  expect(events).toEqual(["register:old", "stop:old", "register:new"]);
  expect(fixture.registryOwner.registry.plugins.find((record) => record.id === "sibling")).toBe(
    sibling,
  );
  expectSiblingUnchanged(fixture);
}

export async function verifyCandidateResourceCleanup(createFixture: RecoveryFixtureFactory) {
  const resources: Array<{ closed: boolean; flushed: boolean }> = [];
  const fixture = await createFixture({
    abortOnCandidateStart: false,
    beforePublish: async () => {
      throw new Error("candidate publication refused");
    },
    registerFirst(api) {
      const resource = { closed: false, flushed: false };
      resources.push(resource);
      api.registerService({
        id: "resource-consumer",
        start() {},
        stop() {
          if (resource.closed) {
            throw new Error("cannot flush a closed connection");
          }
          resource.flushed = true;
        },
      });
      const close = () => {
        resource.closed = true;
      };
      api.on("gateway_stop", close);
      assert(api.lifecycle.onDispose);
      api.lifecycle.onDispose(close);
    },
  });

  await expect(fixture.reload()).rejects.toThrow("candidate publication refused");

  expect(resources).toEqual([
    { closed: true, flushed: true },
    { closed: true, flushed: true },
    { closed: false, flushed: false },
  ]);
  expect(fixture.firstStart).toHaveBeenCalledTimes(2);
  expectSiblingUnchanged(fixture);
}

async function verifySelfConsumerReload(
  createFixture: RecoveryFixtureFactory,
  caller:
    | "own invocation"
    | "between invocations"
    | "pending cleanup"
    | "final checkpoint"
    | "later replacement target",
) {
  const prepareConfigEffects = vi.fn(() => ({ retire: () => {}, rollback: async () => {} }));
  let checkpoints = 0;
  let consumer: PluginInstanceConsumer | undefined;
  const fixture = await createFixture({
    abortOnCandidateStart: false,
    prepareConfigEffects,
    checkpoint: async () => {
      if (++checkpoints <= 3) {
        expect(fixture.owner.getReloadStatus()).toBeUndefined();
      }
      if (checkpoints === 3 && caller === "final checkpoint") {
        assert(instance);
        consumer = instance.retainConsumer();
      }
    },
  });
  const pluginIds = caller === "later replacement target" ? ["first", "sibling"] : ["first"];
  const instance = fixture.instance(pluginIds.at(-1));
  const observation = observeRetainedWork(instance);
  if (caller !== "final checkpoint") {
    consumer = instance.retainConsumer();
  }
  const cleanup = createDeferredCore();
  const closing = caller === "pending cleanup" ? consumer?.close(() => cleanup.promise) : undefined;
  vi.useFakeTimers();
  try {
    const reloading = (
      caller === "own invocation" && consumer
        ? consumer.run(() => fixture.reload())
        : fixture.reload(undefined, pluginIds)
    ).catch((error: unknown) => error);
    // Observe the original bounded failure without releasing the work reload depends on.
    await Promise.race([observation.entered, reloading]);
    await vi.advanceTimersByTimeAsync(70_000);
    expect(await reloading).toMatchObject(
      reloadFailure(caller === "own invocation" ? "prepare" : "drain"),
    );
    expect(prepareConfigEffects).toHaveBeenCalledTimes(caller === "own invocation" ? 0 : 1);
    fixture.expectServices({ firstStop: 0, siblingStop: 0 });
    expect(fixture.candidates).toHaveLength(0);
    expect(fixture.registryOwner.registry).toBe(fixture.previousRegistry);
    expect(instance.run(() => "still serving")).toBe("still serving");
    cleanup.resolve();
    await closing;
    assert(consumer);
    consumer.release();
    // A refusal leaves each previous instance available for ordinary work.
    for (const previous of fixture.previousRegistry.plugins) {
      getPluginInstance(previous)?.retainWork()();
    }
    await expect(fixture.reload(undefined, pluginIds)).resolves.toMatchObject({
      runtime: { pluginIds },
    });
  } finally {
    observation.restore();
    cleanup.resolve();
    await closing;
    consumer?.release();
    vi.useRealTimers();
  }
}

async function verifyOverlappingRetainedWork(createRecoveryFixture: RecoveryFixtureFactory) {
  const reserved = createDeferredCore();
  let registrations = 0;
  const disposed: number[] = [];
  const fixture = await createRecoveryFixture({
    abortOnCandidateStart: false,
    prepareConfigEffects: () => {
      reserved.resolve();
      return { retire: () => {}, rollback: async () => {} };
    },
    registerFirst(api) {
      const generation = ++registrations;
      api.lifecycle.onDispose?.(() => void disposed.push(generation));
    },
  });
  const old = fixture.previousRegistry;
  const instance = fixture.instance();
  const consumer = instance.retainConsumer();
  const observation = observeRetainedWork(instance, true);
  const first = retainRuntimePluginWork([old]);
  const second = retainRuntimePluginWork([old]);
  const reloading = fixture.reload();
  void reloading.catch(() => {});
  try {
    // A refusal is observed immediately instead of waiting for a fixture timeout.
    await Promise.race([reserved.promise, reloading]);
    expect(fixture.firstStop).not.toHaveBeenCalled();
    first();
    expect(instance.run(() => "old run finishes")).toBe("old run finishes");
    expect(fixture.candidates).toHaveLength(0);
    second();
    await Promise.race([observation.entered, reloading]);
    expect(disposed).toEqual([]);
    consumer.release();
    const receipt = await reloading;
    expect(receipt.runtime.pluginIds).toEqual(["first"]);
    expect(
      receipt.runtime.warnings?.filter((warning) => warning.includes("retained work")),
    ).toEqual([expect.stringMatching(/waited for.*retained work.*finish/)]);
    expect(disposed).toEqual([1]);
    const next = fixture.registryOwner.registry;
    expect(next).not.toBe(old);
    const release = retainRuntimePluginWork([next]);
    release();
    expect(registrations).toBe(2);
  } finally {
    first();
    second();
    consumer.release();
    observation.restore();
    await reloading.catch(() => {});
  }
}

async function verifyExplicitDrainWait(
  createFixture: RecoveryFixtureFactory,
  kind: "retained work" | "retained consumer" | "active call",
  outcome: "complete" | "cancel" | "time out",
) {
  const controller = new AbortController();
  const fixture = await createFixture({
    abortOnCandidateStart: false,
    waitForDrain: true,
    drainSignal: controller.signal,
  });
  const instance = fixture.instance();
  const released = createDeferredCore();
  const consumer = kind === "retained consumer" ? instance.retainConsumer() : undefined;
  const release =
    kind === "retained work"
      ? instance.retainWork()
      : consumer
        ? () => consumer.release()
        : () => released.resolve();
  const call = kind === "active call" ? instance.run(() => released.promise) : undefined;
  const observation = observeRetainedWork(instance);
  vi.useFakeTimers();
  const operation = observeSettlement(fixture.reload());
  const reloading = operation.result;
  try {
    await Promise.race([observation.entered, reloading]);
    expect(fixture.owner.getReloadStatus()).toMatchObject({
      deadlineAtMs: Date.now() + 600_000,
      reason: expect.stringContaining("600s drain budget"),
    });
    await vi.advanceTimersByTimeAsync(70_000);
    expect(operation.state.settled).toBe(false);
    expect(fixture.candidates).toHaveLength(0);
    expect(fixture.firstStop).not.toHaveBeenCalled();
    expect(instance.disposing).toBe(false);
    if (outcome !== "complete") {
      if (outcome === "cancel") {
        controller.abort(new Error("operator cancelled reload"));
        await vi.advanceTimersByTimeAsync(0);
      } else {
        await vi.advanceTimersByTimeAsync(530_000);
      }
      expect(operation.state.settled).toBe(true);
      expect(await reloading).toMatchObject(reloadFailure("drain"));
      if (outcome === "time out") {
        expect(await reloading).toMatchObject({
          cause: { message: expect.stringContaining("admitted work did not settle within 600s") },
        });
      }
      expect(fixture.registryOwner.registry).toBe(fixture.previousRegistry);
      expect(instance.run(() => "still serving")).toBe("still serving");
      expect(instance.disposing).toBe(false);
      instance.retainWork()();
      expect(fixture.firstStop).not.toHaveBeenCalled();
      expect(fixture.rollbackConfigEffects).toHaveBeenCalledOnce();
    } else {
      release();
      await call;
      expect(await reloading).toMatchObject(firstReloaded);
      expect(fixture.registryOwner.registry).not.toBe(fixture.previousRegistry);
      expect(fixture.candidates).toHaveLength(1);
      expect(instance.disposing).toBe(true);
    }
    expect(fixture.owner.getReloadStatus()).toBeUndefined();
    expectSiblingUnchanged(fixture);
  } finally {
    release();
    released.resolve();
    await call;
    await reloading;
    observation.restore();
    vi.useRealTimers();
  }
}

export function registerPluginRetainedWorkReloadTests(
  createRecoveryFixture: RecoveryFixtureFactory,
) {
  it("refuses a live borrowed turn before effects and permits its closed context to reload", async () => {
    // #151706: the requesting turn holds the plugin even between its callbacks.
    let allowEffects = false;
    const prepareConfigEffects = vi.fn(() => {
      if (!allowEffects) {
        throw new Error("Self-reload reached config effects");
      }
      return { retire: () => {}, rollback: async () => {} };
    });
    const fixture = await createRecoveryFixture({
      abortOnCandidateStart: false,
      prepareConfigEffects,
    });
    const registry = fixture.previousRegistry;
    const instance = fixture.instance();
    const snapshot = createModelRuntimeChoiceOwnerFixture({}, () => true, {
      pluginRegistry: registry,
    });
    const releaseWork = retainRuntimePluginWork([registry]);
    const lease = scopePreparedModelRuntimeLease({
      snapshot,
      pluginGeneration: {
        pluginRegistry: registry,
        pluginMetadataSnapshot: snapshot.metadataSnapshot,
        remoteCatalog: null,
        inlineProviderModels: [],
        configuredCatalogEntries: [],
      },
      [Symbol.asyncDispose]: async () => releaseWork(),
    });
    const runInTurn = lease.run(() => AsyncLocalStorage.snapshot());
    try {
      expect(runInTurn(() => instance.hasActiveCall)).toBe(false);
      await expect(runInTurn(() => fixture.reload())).rejects.toThrow("own active turn");
      expect(prepareConfigEffects).not.toHaveBeenCalled();
      fixture.expectServices({ firstStop: 0, siblingStop: 0 });
      expect(fixture.registryOwner.registry).toBe(registry);
      expect(instance.run(() => "still serving")).toBe("still serving");

      await lease[Symbol.asyncDispose]();
      allowEffects = true;
      await expect(runInTurn(() => fixture.reload())).resolves.toMatchObject(firstReloaded);
    } finally {
      await lease[Symbol.asyncDispose]();
    }
  });
  it.each([
    ["retained work", "complete"],
    ["retained work", "cancel"],
    ["retained work", "time out"],
    ["retained consumer", "complete"],
    ["retained consumer", "cancel"],
    ["active call", "complete"],
    ["active call", "cancel"],
    ["active call", "time out"],
  ] as const)("explicit drain wait preserves %s beyond 60s and can %s", (kind, outcome) =>
    verifyExplicitDrainWait(createRecoveryFixture, kind, outcome),
  );
  it.each(["before publication", "after publication"] as const)(
    "explicit drain cancellation preserves recovery ownership %s",
    async (boundary) => {
      const controller = new AbortController();
      const cancel = () => controller.abort(new Error("operator cancelled reload"));
      const fixture = await createRecoveryFixture({
        abortOnCandidateStart: false,
        waitForDrain: true,
        drainSignal: controller.signal,
        ...(boundary === "before publication"
          ? { candidateStart: cancel }
          : { afterPublish: async () => cancel() }),
      });
      if (boundary === "before publication") {
        await expect(fixture.reload()).rejects.toMatchObject({ details: { committed: false } });
        expect(fixture.firstStart).toHaveBeenCalledTimes(2);
        expect(fixture.rollbackConfigEffects).toHaveBeenCalledOnce();
      } else {
        await expect(fixture.reload()).resolves.toMatchObject(firstReloaded);
        expect(fixture.firstStart).toHaveBeenCalledOnce();
        expect(fixture.rollbackConfigEffects).not.toHaveBeenCalled();
      }
      const current = getPluginInstance(fixture.registryOwner.registry.plugins[0]!);
      assert(current);
      expect(current.run(() => "serving")).toBe("serving");
      expect(fixture.owner.getReloadStatus()).toBeUndefined();
      expect(fixture.siblingStop).not.toHaveBeenCalled();
    },
  );
  it("admits replacement while overlapping agent work drains on its original generation", () =>
    verifyOverlappingRetainedWork(createRecoveryFixture));
  it.each([
    "own invocation",
    "between invocations",
    "pending cleanup",
    "final checkpoint",
    "later replacement target",
  ] as const)("preserves serving resources when retained work cannot finish during %s", (caller) =>
    verifySelfConsumerReload(createRecoveryFixture, caller),
  );
}
