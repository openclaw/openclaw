import assert from "node:assert/strict";
import { collectNestedErrorCandidates } from "@openclaw/normalization-core/error-coercion";
import { expect, vi } from "vitest";
import type { ChannelPlugin } from "../channels/plugins/types.public.js";
import { setRuntimeConfigSnapshot } from "../config/io.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createSubsystemLogger, type SubsystemLogger } from "../logging/subsystem.js";
import { adoptPluginHttpRouteHandoffs, registerPluginHttpRoute } from "../plugins/http-registry.js";
import { activatePluginRegistry, PluginLoadFailureError } from "../plugins/loader-shared.js";
import {
  createPluginCommandRuntime,
  type PluginCommandCatalogDecision,
} from "../plugins/plugin-command-runtime.js";
import { getPluginInstance } from "../plugins/plugin-instance-scope.js";
import { retainGatewayPluginMetadata } from "../plugins/plugin-metadata-lifecycle.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { projectPluginContributions } from "../plugins/registry-contributions.js";
import { createPluginRegistry } from "../plugins/registry.js";
import { PluginRuntimeCloseRetainedError } from "../plugins/runtime-close-error.js";
import {
  createPluginRegistryOwner,
  disposePluginRegistryInstances,
  setActivePluginRegistry,
} from "../plugins/runtime.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import { createPluginRuntime } from "../plugins/runtime/index.js";
import {
  startPluginServices,
  type PluginServicesHandle,
} from "../plugins/services.test-support.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import type { OpenClawPluginApi } from "../plugins/types.js";
import { setActiveDegradedSecretOwners } from "../secrets/runtime-degraded-state.js";
import { createDeferredCore } from "../shared/deferred.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { createChannelTestPluginBase } from "../test-utils/channel-plugins.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { createChannelManager } from "./server-channels.js";
import {
  firstReloaded,
  rejectWith,
  heldWork,
  pluginInstance,
  probeHttpRoute,
} from "./server-plugin-reload.fixture-tools.test-support.js";
import { reloadGatewayPlugins } from "./server-plugin-reload.js";
import { createGatewayPluginRuntimeGeneration } from "./server-plugin-runtime-generation.js";
import { GatewayRequestEntryLifetime } from "./server-request-entry.js";
import { createGatewaySidecarStopOwner } from "./server-sidecar-owners.js";

