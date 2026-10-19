import assert from "node:assert/strict";
import { expect, vi } from "vitest";
import { registerPluginHttpRoute } from "../plugins/http-registry.js";
import { getPluginInstance } from "../plugins/plugin-instance-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  reloadFailure,
  heldWork,
  probeHttpRoute,
} from "./server-plugin-reload.fixture-tools.test-support.js";
import {
  createRecoveryChannelManager,
  registerReloadChannel,
  expectSiblingUnchanged,
  waitForChannelAbort,
  type RecoveryFixtureFactory,
} from "./server-plugin-reload.recovery.test-support.js";
import { createReadinessChecker } from "./server/readiness.js";

function resumingSidecars(
  fixture: Awaited<ReturnType<RecoveryFixtureFactory>>,
  resume: (index: number) => void,
) {
  fixture.lifetime.publish(
    ...[0, 1].map((index) => ({
      stop: async () => {},
      preparePluginReload: () => ({ drain: async () => {}, resume: () => resume(index) }),
    })),
  );
}

export async function verifyPreparedSidecarRecovery(
  createFixture: RecoveryFixtureFactory,
  mode: "live" | "aborted-predecessor",
) {
  const start = vi.fn();
  const stop = vi.fn();
  const signals: AbortSignal[] = [];
  const channelId = "early-running";
  const finishTask = createDeferredCore();
  const fixture = await createFixture({
    abortOnCandidateStart: false,
    registerFirst(api) {
      api.on("gateway_start", start);
      api.on("gateway_stop", stop);
      registerReloadChannel(api, {
        id: channelId,
        startAccount: async ({ accountId, abortSignal, setStatus }) => {
          signals.push(abortSignal);
          setStatus({ accountId, running: true, connected: true, lifecycle: "ready" });
          await waitForChannelAbort(abortSignal);
          if (mode === "aborted-predecessor") {
            await finishTask.promise;
          }
        },
      });
    },
  });
  let paused = false;
  const preparationError = new Error("later sidecar preparation failed");
  fixture.runtime.runtimeState.gatewayLifetimeSidecars.publish(
    {
      stop: async () => {},
      preparePluginReload: () => {
        paused = true;
        return {
          drain: async () => {},
          resume: () => {
            paused = false;
          },
        };
      },
    },
    {
      stop: async () => {},
      preparePluginReload: () => {
        throw preparationError;
      },
    },
  );
  const manager = createRecoveryChannelManager(fixture);
  fixture.runtime.channelManager = manager;
  let stopping: Promise<void> | undefined;
  try {
    await manager.startChannel(channelId);
    if (mode === "aborted-predecessor") {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      stopping = manager.stopChannel(channelId);
      await vi.advanceTimersByTimeAsync(5_000);
      await stopping;
      vi.useRealTimers();
      expect(signals[0]?.aborted).toBe(true);
    }
    const result = await fixture.reload().catch((error: unknown) => error);
    expect(result).toMatchObject({ details: { committed: false } });
    expect(paused).toBe(false);
    expect(fixture.registryOwner.registry).toBe(fixture.previousRegistry);
    expect([stop.mock.calls, start.mock.calls]).toEqual([[], []]);
    expect(signals).toMatchObject([{ aborted: mode === "aborted-predecessor" }]);
    expect(
      manager.getRuntimeSnapshot({ channelId, inspectAccounts: false }).channels[channelId],
    ).toMatchObject({ running: true, connected: true, lifecycle: "ready" });
    if (mode === "live") {
      expect(result).toMatchObject({ cause: preparationError });
    } else {
      expect(result).toMatchObject({
        cause: {
          errors: [
            preparationError,
            expect.objectContaining({
              message: "Plugin channel early-running could not start: default",
            }),
          ],
        },
      });
    }
  } finally {
    finishTask.resolve();
    vi.useRealTimers();
    await stopping;
    await manager.stopChannel(channelId);
  }
}

