import assert from "node:assert/strict";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { expect, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../config/io.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createSubsystemLogger, type SubsystemLogger } from "../logging/subsystem.js";
import { adoptPluginHttpRouteHandoffs, registerPluginHttpRoute } from "../plugins/http-registry.js";
import { activatePluginRegistry } from "../plugins/loader-shared.js";
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
import {
  createPluginRegistryOwner,
  disposePluginRegistryInstances,
  setActivePluginRegistry,
} from "../plugins/runtime.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import type { PluginRuntime } from "../plugins/runtime/types.js";
import { startPluginServices, type PluginServicesHandle } from "../plugins/services.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import type { OpenClawPluginApi } from "../plugins/types.js";
import { setActiveDegradedSecretOwners } from "../secrets/runtime-degraded-state.js";
import { createDeferredCore } from "../shared/deferred.js";
import { createChannelTestPluginBase } from "../test-utils/channel-plugins.js";
import { createChannelManager } from "./server-channels.js";
import { reloadGatewayPlugins } from "./server-plugin-reload.js";
import { createGatewayPluginRuntimeGeneration } from "./server-plugin-runtime-generation.js";
import { createGatewaySidecarStopOwner } from "./server-sidecar-owners.js";
import type { GatewayPostReadySidecarHandle } from "./server-startup-post-attach.js";

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
      owner: "first" | "sibling",
      record: ReturnType<typeof createPluginRecord>,
    ) => void;
    abortOnCandidateStart?: boolean;
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
  } = {},
) {
  let config: OpenClawConfig = options.config ?? {
    plugins: { allow: ["first", "sibling"] },
  };
  setRuntimeConfigSnapshot(config);
  const log = { ...createSubsystemLogger("gateway/plugins"), ...logMocks };
  const createBuilder = () =>
    createPluginRegistry({
      logger: log,
      runtime: {} as PluginRuntime,
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
  const firstRecord = createPluginRecord({ id: "first" });
  previous.registry.plugins.push(firstRecord);
  const firstApi = previous.createApi(firstRecord, { config });
  options.register?.(firstApi, "first", firstRecord);
  firstApi.registerService({
    id: "first",
    start: firstStart,
    stop: firstStop,
  });
  const siblingStart = vi.fn();
  const siblingStop = vi.fn();
  const siblingRecord = createPluginRecord({ id: "sibling" });
  previous.registry.plugins.push(siblingRecord);
  const siblingApi = previous.createApi(siblingRecord, { config });
  options.register?.(siblingApi, "sibling", siblingRecord);
  siblingApi.registerService({
    id: "sibling",
    start: siblingStart,
    stop: siblingStop,
  });
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
  const candidates: ReturnType<typeof createBuilder>[] = [];
  const preparePlugins = ({
    cfg,
    replacePluginIds = new Set<string>(),
  }: {
    cfg: OpenClawConfig;
    replacePluginIds?: ReadonlySet<string>;
  }) => {
    const candidate = createBuilder();
    candidates.push(candidate);
    if (!replacePluginIds.has("first")) {
      const retained = registryOwner.registry.plugins.find((record) => record.id === "first");
      assert(retained);
      candidate.registry.plugins.push(retained);
      projectPluginContributions(registryOwner.registry, retained, candidate.registry);
    } else if (cfg.plugins?.entries?.first?.enabled !== false) {
      const record = createPluginRecord({ id: "first" });
      candidate.registry.plugins.push(record);
      const api = candidate.createApi(record, { config: cfg });
      options.register?.(api, "first", record);
      api.registerService({
        id: "first",
        start: () => {
          aborted = options.abortOnCandidateStart !== false;
          options.candidateStart?.();
        },
        stop: async () => await candidateStop(),
      });
    }
    if (replacePluginIds.has("sibling")) {
      const record = createPluginRecord({ id: "sibling" });
      candidate.registry.plugins.push(record);
      const api = candidate.createApi(record, { config: cfg });
      options.register?.(api, "sibling", record);
      api.registerService({ id: "sibling", start: siblingStart, stop: siblingStop });
    } else {
      const retained = registryOwner.registry.plugins.find((record) => record.id === "sibling");
      assert(retained);
      candidate.registry.plugins.push(retained);
      projectPluginContributions(registryOwner.registry, retained, candidate.registry);
    }
    return {
      pluginRegistry: candidate.registry,
      resolvedConfig: cfg,
      gatewayMethods: [],
      retireGatewayRuntimeBindings: vi.fn(),
    };
  };
  let gatewayLifetimeSidecars: GatewayPostReadySidecarHandle[] = [];
  const lifetime = createGatewaySidecarStopOwner({
    getRegistered: () => gatewayLifetimeSidecars,
    setRegistered: (next) => {
      gatewayLifetimeSidecars = next;
    },
  });
  const metadata = retainGatewayPluginMetadata();
  const snapshot =
    options.pluginMetadataSnapshot ??
    createPluginMetadataSnapshotFixture({ plugins: [{ id: "first" }, { id: "sibling" }] });
  metadata.publish(snapshot);
  const runtime = {
    pluginMetadataSnapshot: snapshot,
    pluginRuntime: registryOwner,
    kernel: {
      pluginRuntimeGeneration: owner,
      pluginMetadata: metadata,
      getCronService: () => runtime.runtimeState.cronState.cron,
    },
    runtimeState: {
      cronState: {},
      get gatewayLifetimeSidecars() {
        return gatewayLifetimeSidecars;
      },
      set gatewayLifetimeSidecars(next: GatewayPostReadySidecarHandle[]) {
        gatewayLifetimeSidecars = next;
      },
      postReadySidecars: [],
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
    await currentServices?.stop().catch(() => {});
    await initial.stop().catch(() => {});
    const retirementFailure = await lifetime.stop().catch((error: unknown) => error);
    await registryOwner.close();
    await metadata.close();
    for (const candidate of candidates) {
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
          prepareAttachedPluginRuntime: async (candidate) => {
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
          prepareConfigEffects: options.prepareConfigEffects ?? (() => {}),
          pluginLifecycle: {
            reason: "reload",
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
          isAborted: () => aborted,
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
    candidates,
    lifetime,
  };
}

export type RecoveryFixtureFactory = (
  options?: Parameters<typeof createPluginReloadRecoveryFixture>[1],
) => ReturnType<typeof createPluginReloadRecoveryFixture>;

export function createRecoveryChannelManager(fixture: Awaited<ReturnType<RecoveryFixtureFactory>>) {
  return createChannelManager({
    getRuntimeConfig: fixture.getConfig,
    getPluginRegistry: () => fixture.registryOwner.registry,
    channelLogs: {},
    channelRuntimeEnvs: {},
  });
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
  const reject = async () => {
    throw failure;
  };
  const fixture = await createRecoveryFixture({
    abortOnCandidateStart: false,
    ...(boundary === "prepare" ? { prepareAttached: reject } : { afterPublish: reject }),
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
      const request = new IncomingMessage(new Socket());
      const response = new ServerResponse(request);
      const end = vi.spyOn(response, "end").mockReturnValue(response);
      try {
        await route.handler(request, response);
        expect(response.statusCode).toBe(503);
        expect(response.getHeader("Retry-After")).toBe("1");
        expect(end).toHaveBeenCalledWith("plugin route is restarting; retry");
        expect(starts).toEqual([1]);
        expect(stops).toEqual([1]);
      } finally {
        request.destroy();
        response.destroy();
      }
    },
    register(api, owner) {
      if (owner !== "first") {
        return;
      }
      const generation = ++registrations;
      const handler = vi.fn(async () => ({ text: `generation ${generation}` }));
      commands.push(handler);
      api.registerCommand({
        name: "refresh",
        description: "Refresh",
        channels: [channelId],
        handler,
      });
      api.registerChannel({
        plugin: {
          ...createChannelTestPluginBase({ id: channelId }),
          gateway: {
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
                await new Promise<void>((resolve) => {
                  if (abortSignal.aborted) {
                    resolve();
                    return;
                  }
                  abortSignal.addEventListener("abort", () => resolve(), { once: true });
                });
              } finally {
                unregister();
              }
            },
            stopAccount: async () => {
              stops.push(generation);
            },
          },
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
    register(api, owner) {
      if (owner !== "first") {
        return;
      }
      api.registerChannel({
        plugin: {
          ...createChannelTestPluginBase({
            id: channelId,
            config: { listAccountIds: () => ["healthy", "cold"] },
          }),
          gateway: {
            startAccount: async ({ accountId, abortSignal }) => {
              starts.push(accountId);
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
    await expect(fixture.reload()).resolves.toMatchObject({ runtime: { pluginIds: ["first"] } });
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
  const stopEntered = createDeferredCore();
  const releaseStop = createDeferredCore();
  const gatewayStart = vi.fn();
  const signals = { first: [] as AbortSignal[], sibling: [] as AbortSignal[] };
  let cleanupAllowed = false;
  const stopAccount = vi.fn(async () => {
    stopEntered.resolve();
    if (!cleanupAllowed) {
      if (failure === "rejection") {
        throw new Error("channel cleanup refused");
      }
      await releaseStop.promise;
    }
  });
  const fixture = await createRecoveryFixture({
    abortOnCandidateStart: false,
    register(api, owner) {
      if (owner === "first") {
        api.on("gateway_start", gatewayStart);
      }
      api.registerChannel({
        plugin: {
          ...createChannelTestPluginBase({ id: `cleanup-${owner}` }),
          gateway: {
            startAccount: async ({ abortSignal }) => {
              signals[owner].push(abortSignal);
              await new Promise<void>((resolve) => {
                if (abortSignal.aborted) {
                  resolve();
                  return;
                }
                abortSignal.addEventListener("abort", () => resolve(), { once: true });
              });
            },
            ...(owner === "first" ? { stopAccount } : {}),
          },
        },
      });
    },
  });
  const manager = createRecoveryChannelManager(fixture);
  fixture.runtime.channelManager = manager;
  await manager.startChannel("cleanup-first");
  await manager.startChannel("cleanup-sibling");
  await vi.waitFor(() => {
    expect(signals.first).toHaveLength(1);
    expect(signals.sibling).toHaveLength(1);
  });
  const first = getPluginInstance(fixture.previousRegistry.plugins[0]!);
  const sibling = getPluginInstance(fixture.previousRegistry.plugins[1]!);
  assert(first && sibling);
  vi.useFakeTimers();
  const reloading = fixture.reload().catch((error: unknown) => error);
  try {
    await stopEntered.promise;
    await vi.advanceTimersByTimeAsync(5_000);
    if (failure === "timeout") {
      // The admitted stop callback also reaches the instance drain and disposal deadlines.
      await vi.advanceTimersByTimeAsync(10_000);
    }
    expect(await reloading).toMatchObject({
      runtime: {
        pluginIds: ["first"],
        warnings: expect.arrayContaining([
          expect.stringContaining("Plugin channel cleanup-first cleanup failed"),
        ]),
      },
    });
    expect(fixture.registryOwner.registry).not.toBe(fixture.previousRegistry);
    expect(() => first.run(() => "must remain fenced")).toThrow("reloaded or disabled");
    expect(gatewayStart).toHaveBeenCalledOnce();
    expect(fixture.firstStart).toHaveBeenCalledOnce();
    expect(stopAccount).toHaveBeenCalledOnce();
    expect(signals.first).toHaveLength(2);
    expect(signals.first[0]?.aborted).toBe(true);
    expect(signals.first[1]?.aborted).toBe(false);
    expect(sibling.run(() => "still live")).toBe("still live");
    expect(signals.sibling).toHaveLength(1);
    expect(signals.sibling[0]?.aborted).toBe(false);

    cleanupAllowed = true;
    releaseStop.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(signals.first).toHaveLength(2);
    expect(signals.first[1]?.aborted).toBe(false);
    await fixture.reload();
    expect(signals.first).toHaveLength(3);
    expect(signals.first[1]?.aborted).toBe(true);
    expect(signals.first[2]?.aborted).toBe(false);
    expect(gatewayStart).toHaveBeenCalledTimes(2);
    expect(signals.sibling).toHaveLength(1);
    expect(signals.sibling[0]?.aborted).toBe(false);
    expect(() => first.run(() => "still retired")).toThrow("reloaded or disabled");
  } finally {
    cleanupAllowed = true;
    releaseStop.resolve();
    await reloading;
    await manager.stopChannel("cleanup-first");
    await manager.stopChannel("cleanup-sibling");
    vi.useRealTimers();
  }
}