export async function createPluginReloadRecoveryFixture(
  {
    cleanups,
    logMocks,
  }: {
    cleanups: Array<() => Promise<void>>;
    logMocks: Pick<SubsystemLogger, "info" | "warn" | "error" | "debug">;
  },
  options: {
    config?: OpenClawConfig;
    pluginMetadataSnapshot?: PluginMetadataSnapshot;
    env?: NodeJS.ProcessEnv;
    register?: (
      api: OpenClawPluginApi,
      pluginOwner: "first" | "sibling",
      record: ReturnType<typeof createPluginRecord>,
    ) => void;
    registerFirst?: (api: OpenClawPluginApi, record: ReturnType<typeof createPluginRecord>) => void;
    abortOnCandidateStart?: boolean;
    waitForDrain?: boolean;
    drainSignal?: AbortSignal;
    checkpoint?: Parameters<typeof reloadGatewayPlugins>[1]["checkpoint"];
    prepareAttached?: () => Promise<void>;
    initialStop?: () => Promise<void>;
    beforePublish?: () => Promise<void>;
    afterPublish?: () => Promise<void>;
    assertInvokerOwned?: () => void;
    prepareConfigEffects?: Parameters<typeof reloadGatewayPlugins>[1]["prepareConfigEffects"];
    candidateStart?: () => void;
    candidateStop?: () => Promise<void>;
    recoveryStart?: () => Promise<void>;
    recoveryStop?: () => Promise<void>;
    expectedMetadataCloseError?: Error;
  } = {},
) {
  let config: OpenClawConfig = options.config ?? { plugins: { allow: ["first", "sibling"] } };
  setRuntimeConfigSnapshot(config);
  const log = { ...createSubsystemLogger("gateway/plugins"), ...logMocks };
  const createBuilder = () =>
    createPluginRegistry({
      logger: log,
      runtime: createPluginRuntime(),
      activateGlobalSideEffects: false,
    });
  const previous = createBuilder();
  let firstStarts = 0;
  let aborted = false;
  const firstStart = vi.fn(async () => {
    firstStarts += 1;
    if (firstStarts > 1) {
      await options.recoveryStart?.();
    }
  });
  const firstStop = vi.fn(async () => {
    if (firstStarts > 1) {
      await options.recoveryStop?.();
    } else {
      await options.initialStop?.();
    }
  });
  const siblingStart = vi.fn();
  const siblingStop = vi.fn();
  const services = {
    first: { id: "first", start: firstStart, stop: firstStop },
    sibling: { id: "sibling", start: siblingStart, stop: siblingStop },
  };
  const register = (
    api: OpenClawPluginApi,
    id: "first" | "sibling",
    record: ReturnType<typeof createPluginRecord>,
  ) => {
    options.register?.(api, id, record);
    if (id === "first") {
      options.registerFirst?.(api, record);
    }
  };
  for (const id of ["first", "sibling"] as const) {
    const record = createPluginRecord({ id });
    previous.registry.plugins.push(record);
    const api = previous.createApi(record, { config });
    register(api, id, record);
    api.registerService({ ...services[id] });
  }
  setActivePluginRegistry(previous.registry);
  const registryOwner = createPluginRegistryOwner(previous.registry);
  const initial = await startPluginServices({ registry: previous.registry, config });
  let currentServices: PluginServicesHandle | null = initial;
  const owner = createGatewayPluginRuntimeGeneration({
    getServices: () => currentServices,
    setServices: (handle) => {
      currentServices = handle;
    },
  });
  const candidateStop = vi.fn(async () => await options.candidateStop?.());
  const rollbackConfigEffects = vi.fn(async () => {});
  const serviceMocks = { firstStart, firstStop, siblingStart, siblingStop };
  const candidates: ReturnType<typeof createBuilder>[] = [];
  const recoveries: ReturnType<typeof createBuilder>[] = [];
  const preparePlugins = async ({
    cfg,
    replacePluginIds = new Set<string>(),
    loadModules = true,
    moduleRecoveries,
  }: {
    cfg: OpenClawConfig;
    replacePluginIds?: ReadonlySet<string>;
    loadModules?: boolean;
    moduleRecoveries?: ReadonlyMap<string, unknown>;
  }) => {
    const candidate = createBuilder();
    if (loadModules) {
      (moduleRecoveries ? recoveries : candidates).push(candidate);
    }
    for (const id of ["first", "sibling"] as const) {
      if (!replacePluginIds.has(id)) {
        const retained = registryOwner.registry.plugins.find((record) => record.id === id);
        assert(retained);
        candidate.registry.plugins.push(retained);
        projectPluginContributions(registryOwner.registry, retained, candidate.registry);
        continue;
      }
      if (id === "first" && cfg.plugins?.entries?.first?.enabled === false) {
        continue;
      }
      const record = createPluginRecord({ id });
      candidate.registry.plugins.push(record);
      if (loadModules) {
        const api = candidate.createApi(record, { config: cfg });
        try {
          register(api, id, record);
        } catch (error) {
          record.status = "error";
          record.error = error instanceof Error ? error.message : String(error);
          throw new PluginLoadFailureError(candidate.registry, [record]);
        }
        api.registerService(
          id === "first" && !moduleRecoveries
            ? {
                id,
                start: () => {
                  aborted = options.abortOnCandidateStart !== false;
                  options.candidateStart?.();
                },
                stop: async () => await candidateStop(),
              }
            : { ...services[id] },
        );
      }
    }
    return {
      pluginRegistry: candidate.registry,
      resolvedConfig: cfg,
      gatewayMethods: [],
      retireGatewayRuntimeBindings: vi.fn(),
    };
  };
  const lifetime = createGatewaySidecarStopOwner();
  const scheduler = createTestGatewayScheduler();
  const metadata = retainGatewayPluginMetadata(scheduler);
  const metadataState = resolveGlobalSingleton<{ owner?: unknown }>(
    Symbol.for("openclaw.gatewayPluginMetadataOwner"),
    () => ({}),
  );
  const fixtureMetadataOwner = metadataState.owner;
  if (options.expectedMetadataCloseError) {
    expect(fixtureMetadataOwner).toBeDefined();
  }
  const snapshot =
    options.pluginMetadataSnapshot ??
    createPluginMetadataSnapshotFixture({ plugins: [{ id: "first" }, { id: "sibling" }] });
  metadata.publish(snapshot);
  const runtime = {
    scheduler,
    requestEntryLifetime: new GatewayRequestEntryLifetime(),
    pluginMetadataSnapshot: snapshot,
    pluginRuntime: registryOwner,
    kernel: {
      pluginRuntimeGeneration: owner,
      pluginMetadata: metadata,
      getCronService: () => runtime.runtimeState.cronState.cron,
    },
    runtimeState: {
      cronState: {},
      gatewayLifetimeSidecars: lifetime,
      postReadySidecars: createGatewaySidecarStopOwner(),
    },
    registerGatewayLifetimeSidecars: lifetime.publish,
    ambientEnvTriggers: "suppress",
    coreGatewayMethodNames: [],
    baseMethods: [],
    channelManager: {
      pauseChannelStarts: () => () => {},
      releaseChannelRouteHandoffs: vi.fn(),
      setAmbientAutostartSuppressedChannelIds: vi.fn(),
    },
    clients: new Set(),
    broadcast: vi.fn(),
  } as unknown as Parameters<typeof reloadGatewayPlugins>[0]["runtime"];
  cleanups.push(async () => {
    await scheduler.stop();
    await currentServices?.stop().catch(() => {});
    await initial.stop().catch(() => {});
    const retirementFailure = await lifetime.stop().catch((error: unknown) => error);
    await registryOwner.close();
    if (options.expectedMetadataCloseError) {
      try {
        const failure = await metadata.close().catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(PluginRuntimeCloseRetainedError);
        expect(collectNestedErrorCandidates(failure)).toContain(options.expectedMetadataCloseError);
        expect(metadataState.owner).toBe(fixtureMetadataOwner);
      } finally {
        // This deliberately unrecoverable fixture has asserted the real shutdown
        // fence. Release its owned state so later tests can create Gateways.
        delete metadataState.owner;
      }
    } else {
      await metadata.close();
    }
    for (const candidate of [...candidates, ...recoveries]) {
      try {
        await disposePluginRegistryInstances(candidate.registry, previous.registry);
      } catch (error) {
        // A deliberately failed sidecar still owns the same retirement failure.
        if (error !== retirementFailure) {
          throw error;
        }
      }
    }
  });
  const reload = (
    nextConfig = config,
    pluginIds: readonly string[] = ["first"],
    changedPaths: string[] = [],
    ownership?: Pick<Parameters<typeof reloadGatewayPlugins>[1], "checkpoint" | "isAborted">,
  ) => {
    aborted = false;
    return withPluginRuntimeRegistryScope(registryOwner.registry, () =>
      reloadGatewayPlugins(
        {
          runtime,
          port: 0,
          log,
          loadGatewayPluginBootstrapModule: async () => ({
            prepareGatewayPluginLoad: preparePlugins,
          }),
          prepareAttachedPluginRuntime: async (candidate, trackActivationCleanup) => {
            await options.prepareAttached?.();
            return {
              publish: () => {
                adoptPluginHttpRouteHandoffs(registryOwner.registry, candidate.pluginRegistry);
                activatePluginRegistry(
                  candidate.pluginRegistry,
                  null,
                  "gateway-bindable",
                  undefined,
                  registryOwner.registry,
                  trackActivationCleanup,
                );
                registryOwner.publish(candidate.pluginRegistry);
              },
              afterCommit: vi.fn(),
            };
          },
        },
        {
          nextConfig,
          sourceConfig: nextConfig,
          changedPaths,
          checkpoint: ownership?.checkpoint ?? options.checkpoint,
          prepareConfigEffects:
            options.prepareConfigEffects ??
            (() => ({ retire: () => {}, rollback: rollbackConfigEffects })),
          pluginLifecycle: {
            reason: "reload",
            waitForDrain: options.waitForDrain,
            drainSignal: options.drainSignal,
            operationId: "service-recovery",
            pluginIds,
          },
          commitRuntime: async (publication) => {
            await options.beforePublish?.();
            publication?.publish();
            config = nextConfig;
            setRuntimeConfigSnapshot(config);
            publication?.afterCommit?.();
            await options.afterPublish?.();
          },
          env: options.env ?? {},
          isAborted: () => aborted || ownership?.isAborted?.() === true,
          assertInvokerOwned: options.assertInvokerOwned,
        },
      ),
    );
  };
  return {
    runtime,
    getConfig: () => config,
    owner,
    registryOwner,
    previousRegistry: previous.registry,
    reload,
    firstStart,
    firstStop,
    siblingStart,
    siblingStop,
    candidateStop,
    rollbackConfigEffects,
    candidates,
    lifetime,
    instance: (id = "first") => pluginInstance(previous.registry, id),
    expectServices(counts: Partial<Record<keyof typeof serviceMocks, number>>) {
      for (const key of ["firstStart", "firstStop", "siblingStart", "siblingStop"] as const) {
        const count = counts[key];
        if (count !== undefined) {
          expect(serviceMocks[key]).toHaveBeenCalledTimes(count);
        }
      }
    },
  };
}

