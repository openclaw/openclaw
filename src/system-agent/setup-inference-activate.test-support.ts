// Shared setup activation fixture; the test file owns lifecycle cleanup.
import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, vi } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createWizardPrompter } from "../../test/helpers/wizard-prompter.js";
import { resolveAgentDir } from "../agents/agent-scope-config.js";
import { loadAuthProfileStoreWithoutExternalProfiles } from "../agents/auth-profiles/store-runtime.js";
import type { AuthProfileCredential } from "../agents/auth-profiles/types.js";
import * as cliCredentials from "../agents/cli-credentials.js";
import * as embeddedAgent from "../agents/embedded-agent.js";
import {
  fingerprintAuthProfileCredential,
  fingerprintResolvedAuthProfileCredential,
  fingerprintResolvedProviderAuth,
} from "../agents/execution-auth-binding.js";
import type { AgentHarness } from "../agents/harness/types.js";
import { resolveApiKeyForProviderCore } from "../agents/model-auth.js";
import * as modelAuth from "../agents/model-auth.js";
import * as runtimePlugins from "../agents/runtime-plugins.js";
import * as onboardInference from "../commands/onboard-inference.js";
import * as codexRuntimePlugin from "../commands/runtime-plugin-install.js";
import { clearConfigCache } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GatewayClient } from "../gateway/server-methods/client-types.js";
import { modelsAuthLoginHandlers } from "../gateway/server-methods/models-auth-login.js";
import { whenAdmittedWizardSessionSettled } from "../gateway/server-methods/setup-admission.js";
import type { GatewayRequestContext } from "../gateway/server-methods/types.js";
import { createWizardSessionTracker } from "../gateway/server-wizard-sessions.js";
import { buildCatalogModel } from "../plugin-sdk/provider-catalog.test-support.js";
import * as pluginMetadata from "../plugins/plugin-metadata-snapshot.js";
import * as pluginArtifactIdentity from "../plugins/plugin-runtime-artifact-identity.js";
import type { ProviderAuthChoiceMetadata } from "../plugins/provider-auth-choices.js";
import * as providerChoices from "../plugins/provider-auth-choices.js";
import * as providerRuntime from "../plugins/providers.runtime.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { withPluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";
import type { ProviderAuthResult, ProviderPlugin } from "../plugins/types.js";
import { activateSetupInference } from "./setup-inference-activate.js";
import type { ActivateSetupInferenceParams } from "./setup-inference-core.js";
import { detectSetupInference } from "./setup-inference-detect.js";
import { createSystemAgentPluginMetadataTestSnapshot } from "./system-agent.test-helpers.js";
import {
  codexRuntimeArtifactAuth,
  pluginRecord,
  mockPluginRegistry,
} from "./verified-inference.test-support.js";

// mock-isolation: Activation fixtures never initialize the embedded agent runtime.
vi.mock("../agents/embedded-agent.js", () => ({ runEmbeddedAgent: vi.fn() }));

const realResolveAuth = resolveApiKeyForProviderCore;

export const tempDirs = createTempDirTracker();
export const modelRef = "openai/gpt-5.4-mini";
export const credential = {
  type: "api_key",
  provider: "openai",
  key: "fixture-saved-key",
} as const;
type RunParams = Parameters<typeof embeddedAgent.runEmbeddedAgent>[0];

export function setupLoginSession(
  config: () => OpenClawConfig,
  params: { sessionId: string; authChoice: string; agentId?: string },
  clientOptions: Pick<GatewayClient, "connId" | "connectionSignal"> = { connId: params.sessionId },
) {
  const tracker = createWizardSessionTracker();
  const client: GatewayClient = {
    ...clientOptions,
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      scopes: ["operator.admin"],
      client: { id: "cli", version: "test", platform: "test", mode: "cli" },
    },
  };
  return {
    client,
    async start() {
      await expectDefined(
        modelsAuthLoginHandlers["models.authLogin"],
        "provider login handler",
      )({
        req: { type: "req", id: params.sessionId, method: "models.authLogin", params },
        params,
        respond: vi.fn(),
        // SAFETY: Login uses only this real session tracker and the supplied fixture config.
        context: { ...tracker, getRuntimeConfig: config } as GatewayRequestContext,
        client,
        isWebchatConnect: () => false,
      });
      return expectDefined(tracker.wizardSessions.get(params.sessionId), "login session");
    },
    async cancel() {
      for (const session of tracker.wizardSessions.values()) {
        session.cancel();
        await whenAdmittedWizardSessionSettled(session);
      }
    },
  };
}

export function setupMuseProvider(
  setup: Awaited<ReturnType<typeof fixture>>,
  model: string,
  options: Partial<Pick<AgentHarness, "supports" | "verifySetup" | "executionEnvironment">> & {
    methodId?: string;
  } = {},
) {
  const { methodId = "muse-code", ...harnessOptions } = options;
  const choice = {
    pluginId: "meta",
    providerId: "meta",
    methodId,
    choiceId: methodId,
    choiceLabel: "Muse Code",
    appGuidedAuth: "device-code" as const,
  };
  const provider: ProviderPlugin = {
    id: "meta",
    pluginId: "meta",
    label: "Meta",
    auth: [
      {
        id: methodId,
        label: "Muse Code",
        kind: "device_code",
        run: async () => ({ profiles: [], defaultModel: model, agentRuntimeId: "muse" }),
      },
    ],
  };
  setup.resolveManifestProviderAuthChoice.mockReturnValue(choice);
  vi.spyOn(providerRuntime, "resolvePluginProvidersCore").mockReturnValue([provider]);
  mockPluginRegistry(["meta", "muse", "codex", "openai"].map((id) => pluginRecord(id)));
  setup.pluginRegistry.agentHarnesses.push({
    pluginId: "muse",
    source: "test",
    harness: {
      id: "muse",
      label: "Muse Code",
      authBootstrap: "harness",
      supports: () => ({ supported: true }),
      ...harnessOptions,
      runAttempt: async () => {
        throw new Error("Native setup verification must not start a turn");
      },
    },
  });
  return choice;
}