export async function verifyServiceCleanupRecovery(createFixture: RecoveryFixtureFactory) {
  const fixture = await createFixture({
    abortOnCandidateStart: false,
    initialStop: async () => {
      throw new Error("fixture service could not close");
    },
  });
  await expect(fixture.reload()).rejects.toMatchObject(reloadFailure("drain"));
  expect(fixture.rollbackConfigEffects).toHaveBeenCalledOnce();
  const disabled = await fixture.reload({
    plugins: { allow: ["first", "sibling"], entries: { first: { enabled: false } } },
  });
  expect(disabled.runtime).toMatchObject({
    pluginIds: ["first"],
    warnings: [expect.stringContaining("fixture service could not close")],
  });
  expect(new Set(fixture.registryOwner.registry.plugins.map((plugin) => plugin.id))).toEqual(
    new Set(["sibling"]),
  );

  const enabled = await fixture.reload({
    plugins: { allow: ["first", "sibling"], entries: { first: { enabled: true } } },
  });
  expect(enabled.runtime.generation).toBeGreaterThan(disabled.runtime.generation);
  expect(new Set(fixture.registryOwner.registry.plugins.map((plugin) => plugin.id))).toEqual(
    new Set(["first", "sibling"]),
  );
  expectSiblingUnchanged(fixture);
}

export async function verifyIndependentPostCommitActivation(
  createFixture: RecoveryFixtureFactory,
  boundary:
    | "channel-retry"
    | "publication"
    | "notification"
    | "memory"
    | "sidecar"
    | "hook-and-channel",
) {
  const failure = new Error(`${boundary} activation refused`);
  const channelFailure = new Error("channel preparation refused");
  const starts: string[] = [];
  let generation = 0;
  const fixture = await createFixture({
    abortOnCandidateStart: false,
    afterPublish: async () => {
      if (boundary === "publication") {
        throw failure;
      }
      if (boundary === "channel-retry") {
        await manager.startChannel("first-channel", undefined, { preserveManualStop: true });
      }
    },
    register(api, owner, record) {
      if (owner === "sibling") {
        if (boundary === "memory") {
          record.kind = "memory";
          record.memorySlotSelected = true;
          api.registerMemoryCapability({
            runtime: {
              getMemorySearchManager: async () => ({ manager: null }),
              resolveMemoryBackendConfig: () => ({ backend: "builtin" }),
              prepareReload: () => ({
                drain: async () => ({ errors: [] }),
                resume: () => {
                  throw failure;
                },
              }),
            },
          });
        }
        return;
      }
      const current = ++generation;
      if (boundary === "memory") {
        record.contracts = { embeddingProviders: ["activation-embedding"] };
        api.registerEmbeddingProvider({
          id: "activation-embedding",
          create: async () => ({
            provider: {
              id: "activation-embedding",
              model: "fixture",
              embed: async () => [1],
              embedBatch: async () => [[1]],
            },
          }),
        });
      }
      api.on("gateway_start", () => {
        if (boundary === "hook-and-channel" && current > 1) {
          throw failure;
        }
      });
      for (const id of [
        "first-channel",
        "healthy-channel",
        ...(current === 1 ? ["removed-channel"] : []),
      ]) {
        registerReloadChannel(api, {
          id,
          config: {
            listAccountIds: () => {
              if (boundary === "hook-and-channel" && current > 1 && id === "first-channel") {
                throw channelFailure;
              }
              return ["default"];
            },
          },
          startAccount: async ({ abortSignal }) => {
            starts.push(`${id}:${current}`);
            const unregister = registerPluginHttpRoute({
              path: `/${id}`,
              auth: "plugin",
              pluginId: "first",
              source: "account",
              throwOnFailure: true,
              handler: (_req, res) => {
                res.end(`generation ${current}`);
              },
            });
            try {
              await waitForChannelAbort(abortSignal);
            } finally {
              unregister();
            }
          },
        });
      }
    },
  });
  const resumed = vi.fn();
  resumingSidecars(fixture, (index) => {
    if (boundary === "sidecar" && index === 0) {
      throw failure;
    }
    resumed(index);
  });
  if (boundary === "notification") {
    fixture.runtime.broadcast = () => {
      throw failure;
    };
  }
  const manager = createRecoveryChannelManager(fixture);
  fixture.runtime.channelManager = manager;
  const channelIds = ["first-channel", "healthy-channel", "removed-channel"];
  try {
    for (const id of channelIds) {
      await manager.startChannel(id);
    }
    const result = await fixture.reload().catch((error: unknown) => error);
    expect(result).toMatchObject(reloadFailure("activate", true));
    const readiness = createReadinessChecker({
      channelManager: manager,
      startedAt: Date.now(),
      getPluginReloadStatus: fixture.owner.getReloadStatus,
    });
    expect(readiness()).toMatchObject({
      ready: false,
      failing: ["plugin-reload"],
      pluginReload: { phase: "failed" },
    });
    assert(result instanceof Error);
    if (boundary === "hook-and-channel") {
      expect(result.cause).toMatchObject({ errors: [{ cause: failure }, channelFailure] });
      expect(result.message).toContain(failure.message);
      expect(result.message).toContain(channelFailure.message);
    } else if (boundary === "memory") {
      expect(result.cause).toMatchObject({ errors: [failure] });
    } else if (boundary === "channel-retry") {
      expect(result.cause).toMatchObject({
        message: "Plugin channel first-channel could not start: default",
      });
      expect(starts.filter((entry) => entry === "first-channel:2")).toHaveLength(1);
    } else {
      expect(result.cause).toBe(failure);
    }
    expect(fixture.registryOwner.registry).not.toBe(fixture.previousRegistry);
    expect(starts).toContain("healthy-channel:2");
    expect(resumed).toHaveBeenCalledWith(1);
    fixture.expectServices({ siblingStart: 1, siblingStop: boundary === "memory" ? 1 : 0 });
    const routes = fixture.registryOwner.registry.httpRoutes;
    expect(routes.some((route) => route.handoff)).toBe(false);
    expect(routes.some((route) => route.path === "/removed-channel")).toBe(false);
    const route = routes.find((entry) => entry.path === "/healthy-channel");
    assert(route);
    await probeHttpRoute(route.handler, (_response, end) => {
      expect(end).toHaveBeenCalledWith("generation 2");
    });
    expect(getPluginInstance(fixture.previousRegistry.plugins[0]!)?.lifecycle.signal.aborted).toBe(
      true,
    );
  } finally {
    for (const id of channelIds) {
      await manager.stopChannel(id);
    }
  }
}

