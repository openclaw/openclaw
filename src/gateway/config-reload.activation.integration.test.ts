// Keep provider/model dependencies controlled while exercising the real config reloader.
// oxfmt-ignore
import { cleanupPreparedModelRuntimeHarness, getPreparedModelRuntimeMocks, resetPreparedModelRuntimeHarness } from "../agents/prepared-model-runtime.test-harness.js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { resolveApiKeyForProfile } from "../agents/auth-profiles/oauth.js";
import { runtimeAuthProfileRowsCache } from "../agents/auth-profiles/runtime-snapshots.js";
import { loadAuthProfileStoreWithoutExternalProfiles } from "../agents/auth-profiles/store-runtime.js";
import * as authProfileStore from "../agents/auth-profiles/store.js";
import type { AuthProfileCredential } from "../agents/auth-profiles/types.js";
import {
  prepareModelRuntimeSnapshot,
  refreshPreparedModelRuntimeSnapshots,
} from "../agents/prepared-model-runtime.js";
import {
  readConfigFileSnapshot,
  registerConfigWriteListener,
  transformConfigFileWithRetry,
} from "../config/config.js";
import { resolveAgentModelPrimaryValue } from "../config/model-input.js";
import {
  createRuntimeConfigWriteApplication,
  getRuntimeConfigWriteApplication,
} from "../config/runtime-write-application.js";
import * as configFileSource from "../config/source-file.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { bindPluginMetadataSnapshotCache } from "../plugins/plugin-cache.js";
import { activateSavedSetupCredential } from "../system-agent/setup-inference-credential-access.js";
import {
  captureSetupInferenceFileUndo,
  commitSetupInferenceActivation,
  type SetupInferenceConfigTarget,
} from "../system-agent/setup-inference-transition.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { startGatewayConfigReloader } from "./config-reload.js";
import { createWatcherMock } from "./config-reload.watcher.test-support.js";

let state: OpenClawTestState;
beforeEach(async () => {
  state = await createOpenClawTestState({ label: "activation-reloader" });
  await resetPreparedModelRuntimeHarness(state);
  bindPluginMetadataSnapshotCache(getPreparedModelRuntimeMocks().pluginMetadataSnapshot);
  getPreparedModelRuntimeMocks().configuredAgentIds = ["default"];
  getPreparedModelRuntimeMocks().configuredWorkspaces.set("default", state.workspaceDir);
});
afterEach(async ({ task }) => {
  await cleanupPreparedModelRuntimeHarness(state, task.result?.state === "fail");
});

