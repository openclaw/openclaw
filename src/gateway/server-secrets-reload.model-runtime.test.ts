import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { getRuntimeAuthProfileStoreCredentialsRevision } from "../agents/auth-profiles/runtime-snapshots.js";
import { makeModel } from "../agents/embedded-agent-runner/model.test-harness.js";
import * as providerCatalog from "../agents/models-config.providers.implicit.js";
import { getPublishedPreparedModelCatalogOwnerSnapshot } from "../agents/prepared-model-catalog.js";
import {
  prepareModelRuntimeSnapshot,
  refreshPreparedModelRuntimeSnapshots,
} from "../agents/prepared-model-runtime.js";
import { resetPreparedModelRuntimeSnapshotsForTest } from "../agents/prepared-model-runtime.test-support.js";
import { writeConfigFile } from "../config/config.js";
import {
  getRuntimeConfigSnapshot,
  getRuntimeConfigSourceSnapshot,
} from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  activateSecretsRuntimeSnapshotWithSource,
  clearSecretsRuntimeSnapshot,
  prepareSecretsRuntimeSnapshot,
} from "../secrets/runtime.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { buildGatewayReloadPlan } from "./config-reload-plan.js";
import type { GatewayReloadHandlerParams } from "./server-reload-contracts.js";
import { createDefaultGatewayReloadState } from "./server-reload-handlers.config.test-support.js";
import { createGatewayReloadHandlers } from "./server-reload-hot.js";
import { createGatewaySecretsReloader } from "./server-secrets-reload.js";
import {
  enforceSharedGatewaySessionGenerationForConfigWrite,
  SharedGatewaySessionGenerationState,
  type SharedGatewayAuthClient,
} from "./server-shared-auth-generation.js";
import { createRuntimeSecretsActivator } from "./server-startup-config.js";
import {
  hasCurrentGatewayPolicyClientSource,
  onGatewayPolicyClientInvalidated,
} from "./server/ws-policy-close.js";

let state: OpenClawTestState;
const recoveredRef = { source: "env", provider: "default", id: "TEST_RELOADED_MODEL_KEY" } as const;

function sourceConfig() {
  return {
    plugins: { enabled: false },
    agents: {
      defaults: { workspace: state.workspaceDir, model: { primary: "healthy-fixture/model" } },
    },
    models: {
      providers: {
        "healthy-fixture": {
          baseUrl: "https://healthy.example/v1",
          api: "openai-completions",
          apiKey: "healthy-fixture-key",
          models: [makeModel("model")],
        },
        "recoverable-fixture": {
          baseUrl: "https://recoverable.example/v1",
          api: "openai-completions",
          apiKey: recoveredRef,
          models: [],
        },
      },
    },
  } satisfies OpenClawConfig;
}

function requireRuntimeConfig(): OpenClawConfig {
  const config = getRuntimeConfigSnapshot();
  if (!config) {
    throw new Error("Expected active runtime config");
  }
  return config;
}

function publishedCatalog() {
  return getPublishedPreparedModelCatalogOwnerSnapshot({
    config: requireRuntimeConfig(),
    agentId: "main",
  });
}

function prepareRuntime(config = requireRuntimeConfig()) {
  return prepareModelRuntimeSnapshot({ config, agentId: "main", agentDir: state.agentDir() });
}

const recoveredKey = (config?: OpenClawConfig | null) =>
  config?.models?.providers?.["recoverable-fixture"]?.apiKey;

function sharedClient(generation = "initial"): SharedGatewayAuthClient {
  return {
    usesSharedGatewayAuth: true,
    sharedGatewaySessionGeneration: generation,
    socket: { close: vi.fn() },
  };
}

function pauseCatalog(phase: "candidate" | "restoration" = "candidate") {
  const started = createDeferred();
  const release = createDeferred();
  const prepare = providerCatalog.prepareImplicitProviderStaticCatalog;
  const hook = vi.spyOn(providerCatalog, "prepareImplicitProviderStaticCatalog");
  if (phase === "restoration") {
    hook.mockRejectedValueOnce(new Error("catalog build failed"));
  }
  hook.mockImplementationOnce(async (...args) => {
    started.resolve();
    await release.promise;
    return await prepare(...args);
  });
  return { started, release, hook, prepare };
}