export async function fixture(
  options: {
    localService?: boolean;
    authMethod?: "oauth" | "api_key";
    profiles?: ProviderAuthResult["profiles"];
    addProviderDuringLogin?: boolean;
    fresh?: boolean;
    surface?: "cli" | "gateway";
    secretRef?: boolean;
    signal?: AbortSignal;
    codex?: boolean;
    nativeCatalogEnabled?: boolean;
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
      entries: { main: {} },
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
            buildCatalogModel("gpt-5.4-mini", {
              name: "Fixture model",
              maxTokens: 4_096,
              compat: { supportsTools: true },
            }),
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
      config: {
        appServer: { homeScope: options.homeScope },
        ...(options.nativeCatalogEnabled !== undefined
          ? { sessionCatalog: { enabled: options.nativeCatalogEnabled } }
          : {}),
      },
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
  if (options.codex) {
    pluginRegistry.agentHarnesses.push({
      pluginId: "codex",
      source: "test",
      harness: {
        id: "codex",
        label: "Codex",
        authBootstrap: "harness",
        conversationToolPolicySupport: "exact",
        runtimeArtifact: { validate: async () => true },
        authBinding: {
          fingerprint: async (params) => {
            const profile = params.authProfileStore.profiles[params.authProfileId];
            if (!profile) {
              return undefined;
            }
            if (profile.type === "oauth") {
              return fingerprintAuthProfileCredential({
                profileId: params.authProfileId,
                credential: profile,
              });
            }
            const resolvedAuth = await resolveAuth({
              provider: "openai",
              cfg: params.config,
              agentDir: params.agentDir,
              workspaceDir: workspace,
              profileId: params.authProfileId,
              lockedProfile: true,
              modelId: "gpt-5.4-mini",
              modelApi: "openai-responses",
              secretSentinels: true,
            });
            return fingerprintResolvedAuthProfileCredential({
              profileId: params.authProfileId,
              credential: profile,
              resolvedAuth,
            });
          },
        },
        supports: () => ({ supported: true }),
        runAttempt: async () => {
          throw new Error("Fixture setup uses the injected inference runner");
        },
      },
    });
  }
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
      () => realResolveAuth(input),
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
  const run = vi.fn<typeof embeddedAgent.runEmbeddedAgent>(async (params) => reply(params));
  // Every setup generation resolves the same provider used by login and the probe.
  vi.spyOn(runtimePlugins, "loadAgentRuntimePluginRegistryHandle").mockReturnValue(pluginRegistry);
  vi.spyOn(embeddedAgent, "runEmbeddedAgent").mockImplementation(run);
  const resolvePluginMetadataSnapshot = vi
    .spyOn(pluginMetadata, "resolvePluginMetadataSnapshot")
    .mockImplementation(metadata.bind);
  vi.spyOn(pluginMetadata, "resolvePluginMetadataSnapshotAsync").mockImplementation(
    async (params) => pluginMetadata.resolvePluginMetadataSnapshot(params),
  );
  const readCodexCliActiveApiKey = vi
    .spyOn(cliCredentials, "readCodexCliActiveApiKey")
    .mockReturnValue(null);
  vi.spyOn(providerRuntime, "resolvePluginProvidersCore").mockReturnValue([provider]);
  const resolveManifestProviderAuthChoice = vi
    .spyOn(providerChoices, "resolveManifestProviderAuthChoice")
    .mockReturnValue(choice);
  vi.spyOn(providerChoices, "resolveManifestProviderAuthChoices").mockReturnValue([choice]);
  vi.spyOn(modelAuth, "resolveApiKeyForProviderCore").mockImplementation(resolveAuth);
  if (options.codex) {
    vi.spyOn(codexRuntimePlugin, "ensureCodexRuntimePluginForModelSelection").mockImplementation(
      async ({ cfg }) => ({ ok: true, cfg, required: false }),
    );
    mockPluginRegistry([pluginRecord("openai"), pluginRecord("codex")]);
    vi.spyOn(pluginArtifactIdentity, "fingerprintPluginRuntimeArtifact").mockImplementation(
      (record) => `${record.pluginId}-runtime-v1`,
    );
  }
  const prompter = createWizardPrompter();
  const activate = (
    kind: Parameters<typeof activateSetupInference>[0]["kind"] = "provider-auth",
    activationConfirmed?: true,
    overrides: Pick<
      ActivateSetupInferenceParams,
      | "agentId"
      | "apiKey"
      | "signal"
      | "onActivationCompletion"
      | "modelTarget"
      | "modelRef"
      | "automaticSetup"
      | "assertCurrent"
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
      }),
    );
  const detect = () =>
    metadata.run(async () => {
      const backends = vi.spyOn(onboardInference, "detectInferenceBackends").mockResolvedValue([]);
      try {
        return await detectSetupInference();
      } finally {
        backends.mockRestore();
      }
    });
  return {
    activate,
    detect,
    runWithMetadata: metadata.run,
    agentDir,
    before,
    config,
    configPath,
    workspace,
    readProfile,
    reply,
    resolveAuth,
    run,
    resolvePluginMetadataSnapshot,
    readCodexCliActiveApiKey,
    login,
    prompter,
    resolveManifestProviderAuthChoice,
    pluginRegistry,
    provider,
  };
}