export type RecoveryFixtureFactory = (
  options?: Parameters<typeof createPluginReloadRecoveryFixture>[1],
) => ReturnType<typeof createPluginReloadRecoveryFixture>;

type RecoveryFixture = Awaited<ReturnType<RecoveryFixtureFactory>>;

export function expectSiblingUnchanged(fixture: RecoveryFixture) {
  fixture.expectServices({ siblingStart: 1, siblingStop: 0 });
}

export function observeRetainedWork(
  instance: NonNullable<ReturnType<typeof getPluginInstance>>,
  consumersOnly = false,
) {
  const entered = createDeferredCore();
  const wait = instance.waitForRetainedWork.bind(instance);
  const observation = vi.spyOn(instance, "waitForRetainedWork").mockImplementation((...args) => {
    const pending = wait(...args);
    if (!consumersOnly || args[1]) {
      entered.resolve();
    }
    return pending;
  });
  return {
    entered: entered.promise,
    reject: entered.reject,
    restore: () => observation.mockRestore(),
  };
}

export function waitForChannelAbort(signal: AbortSignal, checkAborted = false) {
  return new Promise<void>((resolve) => {
    if (checkAborted && signal.aborted) {
      resolve();
    } else {
      signal.addEventListener("abort", () => resolve(), { once: true });
    }
  });
}