async function expectBeforeSettlement(started: Promise<unknown>, pending: Promise<unknown>) {
  expect(await Promise.race([started.then(() => "started"), pending.then(() => "settled")])).toBe(
    "started",
  );
}

beforeEach(async () => {
  await resetPreparedModelRuntimeSnapshotsForTest();
  clearSecretsRuntimeSnapshot();
  state = await createOpenClawTestState({ label: "secrets-model-publication" });
  vi.stubEnv("TEST_RELOADED_MODEL_KEY", undefined);
  await state.writeAuthProfiles({ version: 1, profiles: {} });
});

afterEach(async () => {
  await resetPreparedModelRuntimeSnapshotsForTest();
  clearSecretsRuntimeSnapshot();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await state.cleanup();
});

async function coldRuntime(clients: SharedGatewayAuthClient[] = []) {
  const config = sourceConfig();
  await state.writeConfig(config);
  const runtimeConfig: OpenClawConfig = structuredClone(config);
  runtimeConfig.models!.providers!["healthy-fixture"]!.models[0]!.compat = { supportsStore: false };
  const initial = await prepareSecretsRuntimeSnapshot({
    config: runtimeConfig,
    allowUnavailableSecretOwners: true,
  });
  expect(initial.degradedOwners).toContainEqual(
    expect.objectContaining({
      ownerKind: "provider",
      ownerId: "recoverable-fixture",
      degradationState: "cold",
    }),
  );
  activateSecretsRuntimeSnapshotWithSource(initial, config);
  await refreshPreparedModelRuntimeSnapshots(requireRuntimeConfig(), {
    catalogMode: "static",
    gatewayLifecycle: true,
  });
  expect(recoveredKey(publishedCatalog()?.config)).toEqual(recoveredRef);
  const generationState = new SharedGatewaySessionGenerationState({
    current: "initial",
    required: null,
  });
  const activator = createRuntimeSecretsActivator({
    logSecrets: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    emitStateEvent: vi.fn(),
  });
  const reload = createGatewaySecretsReloader({
    activateRuntimeSecrets: activator,
    sharedGatewaySessionGenerationState: generationState,
    resolveSharedGatewaySessionGenerationForConfig: () => "reloaded",
    clients,
    channelManager: {
      startChannel: async () => new Map(),
      stopChannel: async () => {},
      isManuallyStopped: () => false,
      resolveRuntimeAccountId: (_channel, accountId) => accountId,
    },
    logChannels: { info: vi.fn() },
  });
  vi.stubEnv("TEST_RELOADED_MODEL_KEY", "recovered-fixture-key");
  return { config, generationState, reload, activator };
}

function hotReloadRuntime() {
  let runtimeState: ReturnType<GatewayReloadHandlerParams["getState"]> =
    createDefaultGatewayReloadState();
  const requestRecoveryRestart = vi.fn(() => ({ status: "emitted" as const }));
  const handlers = createGatewayReloadHandlers({
    scheduler: createTestGatewayScheduler(),
    deps: {} as GatewayReloadHandlerParams["deps"],
    broadcast: vi.fn(),
    getState: () => runtimeState,
    setState: (next) => {
      runtimeState = next;
    },
    getPluginRegistry: vi.fn<GatewayReloadHandlerParams["getPluginRegistry"]>(),
    startChannel: vi.fn(async () => new Map()),
    stopChannel: vi.fn(async () => {}),
    releaseChannelRouteHandoffs: vi.fn(),
    pruneInactiveChannelAccountState: vi.fn(),
    reloadPlugins: vi.fn(async () => {
      throw new Error("Unexpected plugin reload in model publication test");
    }),
    logHooks: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    logChannels: { info: vi.fn(), error: vi.fn() },
    logCron: { error: vi.fn() },
    logReload: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    cronReconciliation: {
      arm: vi.fn(() => ({ complete: vi.fn(async () => {}) })),
      invalidate: vi.fn(),
    },
    requestRecoveryRestart,
  });
  return { handlers, requestRecoveryRestart };
}

