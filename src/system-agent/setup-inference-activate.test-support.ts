// Shared setup activation fixture; the test file owns lifecycle cleanup.
import fs from "node:fs/promises";
import path from "node:path";
import { expect, vi } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createWizardPrompter } from "../../test/helpers/wizard-prompter.js";
import { resolveAgentDir } from "../agents/agent-scope-config.js";
import { loadAuthProfileStoreWithoutExternalProfiles } from "../agents/auth-profiles/store-runtime.js";
import type { AuthProfileCredential } from "../agents/auth-profiles/types.js";
import {
  fingerprintAuthProfileCredential,
  fingerprintResolvedAuthProfileCredential,
  fingerprintResolvedProviderAuth,
} from "../agents/execution-auth-binding.js";
import { resolveApiKeyForProviderCore } from "../agents/model-auth.js";
import * as runtimePlugins from "../agents/runtime-plugins.js";
import { clearConfigCache } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ProviderAuthChoiceMetadata } from "../plugins/provider-auth-choices.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { withPluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";
import type { ProviderAuthResult, ProviderPlugin } from "../plugins/types.js";
import { activateSetupInference } from "./setup-inference-activate.js";
import type {
  ActivateSetupInferenceDeps,
  ActivateSetupInferenceParams,
} from "./setup-inference-core.js";
import { detectSetupInference } from "./setup-inference-detect.js";
import { createSystemAgentPluginMetadataTestSnapshot } from "./system-agent.test-helpers.js";
import { createSystemAgentVerifiedInferenceBinding } from "./verified-inference.js";
import {
  codexRuntimeArtifactAuth,
  pluginArtifactDeps,
  pluginRecord,
} from "./verified-inference.test-support.js";

export const tempDirs = createTempDirTracker();
export const modelRef = "openai/gpt-5.4-mini";
export const credential = {
  type: "api_key",
  provider: "openai",
  key: "fixture-saved-key",
} as const;
type RunParams = Parameters<NonNullable<ActivateSetupInferenceDeps["runEmbeddedAgent"]>>[0];