export async function verifyLifecycleHookSettlement(
  createFixture: RecoveryFixtureFactory,
  phase: "start" | "stop",
) {
  const hookGate = heldWork();
  const failure = new Error("lifecycle hook refused");
  const starts: number[] = [];
  let generation = 0;
  const fixture = await createFixture({
    abortOnCandidateStart: false,
    registerFirst(api) {
      const current = ++generation;
      if ((phase === "start" && current > 1) || (phase === "stop" && current === 1)) {
        const hook = phase === "start" ? "gateway_start" : "gateway_stop";
        api.on(hook, () => {
          throw failure;
        });
        api.on(hook, hookGate.run);
      }
      registerReloadChannel(api, {
        id: "hook-dependent",
        startAccount: async ({ abortSignal }) => {
          starts.push(current);
          await waitForChannelAbort(abortSignal);
        },
      });
    },
  });
  const manager = createRecoveryChannelManager(fixture);
  fixture.runtime.channelManager = manager;
  await manager.startChannel("hook-dependent");
  const reloading = fixture.reload().catch((error: unknown) => error);
  try {
    await Promise.race([
      hookGate.entered,
      reloading.then(() => {
        throw new Error("hook never entered");
      }),
    ]);
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(starts).toEqual([1]);
    if (phase === "stop") {
      expect(fixture.firstStop).toHaveBeenCalledOnce();
    }
    hookGate.release();
    const result = await reloading;
    if (phase === "start") {
      expect(result).toMatchObject({ details: { committed: true }, cause: { cause: failure } });
    } else {
      expect(result).toMatchObject({
        details: { committed: false, phase: "drain" },
        message: expect.stringContaining(failure.message),
      });
      expect(fixture.candidates).toHaveLength(0);
      expect(fixture.firstStart).toHaveBeenCalledOnce();
      expect(fixture.registryOwner.registry).toBe(fixture.previousRegistry);
    }
    expect(starts).toEqual(phase === "start" ? [1, 2] : [1]);
  } finally {
    hookGate.release();
    await reloading;
    await manager.stopChannel("hook-dependent");
  }
}