export function registerReloadChannel(
  api: OpenClawPluginApi,
  options: Pick<Parameters<typeof createChannelTestPluginBase>[0], "id" | "config"> &
    NonNullable<ChannelPlugin["gateway"]>,
) {
  const { id, config, ...gateway } = options;
  api.registerChannel({ plugin: { ...createChannelTestPluginBase({ id, config }), gateway } });
}

export function createRecoveryChannelManager(fixture: Awaited<ReturnType<RecoveryFixtureFactory>>) {
  return createChannelManager({
    scheduler: createTestGatewayScheduler(),
    getRuntimeConfig: fixture.getConfig,
    getPluginRegistry: () => fixture.registryOwner.registry,
    channelLogs: {},
    channelRuntimeEnvs: {},
  });
}

export async function createCleanupChannels(
  createFixture: RecoveryFixtureFactory,
  firstHooks: (api: OpenClawPluginApi) => void,
  stopAccount?: NonNullable<ChannelPlugin["gateway"]>["stopAccount"],
) {
  const signals: Record<"first" | "sibling", AbortSignal[]> = { first: [], sibling: [] };
  const fixture = await createFixture({
    abortOnCandidateStart: false,
    register(api, owner) {
      if (owner === "first") {
        firstHooks(api);
      }
      registerReloadChannel(api, {
        id: `cleanup-${owner}`,
        startAccount: async ({ abortSignal }) => {
          signals[owner].push(abortSignal);
          await waitForChannelAbort(abortSignal, stopAccount !== undefined);
        },
        ...(owner === "first" && stopAccount ? { stopAccount } : {}),
      });
    },
  });
  const manager = createRecoveryChannelManager(fixture);
  fixture.runtime.channelManager = manager;
  await manager.startChannel("cleanup-first");
  await manager.startChannel("cleanup-sibling");
  await vi.waitFor(() => expect([signals.first.length, signals.sibling.length]).toEqual([1, 1]));
  return { fixture, manager, signals };
}

