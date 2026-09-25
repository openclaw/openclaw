// Keep provider/model dependencies controlled while exercising the real config reloader.
// oxfmt-ignore
import { cleanupPreparedModelRuntimeHarness, getPreparedModelRuntimeMocks, resetPreparedModelRuntimeHarness } from "../agents/prepared-model-runtime.test-harness.js";
import fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { resolveApiKeyForProfile } from "../agents/auth-profiles/oauth.js";
import { loadAuthProfileStoreWithoutExternalProfiles } from "../agents/auth-profiles/store-runtime.js";
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
  attachRuntimeConfigWriteApplication,
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
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import {
  startGatewayConfigReloader,
  type GatewayConfigReloadTransactionOwnership,
} from "./config-reload.js";
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
describe("setup activation reload ownership", () => {
  it.each(["superseded", "runtime-failed", "same-source-echo", "changed-source-echo"] as const)(
    "the real reloader preserves the current connection after %s activation",
    async (scenario) => {
      const outcome = scenario === "runtime-failed" ? "runtime-failed" : "superseded";
      const controlledEcho = scenario === "same-source-echo" || scenario === "changed-source-echo";
      const previous: OpenClawConfig = {
        gateway: { mode: "local" },
        plugins: { slots: { memory: "none" } },
        models: {
          providers: {
            openai: {
              baseUrl: "https://fixture.invalid/v1",
              api: "openai-responses",
              apiKey: "fixture-key",
              models: ["working", "verified", "newer"].map((id) => ({
                id: `fixture-${id}`,
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
      const newer = {
        ...previous,
        agents: {
          ...previous.agents,
          defaults: { ...previous.agents?.defaults, model: "openai/fixture-newer" },
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
      if (outcome === "runtime-failed") {
        await state.writeAuthProfiles(
          { version: 1, profiles: { [profileId]: pendingCredential } },
          "default",
        );
      }
      let promotionObserved = false;
      await state.writeConfig(previous);
      await refreshPreparedModelRuntimeSnapshots(previous);
      const initial = await readConfigFileSnapshot();
      const reloadError = vi.fn();
      const createConfigFileAdapter = configFileSource.createConfigFileAdapter;
      let emitConfigChange: (() => void) | undefined;
      const configFileAdapter = vi
        .spyOn(configFileSource, "createConfigFileAdapter")
        .mockImplementation((options) => {
          if (options.path === state.configPath) {
            emitConfigChange = options.onChange;
          }
          // Keep real filesystem observation, including its readiness and path coverage.
          return createConfigFileAdapter(options);
        });
      const watcherReady = createDeferred();
      const captureEntered = createDeferred();
      const releaseCapture = createDeferred();
      const observedDuringCapture = createDeferred();
      const successorApplied = createDeferred();
      let captureHeld = false;
      let currentOwnership: GatewayConfigReloadTransactionOwnership | undefined;
      const applyRuntime: Parameters<typeof startGatewayConfigReloader>[0]["onHotReload"] = async (
        plan,
        config,
        ownership,
      ) => {
        currentOwnership = ownership;
        // Match the managed publisher: commit before the model-rebuild tail.
        await ownership.checkpoint();
        ownership.publishRuntimeEnv();
        ownership.markRuntimeCommitted(config, plan);
        await refreshPreparedModelRuntimeSnapshots(config);
        return "applied";
      };
      const reloader = startGatewayConfigReloader({
        initialConfig: initial.config,
        initialCompareConfig: initial.sourceConfig,
        initialSnapshotRawHash: initial.hash ?? null,
        initialAuthoredConfig: initial.parsed,
        initialSnapshotValid: initial.valid,
        initialSnapshotIssues: initial.issues,
        testDebounceMs: 0,
        onWatcherReady: watcherReady.resolve,
        onConfigCandidateObserved: () => {
          if (captureHeld) {
            observedDuringCapture.resolve();
          }
        },
        onConfigApplied: (_plan, config) => {
          if (
            resolveAgentModelPrimaryValue(config.agents?.defaults?.model) === "openai/fixture-newer"
          ) {
            successorApplied.resolve();
          }
        },
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
            outcome === "runtime-failed" &&
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
        log: { info: vi.fn(), warn: vi.fn(), error: reloadError },
      });
      let echoObserved = false;
      const completion = createDeferred<() => Promise<boolean>>();
      const applied = createDeferred<ReturnType<typeof createRuntimeConfigWriteApplication>>();
      try {
        await reloader.ready;
        if (scenario === "superseded") {
          const notifyConfigChange = emitConfigChange;
          if (!notifyConfigChange) {
            throw new Error("config file adapter was not created");
          }
          // Deliver the writer's source notification during model preparation.
          getPreparedModelRuntimeMocks().discoverModels.mockImplementationOnce(() => {
            notifyConfigChange();
            echoObserved = true;
          });
        }
        if (controlledEcho) {
          await watcherReady.promise;
          getPreparedModelRuntimeMocks().resolveAmbientCredentials.mockImplementationOnce(
            async () => {
              captureHeld = true;
              captureEntered.resolve();
              await releaseCapture.promise;
              captureHeld = false;
              return {};
            },
          );
        }
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
                captureUndo(captureSetupInferenceFileUndo(context.snapshot, candidate));
                return { nextConfig: candidate };
              },
            });
            return result.nextConfig;
          },
        };
        await commitSetupInferenceActivation({
          preserveWorkingConnection: true,
          assertCurrent: () => {},
          activate: async () =>
            outcome === "runtime-failed"
              ? await activateSavedSetupCredential({
                  agentDir: state.agentDir("default"),
                  profileId,
                  credential: pendingCredential,
                })
              : undefined,
          deferCompletion: completion.resolve,
          configTarget,
          config: candidate,
        });
        if (controlledEcho) {
          await Promise.race([
            captureEntered.promise,
            applied.promise.then((application) =>
              application.result.then((status) => {
                throw new Error(`Activation settled before capture barrier: ${status}`);
              }),
            ),
          ]);
          const raw = await fs.readFile(state.configPath, "utf8");
          const nextRaw =
            scenario === "same-source-echo"
              ? raw
              : raw.replace('"openai/fixture-verified"', '"openai/fixture-newer"');
          if (scenario === "changed-source-echo") {
            expect(nextRaw).not.toBe(raw);
          }
          await fs.writeFile(state.configPath, nextRaw);
          await observedDuringCapture.promise;
          expect(currentOwnership?.isCurrent()).toBe(false);
          expect(await fs.readFile(state.configPath, "utf8")).toBe(nextRaw);
          releaseCapture.resolve();
        }
        if (scenario === "changed-source-echo") {
          const result = await (await applied.promise).result;
          expect(result, JSON.stringify(reloadError.mock.calls)).toBe("superseded");
          await successorApplied.promise;
          await expect((await completion.promise)()).rejects.toThrow("superseded");
          const successor = await prepareModelRuntimeSnapshot({
            agentId: "default",
            agentDir: state.agentDir("default"),
            inheritedAuthDir: state.agentDir("default"),
            workspaceDir: state.workspaceDir,
            config: candidate,
          });
          expect(resolveAgentModelPrimaryValue(successor.config.agents?.defaults?.model)).toBe(
            "openai/fixture-newer",
          );
          expect(
            resolveAgentModelPrimaryValue(
              (await readConfigFileSnapshot()).sourceConfig.agents?.defaults?.model,
            ),
          ).toBe("openai/fixture-newer");
          return;
        }
        if (outcome === "runtime-failed") {
          await expect((await applied.promise).result).resolves.toBe("failed");
          expect(
            promotionObserved,
            JSON.stringify(
              [...reloadError.mock.calls, ...getPreparedModelRuntimeMocks().warn.mock.calls],
              (_key, value) =>
                value instanceof Error ? { message: value.message, stack: value.stack } : value,
            ),
          ).toBe(true);
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
          return;
        }
        const applicationStatus = await (await applied.promise).result;
        expect(applicationStatus, JSON.stringify(reloadError.mock.calls)).toBe("applied");
        if (scenario === "superseded") {
          expect(echoObserved).toBe(true);
        }
        const newerApplication = createRuntimeConfigWriteApplication();
        await transformConfigFileWithRetry({
          base: "source",
          writeOptions: attachRuntimeConfigWriteApplication({}, newerApplication),
          transform: () => ({ nextConfig: newer }),
        });
        await expect(newerApplication.result).resolves.toBe("applied");
        const normalRead = prepareModelRuntimeSnapshot({
          agentId: "default",
          agentDir: state.agentDir("default"),
          inheritedAuthDir: state.agentDir("default"),
          workspaceDir: state.workspaceDir,
          config: candidate,
        });
        await expect((await completion.promise)()).rejects.toThrow("superseded");
        expect(
          resolveAgentModelPrimaryValue((await normalRead).config.agents?.defaults?.model),
        ).toBe("openai/fixture-newer");
        expect(
          resolveAgentModelPrimaryValue(
            (await readConfigFileSnapshot()).sourceConfig.agents?.defaults?.model,
          ),
        ).toBe("openai/fixture-newer");
      } finally {
        releaseCapture.resolve();
        try {
          await reloader.stop();
        } finally {
          configFileAdapter.mockRestore();
        }
      }
    },
  );
});
