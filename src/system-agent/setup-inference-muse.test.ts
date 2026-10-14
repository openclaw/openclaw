import { afterEach, expect, it, vi } from "vitest";
import { createWizardPrompter } from "../../test/helpers/wizard-prompter.js";
import { resolveModelRuntimePolicy } from "../agents/model-runtime-policy.js";
import type * as OnboardingPluginInstall from "../commands/onboarding-plugin-install.js";
import { readConfigFileSnapshot } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import type * as InstalledPluginIndexRecords from "../plugins/installed-plugin-index-records.js";
import type { ProviderAuthChoiceMetadata } from "../plugins/provider-auth-choices.js";
import type { ProviderAuthResult, ProviderPlugin } from "../plugins/types.js";
import { createNonExitingRuntime } from "../runtime.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { listSetupInferenceAuthOptions } from "./setup-inference-auth-options.js";
import { stageProviderAuthCandidate } from "./setup-inference-credentials.js";
import { applySystemAgentModelSelection } from "./setup-model-selection.js";

const mocks = vi.hoisted(() => ({
  install: vi.fn<typeof OnboardingPluginInstall.ensureOnboardingPluginInstalled>(),
}));
vi.mock("../commands/onboarding-plugin-install.js", async (importOriginal) => ({
  ...(await importOriginal<typeof OnboardingPluginInstall>()),
  ensureOnboardingPluginInstalled: mocks.install,
}));
vi.mock("../plugins/installed-plugin-index-records.js", async (importOriginal) => ({
  ...(await importOriginal<typeof InstalledPluginIndexRecords>()),
  loadInstalledPluginIndexInstallRecords: async () => ({}),
}));

afterEach(() => vi.clearAllMocks());

it.each([
  { selectedModel: undefined, explicitRuntime: undefined, expectedRuntime: "muse" },
  { selectedModel: "meta/muse-spark-1.2", explicitRuntime: undefined, expectedRuntime: "muse" },
  {
    selectedModel: "meta/muse-spark-1.2",
    explicitRuntime: "openclaw",
    expectedRuntime: "openclaw",
  },
])(
  "preserves selected runtime $expectedRuntime for Muse sign-in (selected: $selectedModel)",
  ({ selectedModel, explicitRuntime, expectedRuntime }) =>
    withOpenClawTestState({ label: "muse-setup" }, async (state) => {
      const defaultModel = "meta/muse-spark-1.3";
      const modelRef = selectedModel ?? defaultModel;
      const unrelatedModel = "meta/llama-4-maverick";
      const originalDefaultRow = {
        alias: "Existing Meta API model",
        agentRuntime: { id: "openclaw" },
      };
      const config: OpenClawConfig = {
        gateway: { mode: "local" },
        agents: {
          defaults: {
            workspace: state.workspaceDir,
            models: {
              [unrelatedModel]: { agentRuntime: { id: "openclaw" } },
              [defaultModel]: originalDefaultRow,
              ...(selectedModel && explicitRuntime
                ? { [selectedModel]: { agentRuntime: { id: explicitRuntime } } }
                : {}),
            },
          },
          entries: { main: {} },
        },
        plugins: { entries: { meta: { enabled: true } } },
        models: {
          providers: {
            meta: {
              baseUrl: "https://api.meta.ai/v1",
              models: [],
              apiKey: "synthetic-existing-meta-api-key",
            },
          },
        },
      };
      await state.writeConfig(config);
      const choice: ProviderAuthChoiceMetadata = {
        pluginId: "meta",
        providerId: "meta",
        methodId: "muse-code",
        choiceId: "muse-code",
        choiceLabel: "Muse Code",
        appGuidedAuth: "device-code",
      };
      expect(listSetupInferenceAuthOptions([choice])).toMatchObject([
        { id: "muse-code", kind: "device-code" },
      ]);
      expect(config.plugins?.entries?.muse).toBeUndefined();
      const login = vi.fn(async (): Promise<ProviderAuthResult> => ({
        profiles: [],
        defaultModel,
        configPatch: {
          agents: {
            defaults: {
              models: { [defaultModel]: { agentRuntime: { id: "muse" } } },
            },
          },
        },
      }));
      const provider: ProviderPlugin = {
        id: "meta",
        pluginId: "meta",
        label: "Meta",
        auth: [{ id: "muse-code", label: "Muse Code", kind: "device_code", run: login }],
      };
      const record: PluginInstallRecord = {
        source: "npm",
        spec: "@openclaw/muse",
        installPath: state.statePath("extensions/muse"),
      };
      mocks.install.mockImplementation(async ({ cfg, entry, beforePersistentEffect }) => {
        expect(entry.pluginId).toBe("muse");
        expect(entry.install.npmSpec).toBe("@openclaw/muse");
        expect(
          resolveModelRuntimePolicy({ config: cfg, modelId: modelRef, agentId: "main" }).policy?.id,
        ).toBe("muse");
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
      const staged = await stageProviderAuthCandidate(
        {
          cfg: config,
          snapshot: await readConfigFileSnapshot(),
          routeAgentId: "main",
          workspace: state.workspaceDir,
          agentDir: state.statePath("agents/main/agent"),
          effects: { credentialsSaved: false },
          beforePersistentEffect: async () => {},
          params: {
            kind: "provider-auth",
            surface: "gateway",
            authChoice: "muse-code",
            modelRef: selectedModel,
            runtime: createNonExitingRuntime(),
            prompter: createWizardPrompter(),
          },
          deps: {
            resolveManifestProviderAuthChoice: () => choice,
            resolvePluginProviders: () => [provider],
          },
        },
        true,
      );
      if ("error" in staged) {
        throw new Error(staged.error);
      }
      const selected = await applySystemAgentModelSelection({
        config: staged.config,
        model: staged.modelRef,
        targetAgentId: "main",
        agentRuntimeId: staged.agentRuntimeId,
      });
      expect(login).toHaveBeenCalledOnce();
      expect(mocks.install).toHaveBeenCalledTimes(expectedRuntime === "muse" ? 1 : 0);
      expect(staged.pendingPluginInstalls?.muse).toEqual(
        expectedRuntime === "muse" ? record : undefined,
      );
      expect(staged.authProfileId).toBeUndefined();
      expect(selected.plugins?.entries?.muse?.enabled).toBe(
        expectedRuntime === "muse" ? true : undefined,
      );
      expect(selected.agents?.entries?.main?.model).toBe(modelRef);
      expect(
        resolveModelRuntimePolicy({ config: selected, modelId: modelRef, agentId: "main" }).policy
          ?.id,
      ).toBe(expectedRuntime);
      expect(
        resolveModelRuntimePolicy({ config: selected, modelId: unrelatedModel, agentId: "main" })
          .policy?.id,
      ).toBe("openclaw");
      expect(selected.models?.providers?.meta?.apiKey).toBe("synthetic-existing-meta-api-key");
      if (selectedModel && selectedModel !== defaultModel) {
        expect(selected.agents?.defaults?.models?.[defaultModel]).toEqual(originalDefaultRow);
      }
    }),
);
