// Keep provider/model dependencies controlled while exercising the real config reloader.
// oxfmt-ignore
import { usePreparedModelRuntimeHarness } from "../agents/prepared-model-runtime.test-harness.js";
import { beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { resolveApiKeyForProfile } from "../agents/auth-profiles/oauth.js";
import { runtimeAuthProfileRowsCache } from "../agents/auth-profiles/runtime-persisted-rows.js";
import { loadAuthProfileStoreWithoutExternalProfiles } from "../agents/auth-profiles/store-runtime.js";
import * as authProfileStoreUpdate from "../agents/auth-profiles/store-update.js";
import type { AuthProfileCredential } from "../agents/auth-profiles/types.js";
import {
  prepareModelRuntimeSnapshot,
  refreshPreparedModelRuntimeSnapshots,
} from "../agents/prepared-model-runtime.js";
import { completionModelDefinition } from "../agents/simple-completion.test-support.js";
import { readConfigFileSnapshot, transformConfigFileWithRetry } from "../config/config.js";
import { resolveAgentModelPrimaryValue } from "../config/model-input.js";
import { getRuntimeConfigWriteApplication } from "../config/runtime-write-application.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { bindPluginMetadataSnapshotCache } from "../plugins/plugin-cache.js";
import { activateSavedSetupCredential } from "../system-agent/setup-inference-credential-access.js";
import {
  captureSetupInferenceFileUndo,
  commitSetupInferenceActivation,
  type SetupInferenceConfigTarget,
} from "../system-agent/setup-inference-transition.js";
import { startGatewayConfigReloader } from "./config-reload.js";
import { ownedConfigReloadOptions } from "./config-reload.test-support.js";
import { installWatcherMock } from "./config-reload.watcher.test-support.js";

const harness = usePreparedModelRuntimeHarness({ label: "activation-reloader" });
beforeEach(() => {
  const { state, mocks } = harness;
  bindPluginMetadataSnapshotCache(mocks.pluginMetadataSnapshot);
  mocks.configuredAgentIds = ["default"];
  mocks.configuredWorkspaces.set("default", state.workspaceDir);
});

it("the real reloader restores the working connection after failed credential activation", async () => {
  const { state } = harness;
  const agentDir = state.agentDir("default");
  const previous: OpenClawConfig = {
    gateway: { mode: "local" },
    plugins: { slots: { memory: "none" } },
    models: {
      providers: {
        openai: {
          baseUrl: "https://fixture.invalid/v1",
          api: "openai-responses",
          apiKey: "fixture-key",
          models: ["working", "verified"].map((name) =>
            completionModelDefinition({ id: `fixture-${name}`, name }),
          ),
        },
      },
    },
    agents: {
      entries: { default: {} },
      defaults: { workspace: state.workspaceDir, model: "openai/fixture-working" },
    },
  };
  const candidate = structuredClone(previous);
  candidate.agents!.defaults!.model = "openai/fixture-verified";
  const profileId = "openai:pending-activation";
  const promotedCredential: AuthProfileCredential = {
    type: "api_key",
    provider: "openai",
    key: "fixture-replacement-key",
  };
  const pendingCredential: AuthProfileCredential = {
    ...promotedCredential,
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
  const watcher = installWatcherMock();
  const startWatcher = watcher.adapter.start;
  watcher.adapter.start = vi.fn(async () => {
    await startWatcher();
    watcher.emit("ready");
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
    ...(await ownedConfigReloadOptions(initial, state.configPath)),
    readSnapshot: () => readConfigFileSnapshot(),
    prepareConfigCandidate: async ({ runtimeConfig, sourceConfig }) => {
      if (
        resolveAgentModelPrimaryValue(sourceConfig.agents?.defaults?.model) ===
        "openai/fixture-verified"
      ) {
        expect(loadAuthProfileStoreWithoutExternalProfiles(agentDir).profiles[profileId]).toEqual(
          promotedCredential,
        );
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
  type Application = NonNullable<ReturnType<typeof getRuntimeConfigWriteApplication>>;
  const applied = createDeferred<Application>();
  let recoveryApplication: Application | undefined;
  // Recovery can read auth before the failed config write returns to its rollback caller.
  const prepareRows = runtimeAuthProfileRowsCache.prepare.bind(runtimeAuthProfileRowsCache);
  vi.spyOn(runtimeAuthProfileRowsCache, "prepare").mockImplementation((...args) => {
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
  const updateAuth = authProfileStoreUpdate.runAuthProfileStoreUpdate;
  vi.spyOn(authProfileStoreUpdate, "runAuthProfileStoreUpdate").mockImplementation(
    async (...args) => {
      const result = await updateAuth(...args);
      if (recoveryApplication?.claimed) {
        releaseCapture.resolve();
      }
      return result;
    },
  );
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
          agentDir,
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
    const store = loadAuthProfileStoreWithoutExternalProfiles(agentDir);
    expect(store.profiles[profileId]).toEqual(pendingCredential);
    await expect(
      resolveApiKeyForProfile({ cfg: restored, store, profileId, agentDir }),
    ).resolves.toBeNull();
    const normal = await prepareModelRuntimeSnapshot({
      ...harness.agentInput("default", restored),
      workspaceDir: state.workspaceDir,
    });
    expect(resolveAgentModelPrimaryValue(normal.config.agents?.defaults?.model)).toBe(
      "openai/fixture-working",
    );
  } finally {
    releaseCapture.resolve();
    try {
      await reloader.stop();
    } finally {
      vi.restoreAllMocks();
    }
  }
});