export async function fixture(
  options: {
    localService?: boolean;
    authMethod?: "oauth" | "api_key";
    profiles?: ProviderAuthResult["profiles"];
    restartRequired?: boolean;
    addProviderDuringLogin?: boolean;
    fresh?: boolean;
    surface?: "cli" | "gateway";
    secretRef?: boolean;
    signal?: AbortSignal;
    codex?: boolean;
    subscription?: boolean;
    homeScope?: "agent" | "user";
    modelTarget?: "utility";
    primaryModel?: string;
  } = {},
) {
  const root = tempDirs.make("setup-activation-");
  const configPath = path.join(root, "openclaw.json");
  const workspace = path.join(root, "workspace");
  vi.stubEnv("OPENCLAW_STATE_DIR", root);
  vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
  vi.stubEnv("OPENCLAW_HOME", root);
  vi.stubEnv("OPENAI_API_KEY", "");
  vi.stubEnv("ANTHROPIC_API_KEY", "");
  if (options.codex) {
    vi.stubEnv("CODEX_API_KEY", "");
  }
  vi.stubEnv("SETUP_ACTIVATION_FIXTURE_KEY", credential.key);
  const selectedCredential: AuthProfileCredential = options.subscription
    ? {
        type: "oauth",
        provider: "openai",
        access: "fixture-subscription-access",
        refresh: "fixture-subscription-refresh",
        expires: Date.now() + 3_600_000,
        accountId: "fixture-chatgpt-account",
      }
    : options.secretRef
      ? {
          type: "api_key",
          provider: "openai",
          keyRef: { source: "env", provider: "default", id: "SETUP_ACTIVATION_FIXTURE_KEY" },
        }
      : credential;
  const config: OpenClawConfig = {
    meta: { migrations: { utilityModelSeparation: true } },
    gateway: { mode: "local" },
    plugins: { slots: { memory: "none" } },
    agents: {
      entries: { main: { default: true } },
      defaults: {
        workspace,
        ...(options.primaryModel
          ? { model: { primary: options.primaryModel, fallbacks: ["stable/fallback"] } }
          : {}),
        skipBootstrap: true,
        models: { [modelRef]: { agentRuntime: { id: "openclaw" } } },
      },
    },
    models: {
      providers: {
        openai: {
          baseUrl: options.subscription
            ? "https://chatgpt.com/backend-api"
            : "https://provider.example/v1",
          api: options.subscription ? "openai-chatgpt-responses" : "openai-responses",
          models: [
            {
              id: "gpt-5.4-mini",
              name: "Fixture model",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 128_000,
              maxTokens: 4_096,
              compat: { supportsTools: true },
            },
          ],
          ...(options.localService ? { localService: { command: "/fixture/model-server" } } : {}),
        },
      },
    },
  };
  if (options.fresh) {
    delete config.gateway;
    delete config.agents?.entries;
    delete config.agents?.defaults?.models;
  }
  if (options.codex) {
    (config.plugins!.entries ??= {}).codex = {
      enabled: true,
      config: { appServer: { homeScope: options.homeScope } },
    };
  }
  const providerModels = config.models;
  if (options.addProviderDuringLogin) {
    delete config.models;
  }
  const before = `${JSON.stringify(config, null, 2)}\n`;
  await fs.writeFile(configPath, before);
  clearConfigCache();
  const agentDir = resolveAgentDir(config, "main");
  const metadata = createSystemAgentPluginMetadataTestSnapshot(config);
  const choice: ProviderAuthChoiceMetadata = {
    pluginId: "openai",
    providerId: "openai",
    methodId: "fixture-login",
    choiceId: "fixture-login",
    choiceLabel: "Fixture sign-in",
    ...(options.modelTarget ? { modelTarget: options.modelTarget } : {}),
    ...(options.authMethod === "api_key"
      ? { appGuidedSecret: true }
      : { appGuidedAuth: "oauth" as const }),
  };
  const login = vi.fn(async () => ({
    profiles: options.profiles ?? [{ profileId: "openai:fixture", credential: selectedCredential }],
    defaultModel: modelRef,
    ...(options.addProviderDuringLogin ? { configPatch: { models: providerModels } } : {}),
  }));
  const provider: ProviderPlugin = {
    id: "openai",
    pluginId: "openai",
    label: "OpenAI fixture",
    auth: [
      {
        id: "fixture-login",
        label: "Fixture sign-in",
        kind: options.authMethod ?? "oauth",
        starterModel: modelRef,
        run: login,
      },
    ],
  };
  const pluginRegistry = createEmptyPluginRegistry();
  pluginRegistry.providers.push({ pluginId: "openai", provider, source: "test" });
  // Credential checks must use the same prepared provider as setup authentication.
  // Otherwise the real resolver cold-loads unrelated bundled setup plugins.
  const resolveAuth = (input: Parameters<typeof resolveApiKeyForProviderCore>[0]) =>
    withPluginRuntimeGenerationScope(
      {
        metadataSnapshot: metadata.bind({
          config: input.cfg,
          workspaceDir: input.workspaceDir,
          env: process.env,
        }),
        pluginRegistry,
      },
      () => resolveApiKeyForProviderCore(input),
    );
  const readProfile = () =>
    Object.entries(loadAuthProfileStoreWithoutExternalProfiles(agentDir).profiles).find(
      ([, value]) =>
        (options.subscription &&
          value.type === "oauth" &&
          value.access === "fixture-subscription-access") ||
        (value.type === "api_key" &&
          (options.secretRef
            ? value.keyRef?.id === "SETUP_ACTIVATION_FIXTURE_KEY"
            : value.key === credential.key)),
    );
  const reply = async (params: RunParams) => {
    const stored = readProfile();
    if (!stored) {
      throw new Error("The credential was not saved before the provider turn");
    }
    const [profileId] = stored;
    expect(params.authProfileId).toBe(profileId);
    const auth = await resolveAuth({
      provider: "openai",
      cfg: params.config,
      agentDir: params.agentDir,
      workspaceDir: workspace,
      profileId: params.authProfileId,
      lockedProfile: true,
      modelId: params.model,
      modelApi: options.subscription ? "openai-chatgpt-responses" : "openai-responses",
      secretSentinels: true,
    });
    params.onSuccessfulAuthBinding?.({
      agentHarnessId: options.codex ? "codex" : "openclaw",
      authProfileId: auth.profileId,
      authFingerprint: options.subscription
        ? fingerprintAuthProfileCredential({ profileId, credential: stored[1] })
        : options.codex
          ? fingerprintResolvedAuthProfileCredential({
              profileId,
              credential: stored[1],
              resolvedAuth: auth,
            })
          : fingerprintResolvedProviderAuth(auth),
      ...(options.codex
        ? {
            runtimeOwnerKind: "plugin-harness" as const,
            runtimeOwnerId: "codex",
            ...codexRuntimeArtifactAuth,
          }
        : {}),
      modelId: "gpt-5.4-mini",
      modelApi: options.subscription ? "openai-chatgpt-responses" : "openai-responses",
    });
    return {
      payloads: [{ text: "OK" }],
      meta: {
        durationMs: 1,
        executionTrace: { winnerProvider: "openai", winnerModel: "gpt-5.4-mini" },
      },
    };
  };
  const run = vi.fn<NonNullable<ActivateSetupInferenceDeps["runEmbeddedAgent"]>>(async (params) =>
    reply(params),
  );
  const deps: ActivateSetupInferenceDeps = {
    resolvePluginProviders: () => [provider],
    resolveManifestProviderAuthChoice: () => choice,
    resolveManifestProviderAuthChoices: () => [choice],
    resolvePluginMetadataSnapshot: metadata.bind,
    runEmbeddedAgent: run,
  };
  if (options.codex) {
    vi.spyOn(runtimePlugins, "loadAgentRuntimePluginRegistryHandle").mockReturnValue(
      pluginRegistry,
    );
    deps.readCodexCliActiveApiKey = () => null;
    deps.ensureCodexRuntimePlugin = async ({ cfg: candidateConfig }) => ({
      ok: true,
      cfg: candidateConfig,
      required: false,
    });
    deps.resolveApiKeyForProvider = resolveAuth;
    deps.loadPluginRegistrySnapshot = () => ({
      plugins: [pluginRecord("openai"), pluginRecord("codex")],
    });
    deps.fingerprintPluginRuntimeArtifact = pluginArtifactDeps().fingerprintPluginRuntimeArtifact;
    deps.createSystemAgentVerifiedInferenceBinding = (input) =>
      createSystemAgentVerifiedInferenceBinding({
        ...input,
        deps: { ...input.deps, validateAgentHarnessRuntimeArtifact: async () => true },
      });
  }
  const prompter = createWizardPrompter();
  if (options.restartRequired) {
    deps.transformConfigWithPendingPluginInstalls = async (params) => {
      const { transformConfigWithPendingPluginInstalls } =
        await import("../plugins/install-record-commit.js");
      const result = await transformConfigWithPendingPluginInstalls(params);
      return {
        ...result,
        followUp: { mode: "restart", requiresRestart: true, reason: "Plugin source changed" },
      };
    };
  }
  const activate = (
    kind: Parameters<typeof activateSetupInference>[0]["kind"] = "provider-auth",
    activationConfirmed?: true,
    overrides: Pick<
      ActivateSetupInferenceParams,
      "apiKey" | "signal" | "onActivationCompletion" | "modelTarget" | "modelRef"
    > = {},
  ) =>
    metadata.run(() =>
      activateSetupInference({
        kind,
        ...(options.modelTarget ? { modelTarget: options.modelTarget } : {}),
        authChoice: choice.choiceId,
        modelRef,
        nativeSessionCatalogsEnabled: false,
        surface: options.surface ?? "cli",
        runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
        prompter: activationConfirmed ? undefined : prompter,
        activationConfirmed,
        signal: options.signal,
        ...overrides,
        deps,
      }),
    );
  const detect = () =>
    metadata.run(() =>
      detectSetupInference({
        resolveManifestProviderAuthChoices: () => [choice],
        resolvePluginProviders: () => [provider],
        detectInferenceBackends: async () => [],
        probeLocalCommand: async (command) => ({ command, found: false }),
      }),
    );
  return {
    activate,
    detect,
    agentDir,
    before,
    config,
    configPath,
    workspace,
    readProfile,
    reply,
    resolveAuth,
    run,
    login,
    prompter,
    deps,
  };
}
