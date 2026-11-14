import assert from "node:assert/strict";
import { collectNestedErrorCandidates } from "@openclaw/normalization-core/error-coercion";
import { expect, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../config/io.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createSubsystemLogger, type SubsystemLogger } from "../logging/subsystem.js";
import { adoptPluginHttpRouteHandoffs } from "../plugins/http-registry.js";
import { activatePluginRegistry, PluginLoadFailureError } from "../plugins/loader-shared.js";
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
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { pluginInstance } from "./server-plugin-reload.fixture-tools.test-support.js";
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
    generationOverlap?: boolean;
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
    automatic?: boolean;
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
    const record = createPluginRecord({
      id,
      ...(id === "first" ? { generationOverlap: options.generationOverlap } : {}),
    });
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
      const record = createPluginRecord({
        id,
        ...(id === "first" ? { generationOverlap: options.generationOverlap } : {}),
      });
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
              publish: (beforeDispose) => {
                adoptPluginHttpRouteHandoffs(registryOwner.registry, candidate.pluginRegistry);
                activatePluginRegistry(
                  candidate.pluginRegistry,
                  null,
                  "gateway-bindable",
                  undefined,
                  registryOwner.registry,
                  trackActivationCleanup,
                );
                registryOwner.publish(candidate.pluginRegistry, beforeDispose);
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
          pluginLifecycle: options.automatic
            ? undefined
            : {
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
