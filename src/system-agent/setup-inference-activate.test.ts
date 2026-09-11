import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createWizardPrompter } from "../../test/helpers/wizard-prompter.js";
import { resolveAgentDir } from "../agents/agent-scope-config.js";
import { buildAuthHealthSummary } from "../agents/auth-health.js";
import { resolveApiKeyForProfile } from "../agents/auth-profiles/oauth.js";
import { resolveAuthProfileOrder } from "../agents/auth-profiles/order.js";
import { resolveAuthProfilePortability } from "../agents/auth-profiles/portability.js";
import { loadAuthProfileStoreWithoutExternalProfiles } from "../agents/auth-profiles/store-runtime.js";
import { fingerprintResolvedProviderAuth } from "../agents/execution-auth-binding.js";
import { resolveApiKeyForProviderCore } from "../agents/model-auth.js";
import { clearConfigCache, readConfigFileSnapshot } from "../config/config.js";
import { resolveAgentModelPrimaryValue } from "../config/model-input.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ProviderAuthChoiceMetadata } from "../plugins/provider-auth-choices.js";
import { persistProviderAuthProfilesAfterLogin } from "../plugins/provider-auth-persistence.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { withPluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";
import type { ProviderAuthResult, ProviderPlugin } from "../plugins/types.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { resolveSystemAgentConfiguredRouteFromConfig } from "./inference-route.js";
import { activateSetupInference } from "./setup-inference-activate.js";
import type { ActivateSetupInferenceDeps } from "./setup-inference-core.js";
import { detectSetupInference } from "./setup-inference-detect.js";
import { createSystemAgentPluginMetadataTestSnapshot } from "./system-agent.test-helpers.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const modelRef = "openai/gpt-4.1-mini";
const credential = { type: "api_key", provider: "openai", key: "fixture-saved-key" } as const;
type RunParams = Parameters<NonNullable<ActivateSetupInferenceDeps["runEmbeddedAgent"]>>[0];

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  clearConfigCache();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function fixture(
  options: {
    localService?: boolean;
    authMethod?: "oauth" | "api_key";
    profiles?: ProviderAuthResult["profiles"];
    restartRequired?: boolean;
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
  const config: OpenClawConfig = {
    gateway: { mode: "local" },
    plugins: { slots: { memory: "none" } },
    agents: {
      entries: { main: { default: true } },
      defaults: {
        workspace,
        skipBootstrap: true,
        models: { [modelRef]: { agentRuntime: { id: "openclaw" } } },
      },
    },
    models: {
      providers: {
        openai: {
          baseUrl: "https://provider.example/v1",
          api: "openai-responses",
          models: [
            {
              id: "gpt-4.1-mini",
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
    ...(options.authMethod === "api_key"
      ? { appGuidedSecret: true }
      : { appGuidedAuth: "oauth" as const }),
  };
  const login = vi.fn(async () => ({
    profiles: options.profiles ?? [{ profileId: "openai:fixture", credential }],
    defaultModel: modelRef,
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
      ([, value]) => value.type === "api_key" && value.key === credential.key,
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
      modelApi: "openai-responses",
      secretSentinels: true,
    });
    params.onSuccessfulAuthBinding?.({
      agentHarnessId: "openclaw",
      authProfileId: auth.profileId,
      authFingerprint: fingerprintResolvedProviderAuth(auth),
      modelId: "gpt-4.1-mini",
      modelApi: "openai-responses",
    });
    return {
      payloads: [{ text: "OK" }],
      meta: {
        durationMs: 1,
        executionTrace: { winnerProvider: "openai", winnerModel: "gpt-4.1-mini" },
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
  const activate = (kind: Parameters<typeof activateSetupInference>[0]["kind"] = "provider-auth") =>
    metadata.run(() =>
      activateSetupInference({
        kind,
        authChoice: choice.choiceId,
        modelRef,
        nativeSessionCatalogsEnabled: false,
        surface: "cli",
        runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
        prompter,
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
  const diagnostics = async (result: unknown) => {
    const snapshot = await readConfigFileSnapshot();
    return JSON.stringify({
      result,
      agentDir,
      runtimeAgentDir: resolveAgentDir(snapshot.runtimeConfig ?? snapshot.config, "main"),
      profileIds: Object.keys(loadAuthProfileStoreWithoutExternalProfiles(agentDir).profiles),
      savedSetup: readProfile()?.[1].setup,
      loginCount: login.mock.calls.length,
      turnCount: run.mock.calls.length,
    });
  };
  return {
    activate,
    detect,
    agentDir,
    before,
    config,
    configPath,
    readProfile,
    reply,
    resolveAuth,
    run,
    login,
    diagnostics,
    prompter,
  };
}

describe("setup activation credentials and configuration", () => {
  it.each([
    {
      name: "matching-last",
      matching: true,
      expectedCredentials: [credential],
      expectedTurns: 1,
    },
    { name: "missing-match", matching: false, expectedCredentials: [], expectedTurns: 0 },
  ])(
    "saves only the selected provider credential ($name)",
    async ({ matching, expectedCredentials, expectedTurns }) => {
      const unrelated = {
        profileId: "anthropic:unrelated",
        credential: {
          type: "api_key",
          provider: "anthropic",
          key: "unrelated-fixture-key",
        } as const,
      };
      const setup = await fixture({
        profiles: matching ? [unrelated, { profileId: "openai:fixture", credential }] : [unrelated],
      });
      setup.run.mockImplementation(async (params) => {
        expect(
          Object.values(loadAuthProfileStoreWithoutExternalProfiles(setup.agentDir).profiles),
        ).toEqual([expect.objectContaining(credential)]);
        return setup.reply(params);
      });

      const result = await setup.activate();

      expect(result, await setup.diagnostics(result)).toMatchObject({ ok: matching });
      expect(
        Object.values(loadAuthProfileStoreWithoutExternalProfiles(setup.agentDir).profiles),
      ).toEqual(expectedCredentials);
      expect(setup.run).toHaveBeenCalledTimes(expectedTurns);
      if (!matching) {
        expect(await fs.readFile(setup.configPath, "utf8")).toBe(setup.before);
      }
    },
  );

  it.each([false, true])(
    "saves the credential before one tool-free turn and commits after success (local service: %s)",
    async (localService) => {
      const setup = await fixture({ localService });
      setup.run.mockImplementation(async (params) => {
        expect(setup.readProfile()?.[1]).toMatchObject(credential);
        expect(await fs.readFile(setup.configPath, "utf8")).toBe(setup.before);
        expect(params.disableTools).toBe(true);
        expect(resolveAgentModelPrimaryValue(params.config?.agents?.defaults?.model)).toContain(
          modelRef,
        );
        return setup.reply(params);
      });

      const result = await setup.activate();
      expect(result, await setup.diagnostics(result)).toMatchObject({ ok: true, modelRef });

      expect(setup.run).toHaveBeenCalledOnce();
      expect(setup.login).toHaveBeenCalledOnce();
      const persisted = await readConfigFileSnapshot();
      expect(persisted.valid).toBe(true);
      expect(resolveAgentModelPrimaryValue(persisted.sourceConfig.agents?.defaults?.model)).toBe(
        `${modelRef}@${setup.readProfile()?.[0]}`,
      );
    },
  );

  it("retains the saved sign-in after rejection and retries without another login", async () => {
    const setup = await fixture();
    setup.run.mockImplementationOnce(async () => {
      expect(setup.readProfile()?.[1]).toMatchObject(credential);
      throw new Error("401 invalid_api_key: fixture provider rejected the request");
    });

    const rejected = await setup.activate();
    expect(rejected, await setup.diagnostics(rejected)).toMatchObject({ ok: false });

    expect(await fs.readFile(setup.configPath, "utf8")).toBe(setup.before);
    expect(setup.readProfile()?.[1], await setup.diagnostics(rejected)).toMatchObject(credential);
    const detection = await setup.detect();
    const saved = detection.candidates.find((candidate) =>
      candidate.kind.startsWith("saved-auth:"),
    );
    expect(saved).toMatchObject({ modelRef, credentials: true });
    if (!saved) {
      throw new Error("Setup did not offer the saved sign-in for retry");
    }

    const retried = await setup.activate(saved.kind);
    expect(retried, await setup.diagnostics(retried)).toMatchObject({ ok: true, modelRef });

    expect(setup.login).toHaveBeenCalledOnce();
    expect(setup.run).toHaveBeenCalledTimes(2);
    expect(setup.readProfile()?.[1]).toMatchObject(credential);
  });

  it.each([
    { explicitProfile: true, restartRequired: false },
    { explicitProfile: false, restartRequired: false },
    { explicitProfile: true, restartRequired: true },
  ])(
    "keeps a working credential and rotation when a replacement is rejected (configured: $explicitProfile, restart: $restartRequired)",
    async ({ explicitProfile, restartRequired }) => {
      const setup = await fixture({ restartRequired });
      const originalProfileId = "openai:fixture";
      const originalCredential = { ...credential, key: "working-original-key" };
      const configured: OpenClawConfig = {
        ...setup.config,
        agents: {
          ...setup.config.agents,
          defaults: {
            ...setup.config.agents?.defaults,
            model: { primary: `${modelRef}@${originalProfileId}` },
          },
        },
        ...(explicitProfile
          ? {
              auth: {
                profiles: { [originalProfileId]: { provider: "openai", mode: "api_key" as const } },
              },
            }
          : {}),
      };
      await persistProviderAuthProfilesAfterLogin({
        config: configured,
        agentDir: setup.agentDir,
        profiles: [{ profileId: originalProfileId, credential: originalCredential }],
      });
      const before = `${JSON.stringify(configured)}\n`;
      await fs.writeFile(setup.configPath, before);
      clearConfigCache();
      setup.run.mockRejectedValueOnce(new Error("401 invalid_api_key: replacement rejected"));

      const result = await setup.activate();

      expect(result, await setup.diagnostics(result)).toMatchObject({ ok: false });
      expect(await fs.readFile(setup.configPath, "utf8")).toBe(before);
      const store = loadAuthProfileStoreWithoutExternalProfiles(setup.agentDir);
      expect(resolveAuthProfileOrder({ cfg: configured, store, provider: "openai" })).toEqual([
        originalProfileId,
      ]);
      expect(store.profiles[originalProfileId]).toEqual(originalCredential);
      expect(setup.readProfile()?.[1]).toEqual(
        expect.objectContaining({
          ...credential,
          setup: expect.objectContaining({ replacement: true }),
        }),
      );
      const saved = setup.readProfile();
      if (!saved) {
        throw new Error("The rejected replacement was not saved");
      }
      const [savedId, savedCredential] = saved;
      expect(savedId).not.toBe(originalProfileId);
      expect(
        buildAuthHealthSummary({ store, cfg: configured }).profiles.find(
          (profile) => profile.profileId === savedId,
        ),
      ).toMatchObject({
        status: "missing",
        reasonCode: "setup_inactive",
        label: expect.stringContaining("inactive"),
      });
      expect(resolveAuthProfilePortability(savedCredential).portable).toBe(false);
      expect(
        await resolveApiKeyForProfile({
          cfg: configured,
          store,
          profileId: savedId,
          agentDir: setup.agentDir,
        }),
      ).toBeNull();
      const snapshot = await readConfigFileSnapshot();
      const route = await resolveSystemAgentConfiguredRouteFromConfig(
        snapshot.runtimeConfig ?? snapshot.config,
      );
      expect(route?.authProfileId).toBe(originalProfileId);
      if (!route) {
        throw new Error("The original configured route disappeared after replacement rejection");
      }
      const auth = await setup.resolveAuth({
        provider: route.provider,
        cfg: route.runConfig,
        agentDir: route.agentDir,
        profileId: route.authProfileId,
        lockedProfile: true,
        modelId: route.model,
        modelApi: "openai-responses",
        secretSentinels: false,
      });
      expect(auth.apiKey).toBe("working-original-key");
      expect(setup.run).toHaveBeenCalledOnce();

      const retryKind = `saved-auth:${encodeURIComponent(savedId)}` as const;
      const declined = await setup.activate(retryKind);
      expect(declined, await setup.diagnostics(declined)).toMatchObject({ ok: false });
      expect(setup.prompter.confirm).toHaveBeenCalledWith({
        message: "Connection verified. Activate this saved sign-in?",
        initialValue: false,
      });
      expect(await fs.readFile(setup.configPath, "utf8")).toBe(before);
      const inactive = loadAuthProfileStoreWithoutExternalProfiles(setup.agentDir);
      expect(inactive.order).toEqual(store.order);
      expect(inactive.lastGood).toEqual(store.lastGood);
      expect(inactive.usageStats).toEqual(store.usageStats);

      vi.mocked(setup.prompter.confirm).mockResolvedValue(true);
      const accepted = await setup.activate(retryKind);
      expect(accepted, await setup.diagnostics(accepted)).toMatchObject({ ok: true });
      expect(setup.readProfile()).toEqual([savedId, credential]);
      expect(setup.login).toHaveBeenCalledOnce();
      expect(setup.run).toHaveBeenCalledTimes(3);
      expect(
        loadAuthProfileStoreWithoutExternalProfiles(setup.agentDir).profiles[originalProfileId],
      ).toEqual(originalCredential);
    },
  );

  it("preserves an unrelated config edit when selecting the verified model", async () => {
    const setup = await fixture();
    const changed = `${JSON.stringify({ ...setup.config, messages: { ackReaction: "seen" } })}\n`;
    setup.run.mockImplementation(async (params) => {
      await fs.writeFile(setup.configPath, changed);
      clearConfigCache();
      return setup.reply(params);
    });

    const result = await setup.activate();
    expect(result, await setup.diagnostics(result)).toMatchObject({ ok: true, modelRef });

    const persisted = await readConfigFileSnapshot();
    expect(persisted.sourceConfig.messages?.ackReaction).toBe("seen");
    expect(resolveAgentModelPrimaryValue(persisted.sourceConfig.agents?.defaults?.model)).toBe(
      `${modelRef}@${setup.readProfile()?.[0]}`,
    );
    expect(setup.readProfile()?.[1]).toMatchObject(credential);
    expect(setup.run).toHaveBeenCalledOnce();
  });

  it("discovers a persisted API-key sign-in without an in-memory candidate or another login", async () => {
    const setup = await fixture({ authMethod: "api_key" });
    await persistProviderAuthProfilesAfterLogin({
      config: setup.config,
      agentDir: setup.agentDir,
      profiles: [{ profileId: "openai:fixture", credential }],
    });

    const detection = await setup.detect();
    const saved = detection.candidates.find((candidate) =>
      candidate.kind.startsWith("saved-auth:"),
    );
    expect(saved).toMatchObject({ modelRef, credentials: true });
    expect(await fs.readFile(setup.configPath, "utf8")).toBe(setup.before);
    if (!saved) {
      throw new Error("Setup did not discover the persisted sign-in");
    }
    const result = await setup.activate(saved.kind);

    expect(result, await setup.diagnostics(result)).toMatchObject({ ok: true, modelRef });
    expect(setup.login).not.toHaveBeenCalled();
    expect(setup.run).toHaveBeenCalledOnce();
    expect(setup.readProfile()?.[1]).toMatchObject(credential);
  });

  it("rejects a concurrent provider change without overwriting it or removing the sign-in", async () => {
    const setup = await fixture();
    const edited = structuredClone(setup.config);
    edited.models!.providers!.openai!.baseUrl = "https://changed.example/v1";
    const changed = `${JSON.stringify(edited)}\n`;
    setup.run.mockImplementation(async (params) => {
      await fs.writeFile(setup.configPath, changed);
      clearConfigCache();
      return setup.reply(params);
    });

    const result = await setup.activate();
    expect(result, await setup.diagnostics(result)).toMatchObject({ ok: false });

    expect(await fs.readFile(setup.configPath, "utf8"), await setup.diagnostics(result)).toBe(
      changed,
    );
    expect(setup.readProfile()?.[1]).toMatchObject(credential);
    expect(setup.run).toHaveBeenCalledOnce();
  });
});