export async function verifyIndependentRollbackRestoration(
  createFixture: RecoveryFixtureFactory,
  boundary: "services" | "channel",
) {
  const failure = new Error(`${boundary} restoration refused`);
  const sidecarFailure = new Error("first sidecar resume refused");
  let restoring = false;
  const starts: string[] = [];
  const resumed: number[] = [];
  const fixture = await createFixture({
    recoveryStart: async () => {
      restoring = true;
      if (boundary === "services") {
        throw failure;
      }
    },
    registerFirst(api) {
      for (const id of ["first-restore", "healthy-restore"]) {
        registerReloadChannel(api, {
          id,
          config: {
            listAccountIds: () => {
              if (restoring && boundary === "channel" && id === "first-restore") {
                throw failure;
              }
              return ["default"];
            },
          },
          startAccount: async ({ abortSignal }) => {
            starts.push(id);
            await waitForChannelAbort(abortSignal);
          },
        });
      }
    },
  });
  resumingSidecars(fixture, (index) => {
    resumed.push(index);
    if (boundary === "services" && index === 0) {
      throw sidecarFailure;
    }
  });
  const manager = createRecoveryChannelManager(fixture);
  fixture.runtime.channelManager = manager;
  try {
    await manager.startChannel("first-restore");
    await manager.startChannel("healthy-restore");
    const result = await fixture.reload().catch((error: unknown) => error);
    expect(result).toMatchObject({ details: { committed: false } });
    expect(fixture.registryOwner.registry).not.toBe(fixture.previousRegistry);
    const restoredRecord = fixture.registryOwner.registry.plugins.find(
      (record) => record.id === "first",
    );
    expect(restoredRecord).not.toBe(fixture.previousRegistry.plugins[0]);
    expect(fixture.registryOwner.registry.plugins.find((record) => record.id === "sibling")).toBe(
      fixture.previousRegistry.plugins[1],
    );
    expect(resumed).toEqual([0, 1]);
    if (boundary === "services") {
      expect(result).toMatchObject({
        cause: { errors: [expect.any(Error), { errors: [{ errors: [failure] }, sidecarFailure] }] },
      });
      expect(starts).toEqual(["first-restore", "healthy-restore"]);
      await manager.startChannel("healthy-restore");
      await vi.waitFor(() =>
        expect(starts).toEqual(["first-restore", "healthy-restore", "healthy-restore"]),
      );
    } else {
      expect(result).toMatchObject({ cause: { errors: [expect.any(Error), failure] } });
      expect(starts).toEqual(["first-restore", "healthy-restore", "healthy-restore"]);
      expect(
        manager.getRuntimeSnapshot({ channelId: "healthy-restore", inspectAccounts: false })
          .reloadingChannels?.size ?? 0,
      ).toBe(0);
    }
    expectSiblingUnchanged(fixture);
    expect(fixture.owner.currentServices()).not.toBeNull();
    if (boundary === "channel") {
      await fixture.reload(fixture.getConfig(), ["sibling"]);
      expect(fixture.owner.getReloadStatus()).toMatchObject({
        phase: "failed",
        pluginIds: ["first"],
      });
    }
  } finally {
    await manager.stopChannel("first-restore");
    await manager.stopChannel("healthy-restore");
  }
}
