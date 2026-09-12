import assert from "node:assert/strict";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { expect, vi } from "vitest";
import { registerPluginHttpRoute } from "../plugins/http-registry.js";
import { getPluginInstance } from "../plugins/plugin-instance-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import { createChannelTestPluginBase } from "../test-utils/channel-plugins.js";
import {
  createRecoveryChannelManager,
  type RecoveryFixtureFactory,
} from "./server-plugin-reload.recovery.test-support.js";

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
    register(api, owner) {
      if (owner === "first") {
        api.on("gateway_start", start);
        api.on("gateway_stop", stop);
        api.registerChannel({
          plugin: {
            ...createChannelTestPluginBase({ id: channelId }),
            gateway: {
              startAccount: async ({ accountId, abortSignal, setStatus }) => {
                signals.push(abortSignal);
                setStatus({ accountId, running: true, connected: true, lifecycle: "ready" });
                await new Promise<void>((resolve) => {
                  abortSignal.addEventListener("abort", () => resolve(), { once: true });
                });
                if (mode === "aborted-predecessor") {
                  await finishTask.promise;
                }
              },
            },
          },
        });
      }
    },
  });
  let paused = false;
  const preparationError = new Error("later sidecar preparation failed");
  fixture.runtime.runtimeState.gatewayLifetimeSidecars = [
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
  ];
  const manager = createRecoveryChannelManager(fixture);
  fixture.runtime.channelManager = manager;
  let stopping: Promise<void> | undefined;
  try {
    await manager.startChannel(channelId);
    expect(signals).toHaveLength(1);
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
    expect(stop).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(mode === "aborted-predecessor");
    expect(
      manager.getRuntimeSnapshot({ channelId, inspectAccounts: false }).channels[channelId],
    ).toMatchObject({
      running: true,
      connected: true,
      lifecycle: "ready",
    });
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
  expect(fixture.siblingStart).toHaveBeenCalledOnce();
  expect(fixture.siblingStop).not.toHaveBeenCalled();
}