describe("secret reload model-runtime publication", () => {
  it.each(["successful", "failed"] as const)(
    "joins a delayed %s secrets publication during a committed config reload",
    async (outcome) => {
      const client = sharedClient();
      const { config, reload, activator } = await coldRuntime([client]);
      const next = structuredClone(config);
      next.agents.defaults.model.primary = "healthy-fixture/replacement";
      next.models.providers["healthy-fixture"].models.push({
        ...next.models.providers["healthy-fixture"].models[0]!,
        id: "replacement",
      });
      await writeConfigFile(next);
      const canonicalSource = getRuntimeConfigSourceSnapshot();
      expect(canonicalSource?.agents?.defaults?.model).toEqual(next.agents.defaults.model);
      expect(recoveredKey(canonicalSource)).toEqual(recoveredRef);
      const configRuntime = requireRuntimeConfig();
      const { handlers, requestRecoveryRestart } = hotReloadRuntime();
      const { started, release, hook, prepare } = pauseCatalog();
      const successorStarted = createDeferred();
      const releaseSuccessor = createDeferred();
      const secretsActivated = createDeferred();
      hook.mockImplementationOnce(async (...args) => {
        const catalog = await prepare(...args);
        successorStarted.resolve();
        await releaseSuccessor.promise;
        if (outcome === "failed") {
          throw new Error("successor catalog build failed");
        }
        return catalog;
      });
      const activate = activator.activatePreparedSnapshotIfCurrent!;
      activator.activatePreparedSnapshotIfCurrent = async (...args) => {
        const activated = await activate(...args);
        if (activated) {
          secretsActivated.resolve();
        }
        return activated;
      };
      const hotReload = handlers.applyHotReload(
        buildGatewayReloadPlan([
          "agents.defaults.model",
          "models.providers.healthy-fixture.models",
        ]),
        configRuntime,
      );
      let hotReloadSettled = false;
      const settle = () => {
        hotReloadSettled = true;
      };
      void hotReload.then(settle, settle);
      let secretsReload: ReturnType<typeof reload> | undefined;
      try {
        await expectBeforeSettlement(started.promise, hotReload);
        vi.stubEnv("TEST_RELOADED_MODEL_KEY", "rotated-fixture-key");
        secretsReload = reload();
        void secretsReload.catch(() => undefined);
        await expectBeforeSettlement(secretsActivated.promise, secretsReload);
        expect(client.socket.close).toHaveBeenCalledWith(4001, "gateway auth changed");
        expect(publishedCatalog()).toBeUndefined();

        release.resolve();
        await expectBeforeSettlement(successorStarted.promise, secretsReload);
        expect(hotReloadSettled).toBe(false);
        expect(publishedCatalog()).toBeUndefined();

        releaseSuccessor.resolve();
        if (outcome === "failed") {
          await expect(secretsReload).rejects.toThrow("successor catalog build failed");
          await expect(hotReload).resolves.toBe("applied-restart-required");
          expect(requestRecoveryRestart).toHaveBeenCalledOnce();
        } else {
          await expect(secretsReload).resolves.toEqual({ warningCount: 0 });
          await expect(hotReload).resolves.toBe("applied");
          expect(requestRecoveryRestart).not.toHaveBeenCalled();
        }
        expect(getRuntimeConfigSourceSnapshot()).toEqual(canonicalSource);
        const current = requireRuntimeConfig();
        const published = await prepareRuntime(current);
        expect(published.config).toBe(current);
        expect(published.config.agents?.defaults?.model).toEqual(next.agents.defaults.model);
        expect(recoveredKey(published.config)).toBe("rotated-fixture-key");
      } finally {
        release.resolve();
        releaseSuccessor.resolve();
        await Promise.allSettled([hotReload, secretsReload]);
        handlers.stopRestartRetries();
      }
    },
  );

  it("publishes recovered config refs to the model owner without an auth-profile mutation", async () => {
    const { config, reload } = await coldRuntime();
    const authRevision = getRuntimeAuthProfileStoreCredentialsRevision();

    await reload();

    expect(getRuntimeConfigSourceSnapshot()).toEqual(config);
    expect(getRuntimeAuthProfileStoreCredentialsRevision()).toBe(authRevision);
    expect(recoveredKey(requireRuntimeConfig())).toBe("recovered-fixture-key");
    expect(recoveredKey(publishedCatalog()?.config)).toBe("recovered-fixture-key");
  });

  it("restores the authoritative runtime model config after a publication failure", async () => {
    const client = sharedClient();
    const { config, generationState, reload } = await coldRuntime([client]);
    const source = new AbortController();
    const revoke = () => source.abort();
    const unsubscribeClient = onGatewayPolicyClientInvalidated(client, revoke);
    const unsubscribeGeneration = generationState.onInvalidated("initial", revoke);
    vi.spyOn(providerCatalog, "prepareImplicitProviderStaticCatalog").mockRejectedValueOnce(
      new Error("catalog build failed"),
    );

    try {
      await expect(reload()).rejects.toThrow("catalog build failed");

      expect(client.invalidated).toBe(true);
      expect(source.signal.aborted).toBe(false);
      expect(hasCurrentGatewayPolicyClientSource(client)).toBe(true);
      expect(getRuntimeConfigSourceSnapshot()).toEqual(config);
      const current = requireRuntimeConfig();
      const published = await prepareRuntime(current);
      expect(published.config).toBe(current);
      // The canonical restore retains this now-resolved Ref, rather than the cold predecessor bytes.
      expect(recoveredKey(current)).toBe("recovered-fixture-key");
    } finally {
      unsubscribeClient();
      unsubscribeGeneration?.();
    }
  });

  it("observes model rejection when activation throws after starting publication", async () => {
    const { reload, activator } = await coldRuntime();
    const activate = activator.activatePreparedSnapshotIfCurrent;
    const buildStarted = createDeferred();
    activator.activatePreparedSnapshotIfCurrent = async (...args) => {
      await activate(...args);
      await buildStarted.promise;
      throw new Error("post-activation failure");
    };
    vi.spyOn(providerCatalog, "prepareImplicitProviderStaticCatalog").mockImplementationOnce(
      async () => {
        buildStarted.resolve();
        throw new Error("catalog build failed");
      },
    );

    await expect(reload()).rejects.toThrow("post-activation failure");
    const config = requireRuntimeConfig();
    expect((await prepareRuntime(config)).config).toBe(config);
  });

  it.each(["candidate", "restoration"] as const)(
    "fences stale shared-auth sockets before awaited %s publication without revoking the committed source",
    async (phase) => {
      const client = sharedClient(phase === "candidate" ? "initial" : "reloaded");
      const { generationState, reload } = await coldRuntime([client]);
      const source = new AbortController();
      const unsubscribe = generationState.onInvalidated("initial", () => source.abort());
      const { started, release } = pauseCatalog(phase);
      const pending = reload().catch(() => undefined);
      try {
        await started.promise;
        expect(client.socket.close).toHaveBeenCalledWith(4001, "gateway auth changed");
        expect(source.signal.aborted).toBe(false);
      } finally {
        release.resolve();
        await pending;
        unsubscribe?.();
      }
      expect(source.signal.aborted).toBe(phase === "candidate");
    },
  );

  it.each(["candidate", "restoration"] as const)(
    "preserves a newer config write during awaited %s publication",
    async (phase) => {
      const { config, generationState, reload } = await coldRuntime();
      const { started, release } = pauseCatalog(phase);
      const oldReload = reload().then(
        () => ({ ok: true }),
        (error: unknown) => ({ error }),
      );
      let nextPublication: Promise<void> | undefined;
      try {
        await started.promise;
        const next = structuredClone(config);
        next.models.providers["recoverable-fixture"].baseUrl = "https://newer.example/v1";
        await writeConfigFile(next);
        const current = requireRuntimeConfig();
        expect(current.models?.providers?.["recoverable-fixture"]?.baseUrl).toBe(
          "https://newer.example/v1",
        );
        enforceSharedGatewaySessionGenerationForConfigWrite({
          state: generationState,
          nextConfig: current,
          resolveRuntimeSnapshotGeneration: () => "newer",
          clients: [],
        });
        nextPublication = refreshPreparedModelRuntimeSnapshots(current, { catalogMode: "static" });
        const reader = prepareRuntime(current);
        release.resolve();
        expect(await oldReload).toMatchObject({ error: expect.any(Error) });
        await nextPublication;
        expect((await reader).config).toBe(current);
        expect(requireRuntimeConfig()).toBe(current);
        expect(getRuntimeConfigSourceSnapshot()?.models).toEqual(next.models);
        expect({ current: generationState.current, required: generationState.required }).toEqual({
          current: "newer",
          required: null,
        });
      } finally {
        release.resolve();
        await Promise.allSettled([oldReload, nextPublication]);
      }
    },
  );
});