export async function verifyMalformedReloadFailureReceipt(
  createRecoveryFixture: RecoveryFixtureFactory,
  boundary: "prepare" | "committed",
) {
  const failure = new Error("hidden fixture message");
  failure.name = "PluginReloadFixtureError";
  Object.defineProperty(failure, "message", {
    get() {
      throw new Error("message getter must not replace the operation failure");
    },
  });
  const reject = rejectWith(failure);
  const fixture = await createRecoveryFixture({
    abortOnCandidateStart: false,
    ...(boundary === "prepare" ? { checkpoint: reject } : { afterPublish: reject }),
  });
  const result = await fixture.reload().catch((error: unknown) => error);
  expect(result).toMatchObject({
    message: expect.stringContaining("PluginReloadFixtureError"),
    details: {
      operationId: "service-recovery",
      pluginIds: ["first"],
      phase: boundary === "prepare" ? "prepare" : "activate",
      committed: boundary === "committed",
    },
  });
  assert(result instanceof Error);
  expect(result.cause).toBe(failure);
  expect(fixture.registryOwner.registry === fixture.previousRegistry).toBe(boundary === "prepare");
}

export async function verifyChannelReplacementContracts(
  createRecoveryFixture: RecoveryFixtureFactory,
) {
  const channelId = "reload-contract";
  const dispatches: PluginCommandCatalogDecision[] = [];
  const starts: number[] = [];
  const stops: number[] = [];
  const commands: Array<ReturnType<typeof vi.fn>> = [];
  let registrations = 0;
  const fixture = await createRecoveryFixture({
    abortOnCandidateStart: false,
    beforePublish: async () => {
      const route = fixture.previousRegistry.httpRoutes[0];
      assert(route);
      await probeHttpRoute(route.handler, (response, end) => {
        expect(response.statusCode).toBe(503);
        expect(response.getHeader("Retry-After")).toBe("1");
        expect(end).toHaveBeenCalledWith("plugin route is restarting; retry");
        expect({ starts, stops }).toEqual({ starts: [1], stops: [1] });
      });
    },
    registerFirst(api) {
      const generation = ++registrations;
      const handler = vi.fn(async () => ({ text: `generation ${generation}` }));
      commands.push(handler);
      api.registerCommand({
        name: "refresh",
        description: "Refresh",
        channels: [channelId],
        handler,
      });
      registerReloadChannel(api, {
        id: channelId,
        startAccount: async ({ abortSignal }) => {
          starts.push(generation);
          const command = createPluginCommandRuntime().listNativeCandidates(channelId)[0];
          assert(command);
          dispatches.push(command.prepareDispatch());
          const unregister = registerPluginHttpRoute({
            path: "/reload-contract",
            auth: "plugin",
            pluginId: "first",
            source: "account",
            throwOnFailure: true,
            handler: (_req, res) => {
              res.end(`generation ${generation}`);
            },
          });
          try {
            await waitForChannelAbort(abortSignal, true);
          } finally {
            unregister();
          }
        },
        stopAccount: async () => {
          stops.push(generation);
        },
      });
    },
  });
  const manager = createRecoveryChannelManager(fixture);
  fixture.runtime.channelManager = manager;
  try {
    await manager.startChannel(channelId);
    expect(starts).toEqual([1]);
    expect(fixture.previousRegistry.httpRoutes).toHaveLength(1);
    await fixture.reload();
    expect(starts).toEqual([1, 2]);
    expect(stops).toEqual([1]);
    expect(fixture.registryOwner.registry.httpRoutes).toHaveLength(1);
    expect(fixture.registryOwner.registry.httpRoutes[0]?.handoff).not.toBe(true);
    const [stale, current] = dispatches;
    assert(stale?.kind === "plugin" && current?.kind === "plugin");
    const context = {
      channel: channelId,
      isAuthorizedSender: true,
      commandBody: "/refresh",
      config: {},
    };
    await expect(stale.execute(context)).resolves.toMatchObject({
      text: expect.stringContaining("registry changed"),
    });
    await expect(current.execute(context)).resolves.toEqual({ text: "generation 2" });
    expect(commands[0]).not.toHaveBeenCalled();
    expect(commands[1]).toHaveBeenCalledOnce();
  } finally {
    await manager.stopChannel(channelId);
  }
  expect(stops).toEqual([1, 2]);
  expect(fixture.registryOwner.registry.httpRoutes).toEqual([]);
}