it("the real reloader restores the working connection after failed credential activation", async () => {
  const previous: OpenClawConfig = {
    gateway: { mode: "local" },
    plugins: { slots: { memory: "none" } },
    models: {
      providers: {
        openai: {
          baseUrl: "https://fixture.invalid/v1",
          api: "openai-responses",
          apiKey: "fixture-key",
          models: ["working", "verified"].map((id) => ({
            id: "fixture-" + id,
            name: id,
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 128000,
            maxTokens: 4096,
            compat: { supportsTools: true },
          })),
        },
      },
    },
    agents: {
      entries: { default: {} },
      defaults: { workspace: state.workspaceDir, model: "openai/fixture-working" },
    },
  };
  const candidate = {
    ...previous,
    agents: {
      ...previous.agents,
      defaults: { ...previous.agents?.defaults, model: "openai/fixture-verified" },
    },
  };
  const profileId = "openai:pending-activation";
  const pendingCredential: AuthProfileCredential = {
    type: "api_key",
    provider: "openai",
    key: "fixture-replacement-key",
    setup: {
      replacement: true,
      modelRef: "openai/fixture-verified",
      configJson: JSON.stringify(candidate),
    },
  };
  await state.writeAuthProfiles(
    { version: 1, profiles: { [profileId]: pendingCredential } },
    "default",
  );
  await state.writeConfig(previous);
  await refreshPreparedModelRuntimeSnapshots(previous);
  const initial = await readConfigFileSnapshot();
  const configFileAdapter = vi
    .spyOn(configFileSource, "createConfigFileAdapter")
    .mockImplementation((options) => {
      const watcher = createWatcherMock();
      const adapter = watcher.attach(options);
      return {
        ...adapter,
        start() {
          adapter.start();
          watcher.emit("ready");
        },
      };
    });
  const applyRuntime: Parameters<typeof startGatewayConfigReloader>[0]["onHotReload"] = async (
    plan,
    config,
    ownership,
  ) => {
    await ownership.checkpoint();
    ownership.publishRuntimeEnv();
    ownership.markRuntimeCommitted(config, plan);
    await refreshPreparedModelRuntimeSnapshots(config);
    return "applied";
  };
  let promotionObserved = false;
  const reloader = startGatewayConfigReloader({
    scheduler: createTestGatewayScheduler("fake-timers"),
    initialConfig: initial.config,
    initialCompareConfig: initial.sourceConfig,
    initialSnapshotRawHash: initial.hash ?? null,
    initialAuthoredConfig: initial.parsed,
    initialSnapshotValid: initial.valid,
    initialSnapshotIssues: initial.issues,
    testDebounceMs: 0,
    readSnapshot: () => readConfigFileSnapshot(),
    watchPath: state.configPath,
    readPluginInstallRecords: async () => ({}),
    initialPluginInstallRecords: {},
    subscribeToWrites: (listener) =>
      registerConfigWriteListener(listener, {
        ownsRuntimeActivationFor: state.configPath,
        preCommitRuntimePreflight: async (sourceConfig) => ({
          runtimeConfig: sourceConfig,
          compareConfig: sourceConfig,
        }),
      }),
    prepareConfigCandidate: async ({ runtimeConfig, sourceConfig }) => {
      if (
        resolveAgentModelPrimaryValue(sourceConfig.agents?.defaults?.model) ===
        "openai/fixture-verified"
      ) {
        expect(
          loadAuthProfileStoreWithoutExternalProfiles(state.agentDir("default")).profiles[
            profileId
          ],
        ).toEqual({ type: "api_key", provider: "openai", key: "fixture-replacement-key" });
        promotionObserved = true;
        throw new Error("fixture candidate runtime preparation failed");
      }
      return { runtimeConfig, compareConfig: sourceConfig };
    },
    onHotReload: applyRuntime,
    onNoopConfigCommit: applyRuntime,
    onRestart: () => {
      throw new Error("fixture route must hot reload");
    },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  });
  const captureEntered = createDeferred();
  const releaseCapture = createDeferred();
  const completion = createDeferred<() => Promise<boolean>>();
  const applied = createDeferred<ReturnType<typeof createRuntimeConfigWriteApplication>>();
  let recoveryApplication: ReturnType<typeof createRuntimeConfigWriteApplication> | undefined;
  // Recovery can read auth before the failed config write returns to its rollback caller.
  const prepareRows = runtimeAuthProfileRowsCache.prepare.bind(runtimeAuthProfileRowsCache);
  const rowRead = vi.spyOn(runtimeAuthProfileRowsCache, "prepare").mockImplementation((...args) => {
    const reader = prepareRows(...args);
    if (!recoveryApplication?.claimed) {
      return reader;
    }
    return {
      ...reader,
      async read() {
        const rows = await reader.read();
        captureEntered.resolve();
        await releaseCapture.promise;
        return rows;
      },
    };
  });
  const restoreAuth = authProfileStore.restoreAuthProfileStorePersistenceSnapshot;
  const rollback = vi
    .spyOn(authProfileStore, "restoreAuthProfileStorePersistenceSnapshot")
    .mockImplementation((...args) => {
      restoreAuth(...args);
      releaseCapture.resolve();
    });
  try {
    await reloader.ready;
    const configTarget: SetupInferenceConfigTarget = {
      read: async () => ({
        config: (await readConfigFileSnapshot()).sourceConfig,
        write: configTarget.write,
      }),
      write: async (_candidate, { writeOptions, captureUndo }) => {
        const application = getRuntimeConfigWriteApplication(writeOptions);
        if (!application) {
          throw new Error("missing activation application");
        }
        applied.resolve(application);
        const result = await transformConfigFileWithRetry({
          base: "source",
          writeOptions,
          transform: (_current, context) => {
            const undo = captureSetupInferenceFileUndo(context.snapshot, candidate);
            captureUndo(async (options) => {
              recoveryApplication = getRuntimeConfigWriteApplication(options);
              const restored = await undo(options);
              await captureEntered.promise;
              return restored;
            });
            return { nextConfig: candidate };
          },
        });
        return result.nextConfig;
      },
    };
    await commitSetupInferenceActivation({
      preserveWorkingConnection: true,
      assertCurrent: () => {},
      activate: () =>
        activateSavedSetupCredential({
          agentDir: state.agentDir("default"),
          profileId,
          credential: pendingCredential,
        }),
      deferCompletion: completion.resolve,
      configTarget,
      config: candidate,
    });
    await expect((await applied.promise).result).resolves.toBe("failed");
    expect(promotionObserved).toBe(true);
    await expect((await completion.promise)()).rejects.toThrow(
      "did not complete activation (failed)",
    );
    const restored = (await readConfigFileSnapshot()).sourceConfig;
    for (const section of ["agents", "models", "gateway", "plugins"] as const) {
      expect(restored[section]).toEqual(previous[section]);
    }
    const store = loadAuthProfileStoreWithoutExternalProfiles(state.agentDir("default"));
    expect(store.profiles[profileId]).toEqual(pendingCredential);
    await expect(
      resolveApiKeyForProfile({
        cfg: restored,
        store,
        profileId,
        agentDir: state.agentDir("default"),
      }),
    ).resolves.toBeNull();
    const normal = await prepareModelRuntimeSnapshot({
      agentId: "default",
      agentDir: state.agentDir("default"),
      inheritedAuthDir: state.agentDir("default"),
      workspaceDir: state.workspaceDir,
      config: restored,
    });
    expect(resolveAgentModelPrimaryValue(normal.config.agents?.defaults?.model)).toBe(
      "openai/fixture-working",
    );
  } finally {
    releaseCapture.resolve();
    try {
      await reloader.stop();
    } finally {
      rowRead.mockRestore();
      rollback.mockRestore();
      configFileAdapter.mockRestore();
    }
  }
});
