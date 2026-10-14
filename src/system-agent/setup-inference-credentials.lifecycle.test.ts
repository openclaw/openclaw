import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { createWizardPrompter } from "../../test/helpers/wizard-prompter.js";
import {
  getRuntimeAuthProfileStoreCredentialsRevision,
  setRuntimeAuthProfileStoreSnapshot,
} from "../agents/auth-profiles/runtime-snapshots.js";
import {
  loadAuthProfileStoreWithoutExternalProfiles,
  loadAuthProfileStoreWithoutExternalProfilesAsync,
  updateAuthProfileStoreWithLock,
} from "../agents/auth-profiles/store-runtime.js";
import {
  captureAuthProfileStorePersistenceSnapshot,
  resolvePersistedAuthProfileOwnerAgentDir,
} from "../agents/auth-profiles/store.js";
import type { AuthProfileCredential } from "../agents/auth-profiles/types.js";
import { resolveModelRuntimePolicy } from "../agents/model-runtime-policy.js";
import type * as OnboardingPluginInstall from "../commands/onboarding-plugin-install.js";
import { clearConfigCache, readConfigFileSnapshot } from "../config/config.js";
import {
  registerConfigWriteListener,
  resetConfigRuntimeState,
  setRuntimeConfigSnapshot,
} from "../config/io.js";
import { resolveAgentModelPrimaryValue } from "../config/model-input.js";
import { getRuntimeConfigWriteApplication } from "../config/runtime-write-application.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { diffGatewayReloadPaths } from "../gateway/config-diff.js";
import {
  buildGatewayReloadPlan,
  listConfigReloadRefinementPrefixes,
} from "../gateway/config-reload-plan.js";
import type { GatewayClient } from "../gateway/server-methods/client-types.js";
import { modelsAuthLoginHandlers } from "../gateway/server-methods/models-auth-login.js";
import { whenAdmittedWizardSessionSettled } from "../gateway/server-methods/setup-admission.js";
import * as setupExecution from "../gateway/server-methods/system-agent-execution.js";
import type { GatewayRequestContext } from "../gateway/server-methods/types.js";
import { createWizardSessionTracker } from "../gateway/server-wizard-sessions.js";
import { withPluginLifecycleLease } from "../plugins/plugin-lifecycle-lease.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import type { ProviderAuthChoiceMetadata } from "../plugins/provider-auth-choices.js";
import * as providerChoices from "../plugins/provider-auth-choices.js";
import type { ProviderPlugin } from "../plugins/types.js";
import { createNonExitingRuntime } from "../runtime.js";
import { createDeferredCore } from "../shared/deferred.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { activateSetupInference } from "./setup-inference-activate.js";
import { fixture, modelRef, tempDirs } from "./setup-inference-activate.test-support.js";
import {
  activateSavedSetupCredential,
  type SetupCredentialActivationReceipt,
} from "./setup-inference-credential-access.js";
import { stageProviderAuthCandidate } from "./setup-inference-credentials.js";
import { pluginRecord } from "./verified-inference.test-support.js";

const installRuntime = vi.hoisted(() =>
  vi.fn<typeof OnboardingPluginInstall.ensureOnboardingPluginInstalled>(),
);
vi.mock("../commands/onboarding-plugin-install.js", async (importOriginal) => ({
  ...(await importOriginal<typeof OnboardingPluginInstall>()),
  ensureOnboardingPluginInstalled: installRuntime,
}));

