import assert from "node:assert/strict";
import { expect, it, vi } from "vitest";
import { retainRuntimePluginWork } from "../agents/runtime-plugin-work.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getPluginInstance } from "../plugins/plugin-instance-scope.js";
import type { PluginInstanceConsumer } from "../plugins/plugin-instance.types.js";
import { createDeferredCore } from "../shared/deferred.js";
import type { GatewayRequestHandlerOptions } from "./server-methods/types.js";
import type { RecoveryFixtureFactory } from "./server-plugin-reload.recovery.test-support.js";

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
  return {
    plugins: {
      allow: ["first", "sibling"],
      entries: { first: { config: { mode } } },
    },
  };
}

export async function verifySharedResourceReplacement(
  createFixture: RecoveryFixtureFactory,
  cleanup: "gateway_stop" | "dispose",
) {
  const events: string[] = [];
  let shared: { closed: boolean; mode: unknown } | undefined;
  const fixture = await createFixture({
    config: resourceConfig("old"),
    abortOnCandidateStart: false,
    register(api, owner) {
      if (owner !== "first") {
        return;
      }
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
        assert(api.lifecycle.onDispose);
        api.lifecycle.onDispose(close);
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
  expect(fixture.siblingStart).toHaveBeenCalledOnce();
  expect(fixture.siblingStop).not.toHaveBeenCalled();
}

export async function verifyFreshRegistrationRecovery(
  createFixture: RecoveryFixtureFactory,
  failure: "registration" | "activation",
) {
  const events: string[] = [];
  const signals: AbortSignal[] = [];
  const fixture = await createFixture({
    config: resourceConfig("old"),
    abortOnCandidateStart: false,
    register(api, owner) {
      if (owner !== "first") {
        return;
      }
      const mode = api.config.plugins?.entries?.first?.config?.mode;
      assert(typeof mode === "string");
      const controller = new AbortController();
      signals.push(controller.signal);
      events.push(`register:${mode}`);
      assert(api.lifecycle.onDispose);
      api.lifecycle.onDispose(() => {
        controller.abort();
        events.push(`dispose:${mode}`);
      });
      if (mode === "bad" && failure === "registration") {
        throw new Error("candidate registration refused");
      }
      api.registerService({
        id: "non-restartable-resource",
        start() {
          // Like Visitor Access, this registration cannot restart after its
          // controller has been aborted; rollback must create a fresh owner.
          if (controller.signal.aborted) {
            throw new Error("cannot restart an aborted registration");
          }
          if (mode === "bad") {
            throw new Error("candidate activation refused");
          }
          events.push(`start:${mode}`);
        },
      });
      api.on("gateway_stop", () => {
        controller.abort();
        events.push(`stop:${mode}`);
      });
      api.registerGatewayMethod("first.resource", ({ respond }) => {
        if (controller.signal.aborted) {
          throw new Error("registration is stopped");
        }
        respond(true, { mode });
      });
    },
  });
  const sibling = fixture.previousRegistry.plugins.find((record) => record.id === "sibling");
  expect(await readResource(fixture)).toEqual({ mode: "old" });

  await expect(fixture.reload(resourceConfig("bad"))).rejects.toThrow(
    `candidate ${failure} refused`,
  );

  expect(await readResource(fixture)).toEqual({ mode: "old" });
  expect(fixture.getConfig()).toEqual(resourceConfig("old"));
  expect(events.filter((event) => event.startsWith("register:"))).toEqual([
    "register:old",
    "register:bad",
    "register:old",
  ]);
  expect(events.indexOf("stop:old")).toBeLessThan(events.indexOf("register:bad"));
  expect(events.indexOf("dispose:bad")).toBeLessThan(events.lastIndexOf("register:old"));
  expect(signals.map((signal) => signal.aborted)).toEqual([true, true, false]);
  expect(fixture.registryOwner.registry.plugins.find((record) => record.id === "sibling")).toBe(
    sibling,
  );
  expect(fixture.siblingStart).toHaveBeenCalledOnce();
  expect(fixture.siblingStop).not.toHaveBeenCalled();
}

export async function verifyCandidateResourceCleanup(createFixture: RecoveryFixtureFactory) {
  const resources: Array<{ closed: boolean; flushed: boolean }> = [];
  const fixture = await createFixture({
    abortOnCandidateStart: false,
    beforePublish: async () => {
      throw new Error("candidate publication refused");
    },
    register(api, owner) {
      if (owner !== "first") {
        return;
      }
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
  expect(fixture.siblingStart).toHaveBeenCalledOnce();
  expect(fixture.siblingStop).not.toHaveBeenCalled();
}

export async function verifyFailedRecoveryCleanup(createFixture: RecoveryFixtureFactory) {
  const resources: Array<{ closed: boolean }> = [];
  const fixture = await createFixture({
    abortOnCandidateStart: false,
    candidateStart() {
      throw new Error("candidate startup refused");
    },
    prepareAttached: async () => {
      if (resources.length === 3) {
        throw new Error("recovery attachment refused");
      }
    },
    register(api, owner) {
      if (owner !== "first") {
        return;
      }
      const resource = { closed: false };
      resources.push(resource);
      assert(api.lifecycle.onDispose);
      api.lifecycle.onDispose(() => {
        resource.closed = true;
      });
    },
  });

  await expect(fixture.reload()).rejects.toThrow("recovery attachment refused");

  expect(resources).toEqual([{ closed: true }, { closed: true }, { closed: true }]);
  expect(fixture.siblingStart).toHaveBeenCalledOnce();
  expect(fixture.siblingStop).not.toHaveBeenCalled();
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
  const prepareConfigEffects = vi.fn(() => async () => {});
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
  const record = fixture.previousRegistry.plugins.find((plugin) => plugin.id === pluginIds.at(-1));
  assert(record);
  const instance = getPluginInstance(record);
  assert(instance);
  const drainEntered = createDeferredCore();
  const waitForWork = instance.waitForRetainedWork.bind(instance);
  const observation = vi.spyOn(instance, "waitForRetainedWork").mockImplementation((...args) => {
    const draining = waitForWork(...args);
    drainEntered.resolve();
    return draining;
  });
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
    await Promise.race([drainEntered.promise, reloading]);
    await vi.advanceTimersByTimeAsync(70_000);
    expect(await reloading).toMatchObject({
      details: { phase: caller === "own invocation" ? "prepare" : "drain", committed: false },
    });
    expect(prepareConfigEffects).toHaveBeenCalledTimes(caller === "own invocation" ? 0 : 1);
    expect(fixture.firstStop).not.toHaveBeenCalled();
    expect(fixture.siblingStop).not.toHaveBeenCalled();
    expect(fixture.candidates).toHaveLength(0);
    expect(fixture.registryOwner.registry).toBe(fixture.previousRegistry);
    expect(instance.run(() => "still serving")).toBe("still serving");
    cleanup.resolve();
    await closing;
    assert(consumer);
    consumer.release();
    // A refusal on a later instance must unwind reservations already acquired for earlier ones.
    for (const previous of fixture.previousRegistry.plugins) {
      getPluginInstance(previous)?.retainWork()();
    }
    await expect(fixture.reload(undefined, pluginIds)).resolves.toMatchObject({
      runtime: { pluginIds },
    });
  } finally {
    observation.mockRestore();
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
      return async () => {};
    },
    register(api, owner) {
      if (owner !== "first") {
        return;
      }
      const generation = ++registrations;
      api.lifecycle.onDispose?.(() => void disposed.push(generation));
      api.registerGatewayMethod("first.generation", ({ respond }) => {
        respond(true, { generation });
      });
    },
  });
  const old = fixture.previousRegistry;
  const record = old.plugins.find((entry) => entry.id === "first");
  assert(record);
  const instance = getPluginInstance(record);
  assert(instance);
  const consumer = instance.retainConsumer();
  const consumerDrainEntered = createDeferredCore();
  const waitForWork = instance.waitForRetainedWork.bind(instance);
  const observation = vi.spyOn(instance, "waitForRetainedWork").mockImplementation((...args) => {
    const draining = waitForWork(...args);
    if (args[1]) {
      consumerDrainEntered.resolve();
    }
    return draining;
  });
  const first = retainRuntimePluginWork([old]);
  const second = retainRuntimePluginWork([old]);
  const reloading = fixture.reload();
  void reloading.catch(() => {});
  try {
    // A refusal is observed immediately instead of waiting for a fixture timeout.
    await Promise.race([reserved.promise, reloading]);
    expect(fixture.firstStop).not.toHaveBeenCalled();
    expect(disposed).toEqual([]);
    expect(() => retainRuntimePluginWork([old])).toThrow("replacement is in progress");
    first();
    expect(instance.run(() => "old run finishes")).toBe("old run finishes");
    expect(fixture.candidates).toHaveLength(0);
    second();
    await Promise.race([consumerDrainEntered.promise, reloading]);
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
    observation.mockRestore();
    await reloading.catch(() => {});
  }
}

async function verifyExplicitDrainWait(
  createFixture: RecoveryFixtureFactory,
  kind: "retained work" | "retained consumer" | "active call",
  outcome: "complete" | "cancel",
) {
  const controller = new AbortController();
  const fixture = await createFixture({
    abortOnCandidateStart: false,
    waitForDrain: true,
    drainSignal: controller.signal,
  });
  const instance = getPluginInstance(fixture.previousRegistry.plugins[0]!);
  assert(instance);
  const released = createDeferredCore();
  const consumer = kind === "retained consumer" ? instance.retainConsumer() : undefined;
  const release =
    kind === "retained work"
      ? instance.retainWork()
      : consumer
        ? () => consumer.release()
        : () => released.resolve();
  const call = kind === "active call" ? instance.run(() => released.promise) : undefined;
  const drainEntered = createDeferredCore();
  const drain = instance.drain.bind(instance);
  const waitForWork = instance.waitForRetainedWork.bind(instance);
  const observation =
    kind === "active call"
      ? vi.spyOn(instance, "drain").mockImplementation((...args) => {
          const pending = drain(...args);
          drainEntered.resolve();
          return pending;
        })
      : vi.spyOn(instance, "waitForRetainedWork").mockImplementation((...args) => {
          const pending = waitForWork(...args);
          drainEntered.resolve();
          return pending;
        });
  let settled = false;
  vi.useFakeTimers();
  const reloading = fixture
    .reload()
    .catch((error: unknown) => error)
    .then((result) => {
      settled = true;
      return result;
    });
  try {
    await Promise.race([drainEntered.promise, reloading]);
    expect(fixture.owner.getReloadStatus()?.reason).toBeTruthy();
    await vi.advanceTimersByTimeAsync(70_000);
    expect(settled).toBe(false);
    expect(fixture.candidates).toHaveLength(0);
    expect(fixture.firstStop).not.toHaveBeenCalled();
    expect(instance.disposing).toBe(false);
    expect(() => instance.retainWork()).toThrow("replacement is in progress");
    if (outcome === "cancel") {
      controller.abort(new Error("operator cancelled reload"));
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(true);
      expect(await reloading).toMatchObject({ details: { phase: "drain", committed: false } });
      expect(fixture.registryOwner.registry).toBe(fixture.previousRegistry);
      expect(instance.run(() => "still serving")).toBe("still serving");
      expect(instance.disposing).toBe(false);
      instance.retainWork()();
      expect(fixture.firstStop).not.toHaveBeenCalled();
      expect(fixture.rollbackConfigEffects).toHaveBeenCalledOnce();
    } else {
      release();
      await call;
      expect(await reloading).toMatchObject({ runtime: { pluginIds: ["first"] } });
      expect(fixture.registryOwner.registry).not.toBe(fixture.previousRegistry);
      expect(fixture.candidates).toHaveLength(1);
      expect(instance.disposing).toBe(true);
    }
    expect(fixture.owner.getReloadStatus()).toBeUndefined();
    expect(fixture.siblingStart).toHaveBeenCalledOnce();
    expect(fixture.siblingStop).not.toHaveBeenCalled();
  } finally {
    release();
    released.resolve();
    await call;
    await reloading;
    observation.mockRestore();
    vi.useRealTimers();
  }
}

export function registerPluginRetainedWorkReloadTests(
  createRecoveryFixture: RecoveryFixtureFactory,
) {
  it.each([
    ["retained work", "complete"],
    ["retained work", "cancel"],
    ["retained consumer", "complete"],
    ["retained consumer", "cancel"],
    ["active call", "complete"],
    ["active call", "cancel"],
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
        await expect(fixture.reload()).resolves.toMatchObject({
          runtime: { pluginIds: ["first"] },
        });
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
