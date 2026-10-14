import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  createApiKeyCredential,
  createOAuthRefreshCredential,
} from "../../agents/auth-profiles/credential-fixtures.test-support.js";
import type { ModelDefinitionConfig } from "../../config/types.js";
import { getCurrentPluginMetadataSnapshot } from "../../plugins/current-plugin-metadata-snapshot.js";
import { setCurrentPluginMetadataSnapshot } from "../../plugins/current-plugin-metadata.test-support.js";
import { clearPluginMetadataLifecycleCaches } from "../../plugins/plugin-metadata-lifecycle.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { createTestRuntime } from "../test-runtime-config-helpers.js";
import {
  mocks,
  runStatus,
  jsonStatus,
  textStatus,
  requireProvider,
  expectResolveAgentDirCalledFor,
  configureAgentScope,
  statusConfig,
  configureStatus,
} from "./list.status.test-support.js";

describe("modelsStatusCommand auth overview", () => {
  it.each([
    {
      profileId: "anthropic:default",
      usage: { cooldownReason: "session_expired" as const },
      expected: {
        kind: "cooldown",
        reason: "session_expired",
        recoveryHint:
          "Re-authenticate with `openclaw models auth login --provider anthropic --profile-id 'anthropic:default'`.",
      },
      text: [
        "Unavailable auth profiles",
        "anthropic:default (anthropic) cooldown:session_expired",
        "openclaw models auth login --provider anthropic",
      ],
    },
    {
      profileId: "openai:default",
      usage: {
        cooldownReason: "auth" as const,
        cooldownClassification: "wham_token_expired" as const,
      },
      expected: { reason: "auth", classification: "wham_token_expired" },
      text: ["cooldown:wham_token_expired"],
    },
  ])(
    "reports cooldown diagnostics and recovery for $profileId",
    async ({ profileId, usage, expected, text }) => {
      const until = Date.now() + 60_000;
      mocks.store.usageStats = { [profileId]: { cooldownUntil: until, ...usage } };
      mocks.resolveProfileUnusableUntilForDisplay.mockImplementation((_store, id) =>
        id === profileId ? until : undefined,
      );
      const { payload } = await jsonStatus();
      expect(payload.auth.unusableProfiles).toEqual([
        expect.objectContaining({ profileId, ...expected }),
      ]);
      const result = await textStatus();
      for (const line of text) {
        expect(result.text).toContain(line);
      }
    },
  );

  it("keeps status metadata scoped while another operation publishes metadata", async () => {
    const scope = {
      config: mocks.loadConfig(),
      workspaceDir: "/tmp/openclaw-agent/workspace",
      env: process.env,
    };
    const catalogStarted = createDeferred();
    const releaseCatalog = createDeferred();
    let replacement: ReturnType<typeof getCurrentPluginMetadataSnapshot> = undefined;
    clearPluginMetadataLifecycleCaches();
    mocks.loadModelCatalog.mockImplementationOnce(async () => {
      replacement = getCurrentPluginMetadataSnapshot(scope);
      catalogStarted.resolve();
      await releaseCatalog.promise;
      return [];
    });
    const commandPromise = runStatus({ json: true }, createTestRuntime());

    try {
      await catalogStarted.promise;
      expect(replacement).toBeDefined();
      expect(getCurrentPluginMetadataSnapshot(scope)).toBeUndefined();
      clearPluginMetadataLifecycleCaches();
      setCurrentPluginMetadataSnapshot(replacement!, scope);
      releaseCatalog.resolve();
      await commandPromise;

      expect(getCurrentPluginMetadataSnapshot(scope)).toBe(replacement);
    } finally {
      releaseCatalog.resolve();
      await commandPromise.catch(() => {});
      clearPluginMetadataLifecycleCaches();
    }
  });

  it.each([[{ probeConcurrency: "2.5" }, "--probe-concurrency"]])(
    "rejects invalid probe numeric option %j",
    async (opts, label) => {
      const localRuntime = createTestRuntime();
      mocks.runAuthProbes.mockClear();
      await expect(runStatus({ json: true, probe: true, ...opts }, localRuntime)).rejects.toThrow(
        label,
      );
      expect(mocks.runAuthProbes).not.toHaveBeenCalled();
      expect(localRuntime.log).not.toHaveBeenCalled();
    },
  );

  it("forwards probe numeric options", async () => {
    await jsonStatus({
      probe: true,
      probeTimeout: "1.5",
      probeConcurrency: "1",
      probeMaxTokens: "1",
    });
    expect(mocks.runAuthProbes).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        options: expect.objectContaining({ timeoutMs: 1.5, concurrency: 1, maxTokens: 1 }),
      }),
    );
  });

  it("expands nested wildcard policy entries to the models they actually allow", async () => {
    configureStatus({
      primary: "clawrouter/anthropic/claude-haiku-4-5",
      profiles: {},
      modelPolicyAllow: ["clawrouter/anthropic/*"],
      catalog: [
        {
          provider: "clawrouter",
          id: "anthropic/claude-haiku-4-5",
          name: "Claude Haiku",
        },
        {
          provider: "clawrouter",
          id: "google/gemini-3.5-flash",
          name: "Gemini Flash",
        },
        { provider: "openai", id: "gpt-5.6-sol", name: "GPT-5.6 Sol" },
      ],
    });

    const { payload } = await jsonStatus();
    expect(JSON.stringify(payload.auth)).not.toContain("abc123");

    expect(payload.allowed).toEqual(["clawrouter/anthropic/claude-haiku-4-5"]);
  });

  it("preserves a restrictive wildcard when the current catalog has no match", async () => {
    configureStatus({
      primary: "openai/gpt-5.6-sol",
      profiles: {},
      modelPolicyAllow: ["clawrouter/anthropic/*"],
      catalog: [{ provider: "openai", id: "gpt-5.6-sol", name: "GPT-5.6 Sol" }],
    });

    const { payload } = await jsonStatus();

    expect(payload.allowed).toEqual(["clawrouter/anthropic/*"]);
  });

  it("honors OPENCLAW_AGENT_DIR when no --agent override is provided", async () => {
    const { payload } = await withEnvAsync(
      { OPENCLAW_AGENT_DIR: "/tmp/openclaw-isolated-agent" },
      () => jsonStatus(),
    );

    expectResolveAgentDirCalledFor("main");
    expect(mocks.ensureAuthProfileStore).toHaveBeenCalledWith("/tmp/openclaw-isolated-agent");
    expect(payload.agentDir).toBe("/tmp/openclaw-isolated-agent");
    expect(payload.auth.storePath).toBe("/tmp/openclaw-isolated-agent/auth-profiles.json");
  });

  it("uses agent overrides and reports sources", async () => {
    configureAgentScope({
      primary: "openai/gpt-4",
      fallbacks: ["openai/gpt-3.5"],
      agentDir: "/tmp/openclaw-agent-custom",
    });

    const { payload } = await jsonStatus({ agent: "Jeremiah" });
    expectResolveAgentDirCalledFor("jeremiah");
    expect(payload.agentId).toBe("jeremiah");
    expect(payload.agentDir).toBe("/tmp/openclaw-agent-custom");
    expect(payload.defaultModel).toBe("openai/gpt-4");
    expect(payload.fallbacks).toEqual(["openai/gpt-3.5"]);
    expect(payload.modelConfig).toEqual({
      defaultSource: "agent",
      fallbacksSource: "agent",
    });
    const openAiCodex = requireProvider(payload.auth.providers, "openai");
    expect(openAiCodex.effective).toEqual({
      kind: "profiles",
      detail: "/tmp/openclaw-agent-custom/auth-profiles.json",
    });
  });

  it("resolves model aliases in the selected agent scope", async () => {
    mocks.loadConfig.mockReturnValue({
      agents: {
        defaults: {
          model: { primary: "openai/gpt-default", fallbacks: [] },
          models: { "openai/gpt-shared": { alias: "shared" } },
        },
        entries: {
          jeremiah: {
            model: { primary: "shared" },
            models: { "anthropic/claude-sonnet-4-6": { alias: "shared" } },
          },
        },
      },
    });

    const { payload } = await jsonStatus({ agent: "jeremiah" });
    expect(payload.defaultModel).toBe("shared");
    expect(payload.resolvedDefault).toBe("anthropic/claude-sonnet-4-6");
    expect(payload.aliases).toMatchObject({ shared: "anthropic/claude-sonnet-4-6" });
  });

  it("uses system-agent storage without changing unscoped model output", async () => {
    mocks.resolveAgentNativeModelPrimary.mockClear();
    mocks.resolveAgentModelFallbacksOverride.mockClear();
    mocks.loadModelCatalog.mockClear();
    mocks.loadConfig.mockReturnValue({
      agents: {
        ownership: "explicit",
        defaults: {
          model: { primary: "anthropic/claude-opus-4-6", fallbacks: [] },
          systemAgent: { agentId: "jeremiah" },
        },
        entries: { main: {}, jeremiah: {} },
      },
      models: { providers: {} },
    });
    configureAgentScope({ primary: "openai/gpt-5.6-luna", fallbacks: ["openai/gpt-5.6-sol"] });

    const { payload } = await jsonStatus();
    expectResolveAgentDirCalledFor("jeremiah");
    expect(mocks.resolveAgentNativeModelPrimary).not.toHaveBeenCalled();
    expect(mocks.loadModelCatalog).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "jeremiah", readOnly: true }),
    );
    expect(payload).toMatchObject({
      defaultModel: "anthropic/claude-opus-4-6",
      fallbacks: [],
    });
  });

  it("rejects API-key auth for subscription-only Codex Spark", async () => {
    configureStatus({
      primary: "openai/gpt-5.3-codex-spark",
      profiles: {
        "openai:api-key": createApiKeyCredential("openai", "sk-openai-platform-only"),
      },
    });

    const { runtime: localRuntime, payload } = await jsonStatus({ check: true });
    const { text } = await textStatus({ check: true });
    expect(payload.auth.missingProvidersInUse).toEqual(["openai"]);
    expect(payload.auth.runtimeAuthRoutes).toEqual([
      {
        provider: "openai",
        runtime: "codex",
        authProvider: "openai",
        status: "missing",
        effective: { kind: "missing", detail: "missing" },
      },
    ]);
    expect(localRuntime.exit).toHaveBeenCalledWith(1);
    expect(text).not.toContain("set an API key env var");
  });

  it("reports usable Codex auth as unavailable when its harness plugin is quarantined", async () => {
    const payloadFailure = {
      pluginId: "codex",
      installPath: "/private/plugin",
      reason: "missing-package-dir" as const,
      detail: "missing",
    };
    mocks.runPluginPayloadSmokeCheckForManifestRecords
      .mockResolvedValueOnce({ checked: ["codex"], failures: [payloadFailure] })
      .mockResolvedValueOnce({ checked: ["codex"], failures: [payloadFailure] });
    const resolveAvailability = (params: {
      payloadFailures: Array<{ pluginId: string; reason: string }>;
    }) =>
      params.payloadFailures.some((failure) => failure.pluginId === "codex")
        ? {
            status: "unavailable",
            ownerPluginIds: ["codex", "openai"],
            reason: "owner-plugin-degraded",
            detail:
              'Agent harness "codex" owner plugin "codex" is unavailable (missing-package-dir).',
          }
        : { status: "available", ownerPluginIds: ["codex", "openai"] };
    mocks.resolveAgentHarnessRuntimeAvailability
      .mockImplementationOnce(resolveAvailability)
      .mockImplementationOnce(resolveAvailability);
    configureStatus({
      primary: "openai/gpt-5.5",
      profiles: {
        "openai:default": createOAuthRefreshCredential({
          access: "oauth-access",
          refresh: "oauth-refresh",
        }),
      },
    });

    const { runtime: localRuntime, payload } = await jsonStatus({ check: true });
    const { runtime: textRuntime, text } = await textStatus({ check: true });

    expect(mocks.runPluginPayloadSmokeCheckForManifestRecords).toHaveBeenCalledWith(
      expect.objectContaining({ env: process.env }),
    );
    expect(mocks.resolveAgentHarnessRuntimeAvailability).toHaveBeenCalledWith(
      expect.objectContaining({
        runtime: "codex",
        provider: "openai",
        payloadFailures: [payloadFailure],
        payloadCheckedPluginIds: ["codex"],
        selectedPluginRootDirs: expect.any(Map),
      }),
    );
    expect(payload.auth.runtimeAuthRoutes).toEqual([
      {
        provider: "openai",
        runtime: "codex",
        authProvider: "openai",
        status: "unavailable",
        authStatus: "usable",
        runtimeStatus: "unavailable",
        runtimeReason: "owner-plugin-degraded",
        runtimeDetail:
          'Agent harness "codex" owner plugin "codex" is unavailable (missing-package-dir).',
        runtimePluginIds: ["codex", "openai"],
        effective: {
          kind: "profiles",
          detail: "/tmp/openclaw-agent/auth-profiles.json",
        },
      },
    ]);
    expect(localRuntime.exit).toHaveBeenCalledWith(1);
    expect(textRuntime.exit).toHaveBeenCalledWith(1);
    expect(text).toContain("status=unavailable");
    expect(text).toContain("auth=usable");
    expect(text).toContain("runtime=unavailable");
  });

  it("flags a utility model whose route needs api-key auth despite an OAuth-healthy primary", async () => {
    configureStatus({
      primary: "openai/gpt-5.5",
      utilityModel: "openai/gpt-5.6",
      profiles: {
        "openai:default": createOAuthRefreshCredential({
          access: "oauth-access",
          refresh: "oauth-refresh",
        }),
      },
    });

    const { payload } = await jsonStatus({ check: true });
    expect(payload.utilityModel).toEqual({ ref: "openai/gpt-5.6", source: "config" });
    expect(payload.auth.modelRouteIssues).toEqual([
      {
        kind: "missing-auth",
        provider: "openai",
        model: "gpt-5.6",
        authRequirement: "api-key",
        message: "No usable api-key authentication is available for openai/gpt-5.6.",
      },
    ]);
  });

  it("reports incompatible model routes separately in JSON and text", async () => {
    configureStatus({
      primary: "openai/gpt-5.6",
      profiles: {},
      routeOverride: () => ({
        kind: "incompatible",
        code: "platform-only-model-on-chatgpt",
        message: "gpt-5.6 is available only through OpenAI Platform API-key authentication.",
      }),
    });

    const { runtime: jsonRuntime, payload } = await jsonStatus({ check: true });
    const { runtime: textRuntime, text } = await textStatus({ check: true });
    expect(payload.auth.missingProvidersInUse).toEqual([]);
    expect(payload.auth.modelRouteIssues).toEqual([
      {
        kind: "incompatible",
        provider: "openai",
        model: "gpt-5.6",
        code: "platform-only-model-on-chatgpt",
        message: "gpt-5.6 is available only through OpenAI Platform API-key authentication.",
      },
    ]);
    expect(text).toContain("openai/gpt-5.6");
    expect(text).toContain("platform-only-model-on-chatgpt");
    expect(text).toContain("available only through OpenAI Platform API-key authentication");
    expect(jsonRuntime.exit).toHaveBeenCalledWith(1);
    expect(textRuntime.exit).toHaveBeenCalledWith(1);
  });

  it("selects ChatGPT nano when grouped physical routes put Platform first", async () => {
    const platform = {
      id: "gpt-5.4-nano",
      name: "Platform Nano",
      provider: "openai",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
    };
    const chatGPT = {
      id: "openai/gpt-5.4-nano",
      name: "ChatGPT Nano",
      provider: "openai",
      api: "openai-chatgpt-responses",
      baseUrl: "https://chatgpt.com/backend-api/codex",
    };
    configureStatus({
      primary: "openai/gpt-5.4-nano",
      profiles: {
        "openai:subscription": createOAuthRefreshCredential({
          access: "subscription-access",
          refresh: "subscription-refresh",
          expires: Date.now() + 10 * 60_000,
        }),
      },
      authOrder: ["openai:subscription"],
      catalog: [platform],
      routeVariants: [platform, chatGPT],
    });

    const { runtime: localRuntime, payload } = await jsonStatus({ check: true });

    expect(payload.auth.missingProvidersInUse).toEqual([]);
    expect(payload.auth.modelRouteIssues).toEqual([]);
    expect(localRuntime.exit).not.toHaveBeenCalledWith(1);
  });

  it("keeps model status independent of differently cased routes", async () => {
    const responsesId = "rEaDeR";
    const baseUrl = "https://models.example.test/v1";
    const model = (id: string, api?: ModelDefinitionConfig["api"]): ModelDefinitionConfig => ({
      id,
      name: id,
      api,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 8192,
      maxTokens: 1024,
    });
    const providerModels = [
      model("Reader", "openai-completions"),
      model(responsesId, "openai-responses"),
      model("reader"),
    ];
    const catalog = providerModels.map((entry) => ({ ...entry, provider: "openai", baseUrl }));
    const fallbacks = [`openai/${responsesId}`, "openai/reader"];
    configureStatus({
      primary: "openai/Reader",
      fallbacks,
      profiles: {
        "openai:default": createApiKeyCredential("openai", "status-proof"),
      },
      providerBaseUrl: baseUrl,
      providerModels,
      catalog,
      routeVariants: catalog,
    });

    const { runtime: localRuntime, payload } = await jsonStatus({ check: true });

    expect(payload.defaultModel).toBe("openai/Reader");
    expect(payload.fallbacks).toEqual(fallbacks);
    expect(payload.auth.modelRouteIssues).toEqual([]);
    expect(payload.auth.missingProvidersInUse).toEqual([]);
    expect(payload.auth.runtimeAuthRoutes).toEqual([]);
    expect(localRuntime.exit).toHaveBeenCalledWith(0);
  });

  it("reports unresolved API-key SecretRef profiles as indeterminate", async () => {
    configureStatus({
      primary: "openai/gpt-5.6",
      profiles: {
        "openai:ref": {
          type: "api_key",
          provider: "openai",
          keyRef: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
        },
      },
    });
    const { runtime: localRuntime, payload } = await withEnvAsync(
      { OPENAI_API_KEY: undefined },
      () => jsonStatus({ check: true }),
    );
    expect(payload.auth.missingProvidersInUse).toEqual([]);
    expect(payload.auth.modelRouteIssues).toEqual([
      expect.objectContaining({
        kind: "indeterminate",
        provider: "openai",
        model: "gpt-5.6",
        evidence: "profile",
      }),
    ]);
    expect(localRuntime.exit).toHaveBeenCalledWith(1);
  });

  it("handles cli backend and exact provider auth summaries", async () => {
    mocks.loadConfig.mockReturnValue(statusConfig("claude-cli/claude-sonnet-4-6", [], true));
    mocks.resolveEnvApiKey.mockImplementation(() => null);

    const { payload } = await jsonStatus();
    expect(payload.defaultModel).toBe("claude-cli/claude-sonnet-4-6");
    expect(payload.auth.missingProvidersInUse).toStrictEqual([]);

    mocks.loadConfig.mockReturnValue({
      ...statusConfig("z.ai/glm-4.7", [], true),
      models: { providers: { "z.ai": {} } },
    });
    mocks.resolveEnvApiKey.mockImplementation((provider: string) => {
      if (provider === "zai" || provider === "z.ai" || provider === "z-ai") {
        return {
          apiKey: "sk-zai-0123456789abcdefghijklmnopqrstuvwxyz", // pragma: allowlist secret
          source: "shell env: ZAI_API_KEY",
        };
      }
      return null;
    });
    const { payload: aliasPayload } = await jsonStatus();
    const providers = aliasPayload.auth.providers as Array<{ provider: string }>;
    expect(
      providers.reduce((count, provider) => count + (provider.provider === "z.ai" ? 1 : 0), 0),
    ).toBe(1);
    expect(providers.map((provider) => provider.provider)).not.toContain("zai");
  });

  it("treats plugin-owned synthetic auth as usable for models in use", async () => {
    mocks.loadConfig.mockReturnValue(statusConfig("codex/gpt-5.5"));
    mocks.resolveEnvApiKey.mockImplementation(() => null);
    mocks.resolveRuntimeSyntheticAuthProviderRefs.mockReturnValue(["codex", "unused-synthetic"]);
    mocks.resolveProviderSyntheticAuthWithPlugin.mockImplementation(
      ({ provider }: { provider: string }) =>
        provider === "codex"
          ? {
              apiKey: "codex-runtime-token",
              source: "codex-app-server",
              mode: "token",
              expiresAt: Date.now() + 60_000,
            }
          : undefined,
    );

    const syntheticProbeStart = mocks.resolveProviderSyntheticAuthWithPlugin.mock.calls.length;
    const { payload } = await jsonStatus();
    const syntheticProbeProviders = mocks.resolveProviderSyntheticAuthWithPlugin.mock.calls
      .slice(syntheticProbeStart)
      .map(([arg]) => (arg as { provider: string }).provider);
    expect(payload.auth.missingProvidersInUse).toStrictEqual([]);
    const codexProvider = requireProvider(payload.auth.providers, "codex");
    expect(codexProvider.syntheticAuth).toEqual({
      value: "plugin-owned",
      source: "codex-app-server",
    });
    expect(JSON.stringify(payload)).not.toContain("codex-runtime-token");
    expect(codexProvider.effective).toEqual({ kind: "synthetic", detail: "codex-app-server" });
    expect(syntheticProbeProviders).toStrictEqual(["codex"]);
    expect(payload.auth.providers).not.toContainEqual(
      expect.objectContaining({ provider: "unused-synthetic" }),
    );
  });

  it("does not treat declared but unresolved synthetic auth as usable", async () => {
    mocks.loadConfig.mockReturnValue(statusConfig("codex/gpt-5.5"));
    mocks.store.profiles = {};
    mocks.resolveEnvApiKey.mockImplementation(() => null);
    mocks.resolveRuntimeSyntheticAuthProviderRefs.mockReturnValue(["codex"]);
    mocks.resolveProviderSyntheticAuthWithPlugin.mockReturnValue(undefined);

    const { runtime: localRuntime, payload } = await jsonStatus({ check: true });
    expect(payload.auth.missingProvidersInUse).toEqual([]);
    expect(payload.auth.modelRouteIssues).toEqual([
      expect.objectContaining({ kind: "indeterminate", provider: "codex" }),
    ]);
    expect(localRuntime.exit).toHaveBeenCalledWith(1);
  });

  it("reports and probes native defaults with a separate harness model", async () => {
    const primary = "anthropic/claude-opus-4-6";
    const fallbacks = ["anthropic/claude-sonnet-4-6"];
    mocks.loadConfig.mockReturnValue({
      agents: {
        defaults: { model: { primary, fallbacks }, utilityModel: "" },
        entries: {
          main: {
            model: "openai/gpt-5.4",
            runtime: { type: "acp", acp: { agent: "cursor" } },
          },
        },
      },
    });

    const { text: output } = await textStatus({ agent: "main" });

    const { payload } = await jsonStatus({ probe: true, agent: "main" });
    expect(mocks.runAuthProbes).toHaveBeenLastCalledWith(
      expect.objectContaining({ modelCandidates: [primary, ...fallbacks] }),
    );
    expect(payload.defaultModel).toBe(primary);
    expect(payload.resolvedDefault).toBe(primary);
    expect(payload.fallbacks).toEqual(fallbacks);
    expect(payload.modelConfig).toEqual({
      defaultSource: "defaults",
      fallbacksSource: "defaults",
    });
    expect(output).toContain("Default (defaults)");
    expect(output).toContain(`Fallbacks (${fallbacks.length}) (defaults)`);
    expect(mocks.ensureAuthProfileStore).toHaveBeenLastCalledWith("/tmp/openclaw-agent");
  });

  it("exits non-zero when auth is missing", async () => {
    mocks.store.profiles = {};
    const localRuntime = {
      ...createTestRuntime(),
      writeStdout: vi.fn(),
      writeJson: vi.fn(),
    };

    mocks.resolveEnvApiKey.mockImplementation(() => null);

    await runStatus({ check: true, plain: true }, localRuntime);
    expect(localRuntime.writeStdout).toHaveBeenCalledOnce();
    expect(localRuntime.log).not.toHaveBeenCalled();
    expect(localRuntime.exit).toHaveBeenCalledWith(1);
  });
});