afterEach(async () => {
  closeOpenClawAgentDatabasesForTest();
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
  tempDirs.cleanup();
  clearConfigCache();
  clearPluginMetadataLifecycleCaches();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("setup inference credential provider lifetime", () => {
  it.each([
    { flow: "managed wizard", profileCase: "matching-last" },
    { flow: "managed wizard", profileCase: "missing-match" },
    { flow: "app-guided auth", profileCase: "empty" },
    { flow: "app-guided auth", profileCase: "missing-match" },
  ] as const)(
    "materializes $flow model normalization with $profileCase profiles before retiring the provider",
    async ({ flow, profileCase }) => {
      await withOpenClawTestState({ label: "setup-plan-lifetime" }, async (state) => {
        const id = flow === "managed wizard" ? "managed-plan" : "guided-plan";
        const pluginDir = state.path(id);
        const nativeEvent = `${id}-native`;
        const observationEvent = `${id}-observation`;
        const rawModelRef = `${id}/preview`;
        const canonicalModelRef = `${id}/canonical`;
        const profile = (provider: string) => ({
          profileId: `${provider}:default`,
          credential: { type: "api_key", provider, key: `synthetic-${provider}-key` },
        });
        const profiles =
          profileCase === "empty"
            ? []
            : [profile("unrelated"), ...(profileCase === "matching-last" ? [profile(id)] : [])];
        const nativeBefore = process.listenerCount(nativeEvent);
        const observations: Array<{ phase: string; value: unknown }> = [];
        const observe = (phase: string, value: unknown) => {
          observations.push({ phase, value });
        };
        await fs.mkdir(pluginDir);
        await fs.writeFile(
          path.join(pluginDir, "package.json"),
          JSON.stringify({
            name: `@example/${id}`,
            version: "1.0.0",
            type: "commonjs",
            openclaw: { extensions: ["./index.cjs"], setupEntry: "./index.cjs" },
          }),
        );
        await fs.writeFile(
          path.join(pluginDir, "openclaw.plugin.json"),
          JSON.stringify({
            id,
            providers: [id],
            configSchema: { type: "object", properties: {} },
            setup: { requiresRuntime: true, providers: [{ id }] },
            providerAuthChoices: [
              {
                provider: id,
                method: "synthetic",
                choiceId: id,
                choiceLabel: "Synthetic setup",
                ...(flow === "app-guided auth" ? { appGuidedAuth: "oauth" } : {}),
              },
            ],
          }),
        );
        await fs.writeFile(
          path.join(pluginDir, "index.cjs"),
          `
          const nativeEvent = ${JSON.stringify(nativeEvent)};
          const observationEvent = ${JSON.stringify(observationEvent)};
          const listener = () => {};
          process.on(nativeEvent, listener);
          module.exports = { id: ${JSON.stringify(id)}, register(api) {
            api.lifecycle.onDispose(() => {
              process.off(nativeEvent, listener);
              process.emit(observationEvent, "dispose");
            });
            api.registerProvider({
              id: ${JSON.stringify(id)}, label: "Synthetic setup",
              normalizeModelId({ modelId }) {
                process.emit(observationEvent, "normalize", {
                  modelId, listenerLive: process.listenerCount(nativeEvent) > 0,
                  aborted: api.lifecycle.signal.aborted,
                });
                return modelId === "preview" ? "canonical" : modelId;
              },
              auth: [{
                id: "synthetic", label: "Synthetic", kind: "oauth",
                wizard: { choiceId: ${JSON.stringify(id)} },
                async run(ctx) {
                  await ctx.prompter.note("auth entered", "Synthetic setup");
                  const result = {
                    profiles: ${JSON.stringify(profiles)}, defaultModel: ${JSON.stringify(rawModelRef)},
                    configPatch: { agents: { defaults: { models: {
                      [${JSON.stringify(rawModelRef)}]: { alias: "Starter" },
                    } } } },
                  };
                  process.emit(observationEvent, "auth-result", result.defaultModel);
                  return result;
                },
              }],
            });
          } };
          `,
        );
        const cfg: OpenClawConfig = {
          agents: { defaults: { model: { primary: "existing/model" } } },
          plugins: {
            allow: [id],
            load: { paths: [pluginDir] },
            entries: { [id]: { enabled: true } },
            slots: { memory: "none" },
          },
        };
        const originalConfig = structuredClone(cfg);
        await state.writeConfig(cfg);
        const snapshot = await readConfigFileSnapshot();
        const started = createDeferredCore();
        const release = createDeferredCore();
        let entered = false;
        process.on(observationEvent, observe);
        const work = stageProviderAuthCandidate(
          {
            cfg,
            snapshot,
            routeAgentId: "main",
            workspace: state.workspaceDir,
            agentDir: state.agentDir(),
            effects: { credentialsSaved: false },
            beforePersistentEffect: async () => {},
            deps: {},
            params: {
              kind: "provider-auth",
              authChoice: id,
              surface: "gateway",
              runtime: createNonExitingRuntime(),
              isRemoteProviderAuth: true,
              prompter: createWizardPrompter({
                note: async (message) => {
                  if (message === "auth entered") {
                    entered = true;
                    started.resolve();
                    await release.promise;
                  }
                },
                confirm: async () => true,
                select: async (params) => {
                  const selected =
                    params.options.find((option) => option.value === true) ?? params.options[0];
                  if (!selected) {
                    throw new Error("Synthetic setup prompt had no choices");
                  }
                  return selected.value;
                },
              }),
            },
          },
          true,
        );
        try {
          await Promise.race([started.promise, work]);
          expect(entered).toBe(true);
          expect(process.listenerCount(nativeEvent)).toBe(nativeBefore + 1);
          // Acquire from the test context so this cannot reuse the provider's inherited lease.
          await withPluginLifecycleLease({ env: state.env, waitMs: 0 }, async (lease) =>
            lease.assertOwned(),
          );
          release.resolve();
          const plan = await work;
          expect(process.listenerCount(nativeEvent)).toBe(nativeBefore);
          expect(cfg).toEqual(originalConfig);
          expect(structuredClone(plan)).toEqual(plan);
          const saved = loadAuthProfileStoreWithoutExternalProfiles(state.agentDir()).profiles;
          if (profileCase === "missing-match") {
            expect(plan).toEqual({ error: expect.stringContaining("did not return credentials") });
            expect(saved).toEqual({});
            expect(observations[0]).toEqual({ phase: "auth-result", value: rawModelRef });
            expect(observations.at(-1)).toEqual({ phase: "dispose", value: undefined });
            return;
          }
          expect(observations).toEqual([
            { phase: "auth-result", value: rawModelRef },
            {
              phase: "normalize",
              value: { modelId: "preview", listenerLive: true, aborted: false },
            },
            { phase: "dispose", value: undefined },
          ]);
          expect(plan).toMatchObject({
            modelRef: canonicalModelRef,
            config: {
              agents: {
                defaults: {
                  model: { primary: "existing/model" },
                  models: { [canonicalModelRef]: { alias: "Starter" } },
                },
              },
            },
          });
          if ("error" in plan) {
            throw new Error(plan.error);
          }
          if (profileCase === "matching-last") {
            expect(plan.authProfileId).toBeDefined();
            expect(Object.keys(saved)).toEqual([plan.authProfileId]);
            expect(saved[plan.authProfileId!]).toMatchObject(
              expectDefined(profiles[1]?.credential, "Expected the selected fixture credential"),
            );
          } else {
            expect(plan.authProfileId).toBeUndefined();
            expect(saved).toEqual({});
          }
        } finally {
          release.resolve();
          try {
            await work;
          } finally {
            process.off(observationEvent, observe);
          }
        }
      });
    },
  );
});

it("activates and restores setup credentials off-thread while preserving later neighboring writes", async () => {
  await withOpenClawTestState({ label: "setup-auth-publication" }, async (state) => {
    const profileId = "fixture:setup";
    const source: AuthProfileCredential = {
      type: "api_key",
      provider: "fixture",
      keyRef: { source: "env", provider: "default", id: "FIXTURE_KEY" },
    };
    const credential = {
      ...source,
      setup: { replacement: true, modelRef: "fixture/model", configJson: "{}" },
    };
    await state.writeAuthProfiles({ version: 1, profiles: { [profileId]: credential } });
    const agentDir = resolvePersistedAuthProfileOwnerAgentDir({
      agentDir: state.agentDir(),
      profileId,
    });
    await loadAuthProfileStoreWithoutExternalProfilesAsync(state.agentDir());
    const observation = observeHostDataSql();
    let receipt: SetupCredentialActivationReceipt;
    try {
      receipt = expectDefined(
        await activateSavedSetupCredential({ agentDir: state.agentDir(), profileId, credential }),
        "Expected activation receipt",
      );
      expect(
        observation.queries.filter((sql) => /\bauth_profile_(?:store|state)\b/iu.test(sql)),
      ).toEqual([]);
    } finally {
      observation.restore();
    }
    const persisted = captureAuthProfileStorePersistenceSnapshot(agentDir).credentialsRaw;
    expect(persisted).not.toHaveProperty(["profiles", profileId, "setup"]);
    expect(persisted).not.toHaveProperty(["profiles", profileId, "key"]);
    const revision = getRuntimeAuthProfileStoreCredentialsRevision();
    setRuntimeAuthProfileStoreSnapshot(
      { version: 1, profiles: { [profileId]: { ...source, key: "materialized-fixture-key" } } },
      state.agentDir(),
    );
    expect(getRuntimeAuthProfileStoreCredentialsRevision()).toBeGreaterThan(revision);
    expect(captureAuthProfileStorePersistenceSnapshot(agentDir).credentialsRaw).toEqual(persisted);
    expect(() => receipt.assertCurrent()).not.toThrow();
    await updateAuthProfileStoreWithLock({
      agentDir,
      saveOptions: { filterExternalAuthProfiles: false, syncExternalCli: false },
      updater(store) {
        store.profiles.neighbor = { type: "api_key", provider: "neighbor", key: "fixture-next" };
        store.usageStats = { neighbor: { lastUsed: 42 } };
        return true;
      },
    });
    await receipt.rollback();
    const restored = await loadAuthProfileStoreWithoutExternalProfilesAsync(state.agentDir());
    expect(restored.profiles[profileId]).toMatchObject(credential);
    expect(restored.profiles.neighbor).toEqual({
      type: "api_key",
      provider: "neighbor",
      key: "fixture-next",
    });
    expect(restored.usageStats?.neighbor?.lastUsed).toBe(42);
  });
});

it.each([
  { selectedModel: "meta/muse-spark-1.3", selectModel: undefined },
  { selectedModel: "meta/muse-spark-1.2", selectModel: undefined },
  { selectedModel: "meta/muse-spark-1.3", selectModel: true },
  { selectedModel: "meta/muse-spark-1.3", selectModel: false },
])(
  "activates the Muse route for main (model: $selectedModel, selectModel: $selectModel)",
  async ({ selectedModel, selectModel }) => {
    const setup = await fixture({ codex: true, primaryModel: modelRef });
    const starter = "meta/muse-spark-1.3";
    const original = { alias: "Existing Meta API model", agentRuntime: { id: "openclaw" } };
    const config: OpenClawConfig = {
      ...setup.config,
      agents: {
        ...setup.config.agents,
        ownership: "explicit",
        defaults: {
          ...setup.config.agents?.defaults,
          models: { ...setup.config.agents?.defaults?.models, [starter]: original },
        },
        entries: {
          main: { model: { primary: modelRef, fallbacks: ["stable/agent-fallback"] } },
          other: {},
        },
      },
      plugins: {
        ...setup.config.plugins,
        entries: { ...setup.config.plugins?.entries, meta: { enabled: true } },
      },
      models: {
        ...setup.config.models,
        providers: {
          ...setup.config.models?.providers,
          meta: {
            baseUrl: "https://api.meta.ai/v1",
            models: [],
            apiKey: "synthetic-existing-meta-api-key",
          },
        },
      },
    };
    const previousAgentModel = JSON.stringify(config.agents?.entries?.main?.model);
    const previousDefaultModel = JSON.stringify(config.agents?.defaults?.model);
    await fs.writeFile(setup.configPath, `${JSON.stringify(config, null, 2)}\n`);
    clearConfigCache();
    const choice: ProviderAuthChoiceMetadata = {
      pluginId: "meta",
      providerId: "meta",
      methodId: "muse-code",
      choiceId: "muse-code",
      choiceLabel: "Muse Code",
      appGuidedAuth: "device-code",
    };
    const provider: ProviderPlugin = {
      id: "meta",
      pluginId: "meta",
      label: "Meta",
      auth: [
        {
          id: "muse-code",
          label: "Muse Code",
          kind: "device_code",
          run: async () => ({
            profiles: [],
            defaultModel: starter,
            agentRuntimeId: "muse",
          }),
        },
      ],
    };
    setup.deps.resolveManifestProviderAuthChoice = () => choice;
    setup.deps.resolvePluginProviders = () => [provider];
    setup.deps.loadPluginRegistrySnapshot = () => ({
      plugins: [
        pluginRecord("meta"),
        pluginRecord("muse"),
        pluginRecord("codex"),
        pluginRecord("openai"),
      ],
    });
    const verifySetup = vi.fn(async () => {});
    setup.pluginRegistry.agentHarnesses.push({
      pluginId: "muse",
      source: "test",
      harness: {
        id: "muse",
        label: "Muse Code",
        authBootstrap: "harness",
        supports: () => ({ supported: true }),
        verifySetup,
        runAttempt: async () => {
          throw new Error("Native setup verification must not start a turn");
        },
      },
    });
    const record: PluginInstallRecord = {
      source: "npm",
      spec: "@openclaw/muse",
      installPath: path.join(path.dirname(setup.configPath), "extensions/muse"),
    };
    installRuntime.mockImplementation(async ({ cfg, entry, beforePersistentEffect }) => {
      expect(entry.pluginId).toBe("muse");
      await beforePersistentEffect?.();
      return {
        installed: true,
        status: "installed",
        pluginId: "muse",
        cfg: {
          ...cfg,
          plugins: {
            ...cfg.plugins,
            entries: { ...cfg.plugins?.entries, muse: { enabled: true } },
            installs: { muse: record },
          },
        },
      };
    });
    if (selectModel === false) {
      vi.spyOn(providerChoices, "resolveManifestDeclaredProviderAuthChoices").mockReturnValue([
        choice,
      ]);
      const activate = setupExecution.activateGatewaySetupInference;
      vi.spyOn(setupExecution, "activateGatewaySetupInference").mockImplementation((params) =>
        setup.runWithMetadata(() =>
          activate({
            ...params,
            nativeSessionCatalogsEnabled: false,
            deps: setup.deps,
          }),
        ),
      );
      const tracker = createWizardSessionTracker();
      const client: GatewayClient = {
        connId: "muse-access",
        connect: {
          minProtocol: 1,
          maxProtocol: 1,
          scopes: ["operator.admin"],
          client: { id: "cli", version: "test", platform: "test", mode: "cli" },
        },
      };
      const params = { sessionId: "muse-access", authChoice: "meta/muse-code", agentId: "main" };
      const unsubscribe = registerConfigWriteListener(
        (event) => {
          const claim = expectDefined(
            getRuntimeConfigWriteApplication(event)?.claim(),
            "runtime activation receipt",
          );
          void expectDefined(
            claim.prepare,
            "runtime activation preparation",
          )(() => {}).then(() => claim.settle("applied-restart-required"));
        },
        {
          ownsRuntimeActivationFor: setup.configPath,
          preCommitRuntimePreflight: async (sourceConfig, runtimeRefresh) => {
            const plan = buildGatewayReloadPlan(
              diffGatewayReloadPaths(config, sourceConfig, listConfigReloadRefinementPrefixes()),
              { previousConfig: config, candidateConfig: sourceConfig },
            );
            expect(plan.reloadPlugins).toBe(true);
            if (runtimeRefresh?.requireImmediateApplication && plan.reloadPlugins) {
              throw new Error("The new runtime plugin cannot be applied immediately.");
            }
            return { runtimeConfig: sourceConfig, compareConfig: sourceConfig };
          },
        },
      );
      try {
        setRuntimeConfigSnapshot(config, config);
        await expectDefined(
          modelsAuthLoginHandlers["models.authLogin"],
          "provider login handler",
        )({
          req: { type: "req", id: "muse-access", method: "models.authLogin", params },
          params,
          respond: vi.fn(),
          // SAFETY: Provider login uses only the real session tracker and current fixture config.
          context: { ...tracker, getRuntimeConfig: () => config } as GatewayRequestContext,
          client,
          isWebchatConnect: () => false,
        });
        const session = expectDefined(
          tracker.wizardSessions.get(params.sessionId),
          "login session",
        );
        await whenAdmittedWizardSessionSettled(session);
        expect(session.getStatus(), session.getError()).toBe("done");
      } finally {
        unsubscribe();
        resetConfigRuntimeState();
      }
    } else {
      const result = await setup.runWithMetadata(() =>
        activateSetupInference({
          kind: "provider-auth",
          authChoice: "muse-code",
          agentId: "main",
          modelRef: selectedModel,
          ...(selectModel === undefined ? {} : { selectModel }),
          nativeSessionCatalogsEnabled: false,
          surface: "gateway",
          runtime: createNonExitingRuntime(),
          prompter: setup.prompter,
          deps: setup.deps,
        }),
      );
      expect(result).toMatchObject({ ok: true, modelRef: selectedModel });
    }
    const selected = (await readConfigFileSnapshot()).sourceConfig;
    if (selectModel === false) {
      expect(JSON.stringify(selected.agents?.entries?.main?.model)).toBe(previousAgentModel);
    } else {
      expect(resolveAgentModelPrimaryValue(selected.agents?.entries?.main?.model)).toBe(
        selectedModel,
      );
    }
    expect(JSON.stringify(selected.agents?.defaults?.model)).toBe(previousDefaultModel);
    expect(
      resolveModelRuntimePolicy({ config: selected, modelId: selectedModel, agentId: "main" })
        .policy?.id,
    ).toBe("muse");
    expect(selected.agents?.entries?.main?.models?.[selectedModel]?.agentRuntime?.id).toBe("muse");
    expect(
      resolveModelRuntimePolicy({ config: selected, modelId: starter, agentId: "other" }).policy
        ?.id,
    ).toBe("openclaw");
    expect(selected.plugins?.entries?.muse?.enabled).toBe(true);
    expect(selected.agents?.defaults?.models?.[starter]).toEqual(original);
    expect(selected.models?.providers?.meta?.apiKey).toBe("synthetic-existing-meta-api-key");
    expect(verifySetup).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "meta", modelId: selectedModel.slice("meta/".length) }),
    );
    expect(setup.run).not.toHaveBeenCalled();
  },
);