export async function verifyColdAccountReplacement(createRecoveryFixture: RecoveryFixtureFactory) {
  const channelId = "cold-account-reload";
  const starts: string[] = [];
  const fixture = await createRecoveryFixture({
    abortOnCandidateStart: false,
    registerFirst(api) {
      registerReloadChannel(api, {
        id: channelId,
        config: { listAccountIds: () => ["healthy", "cold"] },
        startAccount: async ({ accountId, abortSignal }) => {
          starts.push(accountId);
          await waitForChannelAbort(abortSignal);
        },
      });
    },
  });
  const manager = createRecoveryChannelManager(fixture);
  fixture.runtime.channelManager = manager;
  setActiveDegradedSecretOwners([
    {
      ownerKind: "account",
      ownerId: `${channelId}:cold`,
      state: "unavailable",
      degradationState: "cold",
      paths: [`channels.${channelId}.accounts.cold.token`],
      refKeys: ["env:default:MISSING_CHANNEL_TOKEN"],
      reason: "secret reference was not found",
    },
  ]);
  try {
    await manager.startChannel(channelId, "healthy");
    await expect(fixture.reload()).resolves.toMatchObject(firstReloaded);
    expect(starts).toEqual(["healthy", "healthy"]);
    expect(manager.getRuntimeSnapshot().channelAccounts[channelId]).toMatchObject({
      healthy: { running: true },
      cold: { running: false, lastError: expect.stringContaining("configured but unavailable") },
    });
    await expect(manager.startChannel(channelId, "cold", { manual: true })).rejects.toMatchObject({
      code: "SECRET_SURFACE_UNAVAILABLE",
      ownerId: `${channelId}:cold`,
    });
  } finally {
    setActiveDegradedSecretOwners([]);
    await manager.stopChannel(channelId);
  }
}

export async function verifyChannelCleanupFailureFence(
  createRecoveryFixture: RecoveryFixtureFactory,
  failure: "rejection" | "timeout",
) {
  const stopGate = heldWork();
  const gatewayStart = vi.fn();
  let cleanupAllowed = false;
  const stopAccount = vi.fn(async () => {
    stopGate.enter();
    if (!cleanupAllowed) {
      if (failure === "rejection") {
        throw new Error("channel cleanup refused");
      }
      await stopGate.wait;
    }
  });
  const { fixture, manager, signals } = await createCleanupChannels(
    createRecoveryFixture,
    (api) => api.on("gateway_start", gatewayStart),
    stopAccount,
  );
  const first = getPluginInstance(fixture.previousRegistry.plugins[0]!);
  const sibling = getPluginInstance(fixture.previousRegistry.plugins[1]!);
  assert(first && sibling);
  vi.useFakeTimers();
  const reloading = fixture.reload().catch((error: unknown) => error);
  try {
    await stopGate.entered;
    await vi.advanceTimersByTimeAsync(5_000);
    if (failure === "timeout") {
      // A timed-out stop still owns its resources. Let it finish while automatic
      // recovery waits, before the fresh old registration can acquire them.
      cleanupAllowed = true;
      stopGate.release();
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(await reloading).toMatchObject({
      details: { phase: "drain", committed: false, pluginIds: ["first"] },
    });
    expect(fixture.registryOwner.registry).toBe(fixture.previousRegistry);
    expect(() => first.run(() => "must remain fenced")).toThrow("reloaded or disabled");
    expect(fixture.firstStart).toHaveBeenCalledOnce();
    expect(fixture.candidates).toHaveLength(0);
    expect(stopAccount).toHaveBeenCalledOnce();
    expect(signals.first[0]?.aborted).toBe(true);
    expect(sibling.run(() => "still live")).toBe("still live");

    cleanupAllowed = true;
    stopGate.release();
    await vi.advanceTimersByTimeAsync(0);
    expect(signals.first).toHaveLength(1);
    expect(gatewayStart).not.toHaveBeenCalled();
    expect(signals.sibling).toMatchObject([{ aborted: false }]);
    expect(() => first.run(() => "still retired")).toThrow("reloaded or disabled");
  } finally {
    cleanupAllowed = true;
    stopGate.release();
    await reloading;
    await manager.stopChannel("cleanup-first");
    await manager.stopChannel("cleanup-sibling");
    vi.useRealTimers();
  }
}