export async function verifyIndependentPostCommitActivation(
  createFixture: RecoveryFixtureFactory,
  boundary:
    | "channel"
    | "channel-retry"
    | "hook"
    | "publication"
    | "notification"
    | "memory"
    | "sidecar"
    | "hook-and-channel",
) {
  const failure = new Error(`${boundary} activation refused`);
  const channelFailure =
    boundary === "hook-and-channel" ? new Error("channel preparation refused") : failure;
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
        if ((boundary === "hook" || boundary === "hook-and-channel") && current > 1) {
          throw failure;
        }
      });
      for (const id of [
        "first-channel",
        "healthy-channel",
        ...(current === 1 ? ["removed-channel"] : []),
      ]) {
        api.registerChannel({
          plugin: {
            ...createChannelTestPluginBase({
              id,
              config: {
                listAccountIds: () => {
                  if (
                    (boundary === "channel" || boundary === "hook-and-channel") &&
                    current > 1 &&
                    id === "first-channel"
                  ) {
                    throw channelFailure;
                  }
                  return ["default"];
                },
              },
            }),
            gateway: {
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
                  await new Promise<void>((resolve) => {
                    abortSignal.addEventListener("abort", () => resolve(), { once: true });
                  });
                } finally {
                  unregister();
                }
              },
            },
          },
        });
      }
    },
  });
  const resumed = vi.fn();
  fixture.runtime.runtimeState.gatewayLifetimeSidecars = [0, 1].map((index) => ({
    stop: async () => {},
    preparePluginReload: () => ({
      drain: async () => {},
      resume: () => {
        if (boundary === "sidecar" && index === 0) {
          throw failure;
        }
        resumed(index);
      },
    }),
  }));
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
    expect(result).toMatchObject({ details: { committed: true, phase: "activate" } });
    assert(result instanceof Error);
    if (boundary === "hook-and-channel") {
      expect(result.cause).toMatchObject({ errors: [{ cause: failure }, channelFailure] });
      expect(result.message).toContain(failure.message);
      expect(result.message).toContain(channelFailure.message);
    } else if (boundary === "memory") {
      expect(result.cause).toMatchObject({ errors: [failure] });
    } else if (boundary === "hook") {
      expect(result.cause).toMatchObject({ cause: failure });
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
    expect(fixture.siblingStart).toHaveBeenCalledOnce();
    expect(fixture.siblingStop).not.toHaveBeenCalled();
    const routes = fixture.registryOwner.registry.httpRoutes;
    expect(routes.some((route) => route.handoff)).toBe(false);
    expect(routes.some((route) => route.path === "/removed-channel")).toBe(false);
    const route = routes.find((entry) => entry.path === "/healthy-channel");
    assert(route);
    const request = new IncomingMessage(new Socket());
    const response = new ServerResponse(request);
    const end = vi.spyOn(response, "end").mockReturnValue(response);
    try {
      await route.handler(request, response);
      expect(end).toHaveBeenCalledWith("generation 2");
    } finally {
      request.destroy();
      response.destroy();
    }
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
  const entered = createDeferredCore();
  const release = createDeferredCore();
  const failure = new Error("lifecycle hook refused");
  const starts: number[] = [];
  let generation = 0;
  const fixture = await createFixture({
    abortOnCandidateStart: false,
    register(api, owner) {
      if (owner !== "first") {
        return;
      }
      const current = ++generation;
      if ((phase === "start" && current > 1) || (phase === "stop" && current === 1)) {
        const hook = phase === "start" ? "gateway_start" : "gateway_stop";
        api.on(hook, () => {
          throw failure;
        });
        api.on(hook, async () => {
          entered.resolve();
          await release.promise;
        });
      }
      api.registerChannel({
        plugin: {
          ...createChannelTestPluginBase({ id: "hook-dependent" }),
          gateway: {
            startAccount: async ({ abortSignal }) => {
              starts.push(current);
              await new Promise<void>((resolve) => {
                abortSignal.addEventListener("abort", () => resolve(), { once: true });
              });
            },
          },
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
      entered.promise,
      reloading.then(() => {
        throw new Error("hook never entered");
      }),
    ]);
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(starts).toEqual([1]);
    if (phase === "stop") {
      expect(fixture.firstStop).not.toHaveBeenCalled();
    }
    release.resolve();
    const result = await reloading;
    if (phase === "start") {
      expect(result).toMatchObject({ details: { committed: true }, cause: { cause: failure } });
    } else {
      expect(result).toMatchObject({
        runtime: { warnings: [expect.stringContaining(failure.message)] },
      });
    }
    expect(starts).toEqual([1, 2]);
  } finally {
    release.resolve();
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
    register(api, owner) {
      if (owner !== "first") {
        return;
      }
      for (const id of ["first-restore", "healthy-restore"]) {
        api.registerChannel({
          plugin: {
            ...createChannelTestPluginBase({
              id,
              config: {
                listAccountIds: () => {
                  if (restoring && boundary === "channel" && id === "first-restore") {
                    throw failure;
                  }
                  return ["default"];
                },
              },
            }),
            gateway: {
              startAccount: async ({ abortSignal }) => {
                starts.push(id);
                await new Promise<void>((resolve) => {
                  abortSignal.addEventListener("abort", () => resolve(), { once: true });
                });
              },
            },
          },
        });
      }
    },
  });
  fixture.runtime.runtimeState.gatewayLifetimeSidecars = [0, 1].map((index) => ({
    stop: async () => {},
    preparePluginReload: () => ({
      drain: async () => {},
      resume: () => {
        resumed.push(index);
        if (boundary === "services" && index === 0) {
          throw sidecarFailure;
        }
      },
    }),
  }));
  const manager = createRecoveryChannelManager(fixture);
  fixture.runtime.channelManager = manager;
  try {
    await manager.startChannel("first-restore");
    await manager.startChannel("healthy-restore");
    const result = await fixture.reload().catch((error: unknown) => error);
    expect(result).toMatchObject({ details: { committed: false } });
    expect(fixture.registryOwner.registry).toBe(fixture.previousRegistry);
    expect(resumed).toEqual([0, 1]);
    if (boundary === "services") {
      expect(result).toMatchObject({
        cause: {
          errors: [
            expect.any(Error),
            {
              errors: [{ errors: [failure] }, sidecarFailure],
            },
          ],
        },
      });
      expect(
        manager
          .getRuntimeSnapshot({ channelId: "healthy-restore", inspectAccounts: false })
          .reloadingChannels?.has("healthy-restore"),
      ).toBe(true);
      expect(starts).toEqual(["first-restore", "healthy-restore"]);
    } else {
      expect(result).toMatchObject({ cause: { errors: [expect.any(Error), failure] } });
      expect(starts).toEqual(["first-restore", "healthy-restore", "healthy-restore"]);
      expect(
        manager.getRuntimeSnapshot({ channelId: "healthy-restore", inspectAccounts: false })
          .reloadingChannels?.size ?? 0,
      ).toBe(0);
    }
    expect(fixture.siblingStart).toHaveBeenCalledOnce();
    expect(fixture.siblingStop).not.toHaveBeenCalled();
    expect(fixture.owner.currentServices()).not.toBeNull();
  } finally {
    await manager.stopChannel("first-restore");
    await manager.stopChannel("healthy-restore");
  }
}
