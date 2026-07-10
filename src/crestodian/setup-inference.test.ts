import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveAgentDir } from "../agents/agent-scope-config.js";
import {
  readAuthProfileStoreForTest,
  removeOAuthTestTempRoot,
} from "../agents/auth-profiles/oauth-test-utils.js";
import { upsertAuthProfileWithLock } from "../agents/auth-profiles/profiles.js";
import { updateAuthProfileStoreWithLock } from "../agents/auth-profiles/store.js";
import { detectInferenceBackends } from "../commands/onboard-inference.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { withoutPluginInstallRecords } from "../plugins/installed-plugin-index-records.js";
import { hasRetainedManagedNpmInstallMarker } from "../plugins/managed-npm-retention.js";
import type { ProviderAuthChoiceMetadata } from "../plugins/provider-auth-choices.js";
import type { ProviderPlugin } from "../plugins/types.js";
import { resolveCrestodianConfiguredRouteFromConfig } from "./inference-route.js";
import { applyCrestodianModelSelection } from "./setup-apply.js";
import {
  activateSetupInference,
  detectSetupInference,
  listSetupInferenceManualProviders,
  verifySetupInference,
  verifySetupInferenceConfig,
} from "./setup-inference.js";

vi.mock("../config/config.js", () => ({
  readConfigFileSnapshot: vi.fn(async () => ({
    exists: false,
    valid: false,
    path: "/tmp/openclaw.json",
    issues: [],
    config: {},
  })),
}));

vi.mock("../commands/onboard-inference.js", async (importActual) => {
  const actual = await importActual<typeof import("../commands/onboard-inference.js")>();
  return {
    ...actual,
    detectInferenceBackends: vi.fn(async () => [
      {
        kind: "claude-cli",
        modelRef: "claude-cli/claude-opus-4-8",
        label: "Claude Code",
        detail: "logged in",
        credentials: true,
      },
      {
        kind: "codex-cli",
        modelRef: "openai/gpt-5.5",
        label: "Codex",
        detail: "installed, not logged in",
        credentials: false,
      },
    ]),
  };
});

const runtime = { log: () => {}, error: () => {}, exit: () => {} } as never;

async function makeTempDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "setup-inference-test-"));
}

function successfulRun(provider: string, model: string) {
  return {
    meta: {
      finalAssistantVisibleText: "OK",
      executionTrace: { winnerProvider: provider, winnerModel: model },
    },
  };
}

function createConfigTransformHarness(
  sourceConfig: OpenClawConfig = {},
  runtimeConfig: OpenClawConfig = sourceConfig,
) {
  const state = {
    sourceConfig: structuredClone(sourceConfig),
    runtimeConfig: structuredClone(runtimeConfig),
  };
  const transform = vi.fn(
    async (params: {
      transform: (
        config: OpenClawConfig,
        context: {
          snapshot: {
            exists: true;
            valid: true;
            path: string;
            config: OpenClawConfig;
            sourceConfig: OpenClawConfig;
            runtimeConfig: OpenClawConfig;
          };
          previousHash: string | null;
          attempt: number;
        },
      ) => Promise<{ nextConfig: OpenClawConfig }> | { nextConfig: OpenClawConfig };
    }) => {
      const transformed = await params.transform(state.sourceConfig, {
        snapshot: {
          exists: true,
          valid: true,
          path: "/tmp/openclaw.json",
          config: state.runtimeConfig,
          sourceConfig: state.sourceConfig,
          runtimeConfig: state.runtimeConfig,
        },
        previousHash: null,
        attempt: 0,
      });
      state.sourceConfig = withoutPluginInstallRecords(transformed.nextConfig);
      state.runtimeConfig = structuredClone(state.sourceConfig);
      return { nextConfig: state.sourceConfig };
    },
  );
  return {
    transform,
    current: () => structuredClone(state.sourceConfig),
  };
}

describe("applyCrestodianModelSelection", () => {
  it("pins a verified credential without putting the profile suffix in model metadata", async () => {
    const result = await applyCrestodianModelSelection({
      config: {},
      model: "openai/gpt-5.5",
      authProfileId: "openai:setup-123",
    });

    expect(result.agents?.defaults?.model).toBe("openai/gpt-5.5@openai:setup-123");
    expect(result.agents?.defaults?.models).toEqual({ "openai/gpt-5.5": {} });
  });

  it("overrides higher-priority runtime metadata on an inheriting default agent", async () => {
    const config = {
      agents: {
        defaults: { model: { primary: "openai/gpt-5.4" } },
        list: [
          {
            id: "ops",
            default: true,
            models: {
              "openai/gpt-5.5": { agentRuntime: { id: "openclaw" } },
            },
          },
        ],
      },
    } satisfies OpenClawConfig;

    const result = await applyCrestodianModelSelection({
      config,
      model: "openai/gpt-5.5",
      agentRuntimeId: "codex",
    });

    expect(result.agents?.defaults?.model).toMatchObject({ primary: "openai/gpt-5.5" });
    expect(result.agents?.list?.[0]).toMatchObject({
      id: "ops",
      models: { "openai/gpt-5.5": { agentRuntime: { id: "codex" } } },
    });
    expect(config.agents.list[0]?.models["openai/gpt-5.5"]?.agentRuntime?.id).toBe("openclaw");
  });
});

describe("detectSetupInference", () => {
  it("marks the first non-logged-out candidate recommended", async () => {
    const resolveManifestProviderAuthChoices = vi.fn(() => []);
    const detection = await detectSetupInference({ resolveManifestProviderAuthChoices });
    expect(detection.candidates).toHaveLength(2);
    expect(detection.candidates[0]).toMatchObject({ kind: "claude-cli", recommended: true });
    expect(detection.candidates[1]).toMatchObject({ kind: "codex-cli", recommended: false });
    expect(detection.setupComplete).toBe(false);
    expect(detection.workspace.length).toBeGreaterThan(0);
    expect(resolveManifestProviderAuthChoices).toHaveBeenCalledWith(
      expect.objectContaining({ includeWorkspacePlugins: false }),
    );
  });

  it("lists text-inference key and token methods from provider manifests", () => {
    const choices: ProviderAuthChoiceMetadata[] = [
      {
        pluginId: "visuals",
        providerId: "visuals",
        methodId: "api-key",
        choiceId: "visuals-api-key",
        choiceLabel: "Visuals API key",
        appGuidedSecret: true,
        onboardingScopes: ["image-generation"],
      },
      {
        pluginId: "zeta",
        providerId: "zeta",
        methodId: "oauth",
        choiceId: "zeta-oauth",
        choiceLabel: "Zeta OAuth",
      },
      {
        pluginId: "zeta",
        providerId: "zeta",
        methodId: "direct-key",
        choiceId: "zeta-api-key",
        choiceLabel: "Zeta API key",
        choiceHint: "Direct key",
        optionKey: "zetaApiKey",
        cliOption: "--zeta-api-key <key>",
        appGuidedSecret: true,
      },
      {
        pluginId: "alpha",
        providerId: "alpha",
        methodId: "api-key",
        choiceId: "alpha-api-key",
        choiceLabel: "Alpha API key",
        appGuidedSecret: true,
      },
      {
        pluginId: "github-copilot",
        providerId: "github-copilot",
        methodId: "device",
        choiceId: "github-copilot",
        choiceLabel: "GitHub Copilot",
        optionKey: "githubCopilotToken",
        cliOption: "--github-copilot-token <token>",
        appGuidedSecret: true,
      },
    ];

    expect(listSetupInferenceManualProviders(choices)).toEqual([
      {
        id: "alpha-api-key",
        label: "Alpha API key",
      },
      {
        id: "github-copilot",
        label: "GitHub Copilot",
      },
      {
        id: "zeta-api-key",
        label: "Zeta API key",
        hint: "Direct key",
      },
    ]);
  });

  it("marks a configured default-agent model as complete setup", async () => {
    vi.mocked(detectInferenceBackends).mockResolvedValueOnce([
      {
        kind: "existing-model",
        modelRef: "openai/gpt-5.5",
        label: "Current model",
        detail: "already configured",
        credentials: true,
      },
    ]);

    const detection = await detectSetupInference({ resolveManifestProviderAuthChoices: () => [] });

    expect(detection).toMatchObject({
      configuredModel: "openai/gpt-5.5",
      setupComplete: true,
    });
  });

  it("omits Gemini CLI because setup verification cannot hard-disable its tools", async () => {
    vi.mocked(detectInferenceBackends).mockResolvedValueOnce([
      {
        kind: "gemini-cli",
        modelRef: "google-gemini-cli/gemini-3.1-pro-preview",
        label: "Gemini CLI",
        detail: "logged in",
        credentials: true,
      },
      {
        kind: "claude-cli",
        modelRef: "claude-cli/claude-opus-4-8",
        label: "Claude Code",
        detail: "logged in",
        credentials: true,
      },
    ]);

    const detection = await detectSetupInference({ resolveManifestProviderAuthChoices: () => [] });

    expect(detection.candidates).toEqual([
      expect.objectContaining({ kind: "claude-cli", recommended: true }),
    ]);
  });
});

describe("activateSetupInference", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function createGroqSetupProvider(configPatch?: Partial<OpenClawConfig>): ProviderPlugin {
    return {
      id: "groq",
      label: "Groq",
      pluginId: "groq",
      auth: [
        {
          id: "api-key",
          label: "Groq API key",
          kind: "api_key",
          wizard: { choiceId: "groq-api-key" },
          run: async (ctx) => ({
            profiles: [
              {
                profileId: "groq:default",
                credential: {
                  type: "api_key" as const,
                  provider: "groq",
                  key: ctx.opts?.token,
                },
              },
            ],
            defaultModel: "groq/llama-3.3-70b-versatile",
            ...(configPatch !== undefined ? { configPatch } : {}),
          }),
        },
      ],
    };
  }

  function groqSetupChoice(): ProviderAuthChoiceMetadata {
    return {
      pluginId: "groq",
      providerId: "groq",
      methodId: "api-key",
      choiceId: "groq-api-key",
      choiceLabel: "Groq API key",
      appGuidedSecret: true,
    };
  }

  it("persists inference only after the live test succeeds", async () => {
    const configHarness = createConfigTransformHarness();
    const runCliAgent = vi.fn(async (_params: unknown) =>
      successfulRun("claude-cli", "claude-opus-4-8"),
    );
    const result = await activateSetupInference({
      kind: "claude-cli",
      surface: "gateway",
      runtime,
      deps: {
        runCliAgent: runCliAgent as never,
        transformConfigWithPendingPluginInstalls: configHarness.transform as never,
        createTempDir: makeTempDir,
      },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.modelRef).toBe("claude-cli/claude-opus-4-8");
      expect(result.lines).toEqual(["Inference verified: claude-cli/claude-opus-4-8"]);
    }
    expect(runCliAgent).toHaveBeenCalledOnce();
    expect(runCliAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        executionMode: "side-question",
        disableTools: true,
        cleanupCliLiveSessionOnRunEnd: true,
      }),
    );
    expect(configHarness.transform).toHaveBeenCalledOnce();
  });

  it("keeps a committed success when temporary cleanup fails", async () => {
    const configHarness = createConfigTransformHarness();
    const runtimeLog = vi.fn();
    const result = await activateSetupInference({
      kind: "claude-cli",
      surface: "gateway",
      runtime: { log: runtimeLog, error: () => {}, exit: () => {} } as never,
      deps: {
        runCliAgent: vi.fn(async () => successfulRun("claude-cli", "claude-opus-4-8")) as never,
        transformConfigWithPendingPluginInstalls: configHarness.transform as never,
        createTempDir: async () => "/tmp/openclaw-setup-cleanup-fixture",
        removeTempDir: async () => {
          throw new Error("simulated cleanup failure");
        },
      },
    });

    expect(result).toMatchObject({ ok: true, modelRef: "claude-cli/claude-opus-4-8" });
    expect(runtimeLog).not.toHaveBeenCalled();
  });

  it("reconciles a config write that committed before its writer threw", async () => {
    let committedConfig: OpenClawConfig | undefined;
    const readConfigFileSnapshot = vi.fn(async () => ({
      exists: true,
      valid: true,
      config: committedConfig ?? {},
      runtimeConfig: committedConfig ?? {},
    }));
    const transformConfig = vi.fn(
      async (params: {
        transform: (
          config: OpenClawConfig,
          context: { snapshot: { config: OpenClawConfig; runtimeConfig: OpenClawConfig } },
        ) => Promise<{ nextConfig: OpenClawConfig }>;
      }) => {
        committedConfig = (
          await params.transform({}, { snapshot: { config: {}, runtimeConfig: {} } })
        ).nextConfig;
        throw new Error("simulated post-write failure");
      },
    );

    const result = await activateSetupInference({
      kind: "claude-cli",
      surface: "gateway",
      runtime,
      deps: {
        readConfigFileSnapshot: readConfigFileSnapshot as never,
        runCliAgent: vi.fn(async () => successfulRun("claude-cli", "claude-opus-4-8")) as never,
        transformConfigWithPendingPluginInstalls: transformConfig as never,
        createTempDir: makeTempDir,
      },
    });

    expect(result).toMatchObject({ ok: true, modelRef: "claude-cli/claude-opus-4-8" });
    expect(committedConfig?.agents?.defaults?.model).toBe("claude-cli/claude-opus-4-8");
  });

  it("persists only the verified model before Crestodian configures the rest", async () => {
    const configHarness = createConfigTransformHarness();

    const result = await activateSetupInference({
      kind: "claude-cli",
      workspace: "/tmp/not-persisted-yet",
      surface: "cli",
      runtime,
      deps: {
        runCliAgent: vi.fn(async () => successfulRun("claude-cli", "claude-opus-4-8")) as never,
        transformConfigWithPendingPluginInstalls: configHarness.transform as never,
        createTempDir: makeTempDir,
      },
    });

    expect(result).toMatchObject({
      ok: true,
      modelRef: "claude-cli/claude-opus-4-8",
      lines: ["Inference verified: claude-cli/claude-opus-4-8"],
    });
    const persistedConfig = configHarness.current();
    expect(persistedConfig.agents?.defaults?.model).toBe("claude-cli/claude-opus-4-8");
    expect(persistedConfig.agents?.defaults?.workspace).toBeUndefined();
    expect(persistedConfig.gateway).toBeUndefined();
  });

  it("rebases model persistence on concurrent default-agent edits", async () => {
    const probedConfig: OpenClawConfig = {
      agents: { list: [{ id: "work", default: true, model: "openai/broken" }] },
    };
    const concurrentConfig: OpenClawConfig = {
      agents: {
        list: [
          { id: "work", default: true, model: "openai/broken", name: "edited during probe" },
          { id: "new-agent", model: "anthropic/claude-opus-4-8" },
        ],
      },
    };
    const configHarness = createConfigTransformHarness(concurrentConfig);

    const result = await activateSetupInference({
      kind: "claude-cli",
      surface: "cli",
      runtime,
      deps: {
        readConfigFileSnapshot: vi.fn(async () => ({
          exists: true,
          valid: true,
          config: probedConfig,
        })) as never,
        runCliAgent: vi.fn(async () => successfulRun("claude-cli", "claude-opus-4-8")) as never,
        transformConfigWithPendingPluginInstalls: configHarness.transform as never,
        createTempDir: makeTempDir,
      },
    });

    expect(result.ok).toBe(true);
    const persistedConfig = configHarness.current();
    expect(persistedConfig.agents?.list).toEqual([
      {
        id: "work",
        default: true,
        model: "claude-cli/claude-opus-4-8",
        name: "edited during probe",
        models: { "claude-cli/claude-opus-4-8": {} },
      },
      { id: "new-agent", model: "anthropic/claude-opus-4-8" },
    ]);
  });

  it.each([
    {
      name: "default model",
      concurrent: {
        agents: {
          list: [
            {
              id: "ops",
              default: true,
              agentDir: "/tmp/ops",
              model: "anthropic/claude-opus-4-8",
            },
            { id: "other", agentDir: "/tmp/other", model: "openai/broken" },
          ],
        },
      } satisfies OpenClawConfig,
    },
    {
      name: "default agent",
      concurrent: {
        agents: {
          list: [
            { id: "ops", agentDir: "/tmp/ops", model: "openai/broken" },
            { id: "other", default: true, agentDir: "/tmp/other", model: "openai/broken" },
          ],
        },
      } satisfies OpenClawConfig,
    },
    {
      name: "default agent directory",
      concurrent: {
        agents: {
          list: [
            {
              id: "ops",
              default: true,
              agentDir: "/tmp/ops-moved",
              model: "openai/broken",
            },
          ],
        },
      } satisfies OpenClawConfig,
    },
  ])("rejects a changed $name after the live probe", async ({ concurrent }) => {
    const probedConfig = {
      agents: {
        list: [
          { id: "ops", default: true, agentDir: "/tmp/ops", model: "openai/broken" },
          { id: "other", agentDir: "/tmp/other", model: "openai/broken" },
        ],
      },
    } satisfies OpenClawConfig;
    const configHarness = createConfigTransformHarness(concurrent);

    await expect(
      activateSetupInference({
        kind: "claude-cli",
        surface: "cli",
        runtime,
        deps: {
          readConfigFileSnapshot: vi.fn(async () => ({
            exists: true,
            valid: true,
            path: "/tmp/openclaw.json",
            issues: [],
            config: probedConfig,
            runtimeConfig: probedConfig,
          })) as never,
          runCliAgent: vi.fn(async () => successfulRun("claude-cli", "claude-opus-4-8")) as never,
          transformConfigWithPendingPluginInstalls: configHarness.transform as never,
          createTempDir: makeTempDir,
        },
      }),
    ).rejects.toThrow("route changed during its live test");

    expect(configHarness.current()).toEqual(concurrent);
  });

  it("rejects an existing route that changes after its live probe", async () => {
    const initialConfig = {
      agents: { defaults: { model: "openai/gpt-5.5" } },
    } satisfies OpenClawConfig;
    const changedConfig = {
      agents: { defaults: { model: "anthropic/claude-opus-4-8" } },
    } satisfies OpenClawConfig;
    const readConfigFileSnapshot = vi
      .fn()
      .mockResolvedValueOnce({ exists: true, valid: true, config: initialConfig })
      .mockResolvedValueOnce({ exists: true, valid: true, config: changedConfig });

    const result = await activateSetupInference({
      kind: "existing-model",
      surface: "gateway",
      runtime,
      deps: {
        readConfigFileSnapshot: readConfigFileSnapshot as never,
        runEmbeddedAgent: vi.fn(async () => successfulRun("openai", "gpt-5.5")) as never,
        createTempDir: makeTempDir,
      },
    });

    expect(result).toMatchObject({
      ok: false,
      status: "unknown",
      error: expect.stringContaining("route changed during its live test"),
    });
  });

  it("does not touch config when the live test fails", async () => {
    const providerSecret = "gsk_abcdefghijklmnop";
    const transformConfig = vi.fn();
    const runCliAgent = vi.fn(async () => {
      throw new Error(`401 invalid_api_key ${providerSecret}`);
    });
    const result = await activateSetupInference({
      kind: "claude-cli",
      surface: "gateway",
      runtime,
      deps: {
        runCliAgent: runCliAgent as never,
        transformConfigWithPendingPluginInstalls: transformConfig as never,
        createTempDir: makeTempDir,
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("invalid_api_key");
      expect(result.error).not.toContain(providerSecret);
    }
    expect(transformConfig).not.toHaveBeenCalled();
  });

  it("treats an empty model reply as a failure", async () => {
    const transformConfig = vi.fn();
    const runEmbeddedAgent = vi.fn(async () => ({ payloads: [] }));
    const result = await activateSetupInference({
      kind: "anthropic-api-key",
      surface: "gateway",
      runtime,
      deps: {
        runEmbeddedAgent: runEmbeddedAgent as never,
        transformConfigWithPendingPluginInstalls: transformConfig as never,
        createTempDir: makeTempDir,
      },
    });
    expect(result).toMatchObject({ ok: false, status: "format" });
    expect(runEmbeddedAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: expect.stringMatching(/^probe-setup-inference-/),
        sessionId: expect.stringMatching(/^probe-setup-inference-.*-session$/),
        sessionKey: expect.stringMatching(/^temp:setup-inference:probe-setup-inference-/),
        lane: "session:probe-setup-inference:anthropic",
      }),
    );
    expect(transformConfig).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "error payload",
      result: {
        payloads: [{ text: "Blocked by before-run policy.", isError: true }],
        meta: { finalAssistantVisibleText: "Blocked by before-run policy." },
      },
    },
    {
      name: "terminal metadata error",
      result: {
        payloads: [{ text: "Agent could not complete the turn." }],
        meta: {
          finalAssistantVisibleText: "Agent could not complete the turn.",
          error: { kind: "incomplete_turn", message: "Agent could not complete the turn." },
        },
      },
    },
    {
      name: "blocked liveness state",
      result: {
        payloads: [{ text: "Run stopped before completion." }],
        meta: {
          finalAssistantVisibleText: "Run stopped before completion.",
          livenessState: "blocked",
        },
      },
    },
  ])("does not persist inference for a non-throwing $name", async ({ result: runResult }) => {
    const transformConfig = vi.fn();
    const result = await activateSetupInference({
      kind: "anthropic-api-key",
      surface: "gateway",
      runtime,
      deps: {
        runEmbeddedAgent: vi.fn(async () => runResult) as never,
        transformConfigWithPendingPluginInstalls: transformConfig as never,
        createTempDir: makeTempDir,
      },
    });

    expect(result).toMatchObject({ ok: false, status: "unknown" });
    expect(transformConfig).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "missing winner metadata",
      runResult: { meta: { finalAssistantVisibleText: "OK" } },
      error: "did not report which provider and model",
    },
    {
      name: "model-routing override",
      runResult: successfulRun("openai", "gpt-5.5"),
      error: "instead of the requested anthropic/claude-opus-4-8",
    },
  ])("does not persist inference after a $name", async ({ runResult, error }) => {
    const transformConfig = vi.fn();
    const result = await activateSetupInference({
      kind: "anthropic-api-key",
      surface: "gateway",
      runtime,
      deps: {
        runEmbeddedAgent: vi.fn(async () => runResult) as never,
        transformConfigWithPendingPluginInstalls: transformConfig as never,
        createTempDir: makeTempDir,
      },
    });

    expect(result).toMatchObject({
      ok: false,
      status: "format",
      error: expect.stringContaining(error),
    });
    expect(transformConfig).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "provider-level CLI runtime",
      providerConfig: {
        baseUrl: "https://api.anthropic.com",
        models: [],
        agentRuntime: { id: "claude-cli" as const },
      },
    },
    {
      name: "model-definition CLI runtime",
      providerConfig: {
        baseUrl: "https://api.anthropic.com",
        models: [
          {
            id: "claude-opus-4-8",
            name: "Claude Opus 4.8",
            reasoning: true,
            input: ["text" as const],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 200_000,
            maxTokens: 8192,
            agentRuntime: { id: "claude-cli" as const },
          },
        ],
      },
    },
  ])("pins a built-in API candidate over a stale $name", async ({ providerConfig }) => {
    const initialConfig = {
      models: { providers: { anthropic: providerConfig } },
      agents: {
        defaults: { model: { primary: "openai/gpt-5.4" } },
        list: [
          {
            id: "ops",
            default: true,
            model: { primary: "openai/gpt-5.4" },
          },
        ],
      },
    } satisfies OpenClawConfig;
    const runEmbeddedAgent = vi.fn(async () => successfulRun("anthropic", "claude-opus-4-8"));
    const configHarness = createConfigTransformHarness(initialConfig);

    const result = await activateSetupInference({
      kind: "anthropic-api-key",
      surface: "gateway",
      runtime,
      deps: {
        readConfigFileSnapshot: vi.fn(async () => ({
          exists: true,
          valid: true,
          path: "/tmp/openclaw.json",
          issues: [],
          config: initialConfig,
          runtimeConfig: initialConfig,
        })) as never,
        runEmbeddedAgent: runEmbeddedAgent as never,
        transformConfigWithPendingPluginInstalls: configHarness.transform as never,
        createTempDir: makeTempDir,
      },
    });

    expect(result).toMatchObject({ ok: true, modelRef: "anthropic/claude-opus-4-8" });
    expect(runEmbeddedAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "crestodian",
        provider: "anthropic",
        model: "claude-opus-4-8",
        agentHarnessRuntimeOverride: "openclaw",
        config: expect.objectContaining({
          agents: expect.objectContaining({
            list: [
              expect.objectContaining({
                id: "ops",
                model: { primary: "anthropic/claude-opus-4-8" },
                models: {
                  "anthropic/claude-opus-4-8": {
                    agentRuntime: { id: "openclaw" },
                  },
                },
              }),
            ],
          }),
        }),
      }),
    );
    expect(configHarness.transform).toHaveBeenCalledOnce();
  });

  it("rejects manual activation without a supported provider", async () => {
    const result = await activateSetupInference({
      kind: "api-key",
      authChoice: "definitely-not-a-provider",
      apiKey: "sk-test",
      surface: "gateway",
      runtime,
      deps: {
        createTempDir: makeTempDir,
        resolveManifestProviderAuthChoice: () => undefined,
        resolvePluginProviders: () => [],
      },
    });
    expect(result).toMatchObject({ ok: false, status: "unavailable" });
  });

  it.each([
    { name: "API-key", authKind: "api_key" as const, credentialType: "api_key" as const },
    { name: "token", authKind: "token" as const, credentialType: "token" as const },
  ])(
    "uses a provider-owned $name method and persists it after a passing test",
    async ({ authKind, credentialType }) => {
      const stateDir = await makeTempDir();
      const agentDir = path.join(stateDir, "agent");
      const initialConfig = {
        agents: { list: [{ id: "main", default: true, agentDir }] },
        auth: {
          profiles: {
            "groq:legacy": { provider: "groq", mode: credentialType },
          },
        },
      } satisfies OpenClawConfig;
      // Custom agent directories must be bound to their configured owner before
      // the shared per-agent database is created.
      resolveAgentDir(initialConfig, "main");
      await upsertAuthProfileWithLock({
        profileId: "groq:legacy",
        credential:
          credentialType === "api_key"
            ? { type: "api_key", provider: "groq", key: "legacy-key" }
            : { type: "token", provider: "groq", token: "legacy-key" },
        agentDir,
      });
      await updateAuthProfileStoreWithLock({
        agentDir,
        updater: (store) => {
          store.order = { groq: ["groq:legacy"] };
          return true;
        },
      });
      const runAuth = vi.fn(async (ctx: { opts?: { token?: string } }) => ({
        profiles: [
          {
            profileId: "groq:default",
            credential:
              credentialType === "api_key"
                ? { type: "api_key" as const, provider: "groq", key: ctx.opts?.token }
                : { type: "token" as const, provider: "groq", token: ctx.opts?.token ?? "" },
          },
        ],
        defaultModel: "groq/llama-3.3-70b-versatile",
        configPatch: { agents: { defaults: { models: { "groq/llama-3.3-70b-versatile": {} } } } },
      }));
      const provider: ProviderPlugin = {
        id: "groq",
        label: "Groq",
        pluginId: "groq",
        auth: [
          {
            id: "api-key",
            label: "Groq API key",
            kind: authKind,
            wizard: { choiceId: "groq-api-key" },
            run: runAuth as never,
          },
        ],
      };
      const resolvePluginProviders = vi.fn(() => [provider]);
      const enablePluginInConfig = vi.fn((config: OpenClawConfig, pluginId: string) => ({
        config: {
          ...config,
          plugins: { entries: { [pluginId]: { enabled: true } } },
        },
        enabled: true,
      }));
      const runEmbeddedAgent = vi.fn(async (_params: { authProfileId?: string }) =>
        successfulRun("groq", "llama-3.3-70b-versatile"),
      );
      const configHarness = createConfigTransformHarness(initialConfig);

      try {
        const result = await activateSetupInference({
          kind: "api-key",
          authChoice: "groq-api-key",
          apiKey: "test-groq-key",
          workspace: "/tmp/openclaw-workspace",
          surface: "gateway",
          runtime,
          deps: {
            readConfigFileSnapshot: vi.fn(async () => ({
              exists: true,
              valid: true,
              path: "/tmp/openclaw.json",
              issues: [],
              config: initialConfig,
              runtimeConfig: initialConfig,
            })) as never,
            resolvePluginProviders,
            enablePluginInConfig: enablePluginInConfig as never,
            resolveManifestProviderAuthChoice: () => ({
              pluginId: "groq",
              providerId: "groq",
              methodId: "api-key",
              choiceId: "groq-api-key",
              choiceLabel: "Groq API key",
              appGuidedSecret: true,
            }),
            runEmbeddedAgent: runEmbeddedAgent as never,
            transformConfigWithPendingPluginInstalls: configHarness.transform as never,
            createTempDir: makeTempDir,
          },
        });

        expect(result).toMatchObject({ ok: true, modelRef: "groq/llama-3.3-70b-versatile" });
        expect(resolvePluginProviders).toHaveBeenCalledWith(
          expect.objectContaining({
            config: expect.objectContaining({
              plugins: { entries: { groq: { enabled: true } } },
            }),
            onlyPluginIds: ["groq"],
            workspaceDir: "/tmp/openclaw-workspace",
          }),
        );
        expect(runAuth).toHaveBeenCalledWith(
          expect.objectContaining({
            opts: expect.objectContaining({ token: "test-groq-key", tokenProvider: "groq" }),
            allowSecretRefPrompt: false,
            secretInputMode: "plaintext",
          }),
        );
        const activatedProfileId = runEmbeddedAgent.mock.calls[0]?.[0].authProfileId;
        if (!activatedProfileId) {
          throw new Error("expected setup auth profile");
        }
        expect(activatedProfileId).toMatch(/^groq:setup-/);
        expect(runEmbeddedAgent).toHaveBeenCalledWith(
          expect.objectContaining({
            agentId: "crestodian",
            provider: "groq",
            model: "llama-3.3-70b-versatile",
            authProfileId: activatedProfileId,
            agentDir: expect.stringContaining("setup-inference-test-"),
          }),
        );
        expect(configHarness.current()).toMatchObject({
          plugins: { entries: { groq: { enabled: true } } },
          agents: {
            defaults: {
              model: `groq/llama-3.3-70b-versatile@${activatedProfileId}`,
            },
          },
          auth: {
            profiles: {
              [activatedProfileId]: { provider: "groq", mode: credentialType },
            },
          },
        });
        expect(readAuthProfileStoreForTest(agentDir).profiles[activatedProfileId]).toMatchObject(
          credentialType === "api_key"
            ? { type: "api_key", provider: "groq", key: "test-groq-key" }
            : { type: "token", provider: "groq", token: "test-groq-key" },
        );
        expect(readAuthProfileStoreForTest(agentDir).order?.groq).toEqual(["groq:legacy"]);
        expect(
          (await resolveCrestodianConfiguredRouteFromConfig(configHarness.current()))
            ?.authProfileId,
        ).toBe(activatedProfileId);
      } finally {
        await removeOAuthTestTempRoot(stateDir);
      }
    },
  );

  it("rolls back a staged key when the config commit fails", async () => {
    const stateDir = await makeTempDir();
    const agentDir = path.join(stateDir, "agent");
    const initialConfig = {
      agents: { list: [{ id: "main", default: true, agentDir }] },
      auth: { profiles: { "groq:default": { provider: "groq", mode: "api_key" } } },
    } satisfies OpenClawConfig;
    resolveAgentDir(initialConfig, "main");
    const provider: ProviderPlugin = {
      id: "groq",
      label: "Groq",
      pluginId: "groq",
      auth: [
        {
          id: "api-key",
          label: "Groq API key",
          kind: "api_key",
          wizard: { choiceId: "groq-api-key" },
          run: async (ctx) => ({
            profiles: [
              {
                profileId: "groq:default",
                credential: {
                  type: "api_key" as const,
                  provider: "groq",
                  key: ctx.opts?.token,
                },
              },
            ],
            defaultModel: "groq/llama-3.3-70b-versatile",
          }),
        },
      ],
    };
    await upsertAuthProfileWithLock({
      profileId: "groq:default",
      credential: { type: "api_key", provider: "groq", key: "existing-key" },
      agentDir,
    });
    const transformConfig = vi.fn(async (params: { transform: Function }) => {
      await params.transform(initialConfig, {
        snapshot: { config: initialConfig, runtimeConfig: initialConfig },
        previousHash: null,
        attempt: 0,
      });
      throw new Error("simulated config commit failure");
    });

    try {
      await expect(
        activateSetupInference({
          kind: "api-key",
          authChoice: "groq-api-key",
          apiKey: "replacement-key",
          surface: "gateway",
          runtime,
          deps: {
            readConfigFileSnapshot: vi.fn(async () => ({
              exists: true,
              valid: true,
              config: initialConfig,
              runtimeConfig: initialConfig,
            })) as never,
            resolvePluginProviders: () => [provider],
            resolveManifestProviderAuthChoice: () => ({
              pluginId: "groq",
              providerId: "groq",
              methodId: "api-key",
              choiceId: "groq-api-key",
              choiceLabel: "Groq API key",
              appGuidedSecret: true,
            }),
            runEmbeddedAgent: vi.fn(async () =>
              successfulRun("groq", "llama-3.3-70b-versatile"),
            ) as never,
            transformConfigWithPendingPluginInstalls: transformConfig as never,
            createTempDir: makeTempDir,
          },
        }),
      ).rejects.toThrow("simulated config commit failure");

      const store = readAuthProfileStoreForTest(agentDir);
      expect(store.profiles["groq:default"]).toMatchObject({ key: "existing-key" });
      expect(Object.keys(store.profiles).filter((id) => id.startsWith("groq:setup-"))).toEqual([]);
    } finally {
      await removeOAuthTestTempRoot(stateDir);
    }
  });

  it("retains a credential when a post-write concurrent edit still references it", async () => {
    const stateDir = await makeTempDir();
    const agentDir = path.join(stateDir, "agent");
    const initialConfig = {
      agents: { list: [{ id: "main", default: true, agentDir }] },
    } satisfies OpenClawConfig;
    resolveAgentDir(initialConfig, "main");
    let currentConfig: OpenClawConfig = initialConfig;
    const readConfigFileSnapshot = vi.fn(async () => ({
      exists: true,
      valid: true,
      config: currentConfig,
      sourceConfig: currentConfig,
      runtimeConfig: currentConfig,
    }));
    const transformConfig = vi.fn(async (params: { transform: Function }) => {
      const transformed = await params.transform(initialConfig, {
        snapshot: {
          config: initialConfig,
          sourceConfig: initialConfig,
          runtimeConfig: initialConfig,
        },
        previousHash: null,
        attempt: 0,
      });
      currentConfig = {
        ...transformed.nextConfig,
        agents: {
          ...transformed.nextConfig.agents,
          defaults: {
            ...transformed.nextConfig.agents?.defaults,
            params: { temperature: 0.25 },
          },
        },
      };
      throw new Error("simulated post-write failure after concurrent edit");
    });

    try {
      await expect(
        activateSetupInference({
          kind: "api-key",
          authChoice: "groq-api-key",
          apiKey: "candidate-key",
          surface: "gateway",
          runtime,
          deps: {
            readConfigFileSnapshot: readConfigFileSnapshot as never,
            resolvePluginProviders: () => [createGroqSetupProvider()],
            resolveManifestProviderAuthChoice: groqSetupChoice,
            runEmbeddedAgent: vi.fn(async () =>
              successfulRun("groq", "llama-3.3-70b-versatile"),
            ) as never,
            transformConfigWithPendingPluginInstalls: transformConfig as never,
            createTempDir: makeTempDir,
          },
        }),
      ).rejects.toThrow("credential was retained because the current config may reference it");

      const profileId = Object.keys(readAuthProfileStoreForTest(agentDir).profiles).find((id) =>
        id.startsWith("groq:setup-"),
      );
      expect(profileId).toBeDefined();
      expect(currentConfig.auth?.profiles?.[profileId!]).toMatchObject({ provider: "groq" });
      expect(currentConfig.agents?.defaults?.model).toContain(`@${profileId}`);
    } finally {
      await removeOAuthTestTempRoot(stateDir);
    }
  });

  it("fails closed when rollback cannot read back the auth store", async () => {
    const stateDir = await makeTempDir();
    const agentDir = path.join(stateDir, "agent");
    const initialConfig = {
      agents: { list: [{ id: "main", default: true, agentDir }] },
    } satisfies OpenClawConfig;
    resolveAgentDir(initialConfig, "main");
    const transformConfig = vi.fn(async (params: { transform: Function }) => {
      await params.transform(initialConfig, {
        snapshot: { config: initialConfig, runtimeConfig: initialConfig },
        previousHash: null,
        attempt: 0,
      });
      throw new Error("simulated config commit failure");
    });

    try {
      await expect(
        activateSetupInference({
          kind: "api-key",
          authChoice: "groq-api-key",
          apiKey: "replacement-key",
          surface: "gateway",
          runtime,
          deps: {
            readConfigFileSnapshot: vi.fn(async () => ({
              exists: true,
              valid: true,
              config: initialConfig,
              runtimeConfig: initialConfig,
            })) as never,
            resolvePluginProviders: () => [createGroqSetupProvider()],
            resolveManifestProviderAuthChoice: groqSetupChoice,
            runEmbeddedAgent: vi.fn(async () =>
              successfulRun("groq", "llama-3.3-70b-versatile"),
            ) as never,
            transformConfigWithPendingPluginInstalls: transformConfig as never,
            loadPersistedAuthProfileStore: vi.fn(() => {
              throw new Error("simulated auth read failure");
            }),
            createTempDir: makeTempDir,
          },
        }),
      ).rejects.toThrow("staged credential could not be rolled back");

      expect(
        Object.keys(readAuthProfileStoreForTest(agentDir).profiles).filter((id) =>
          id.startsWith("groq:setup-"),
        ),
      ).toEqual([]);
    } finally {
      await removeOAuthTestTempRoot(stateDir);
    }
  });

  it("rejects scalar-to-object provider config patches after a concurrent scalar edit", async () => {
    const stateDir = await makeTempDir();
    const agentDir = path.join(stateDir, "agent");
    const auxProvider = {
      baseUrl: "https://aux.example.test/v1",
      apiKey: "base-key",
      models: [],
    };
    const initialConfig = {
      agents: { list: [{ id: "main", default: true, agentDir }] },
      models: { providers: { aux: auxProvider } },
    } satisfies OpenClawConfig;
    const concurrentConfig: OpenClawConfig = {
      ...initialConfig,
      models: {
        providers: {
          aux: { ...auxProvider, apiKey: "operator-key" },
        },
      },
    };
    resolveAgentDir(initialConfig, "main");
    const configHarness = createConfigTransformHarness(concurrentConfig);
    const provider = createGroqSetupProvider({
      models: {
        providers: {
          aux: {
            baseUrl: "https://aux.example.test/v1",
            apiKey: { source: "env", provider: "default", id: "AUX_API_KEY" },
            models: [],
          },
        },
      },
    });

    try {
      await expect(
        activateSetupInference({
          kind: "api-key",
          authChoice: "groq-api-key",
          apiKey: "candidate-key",
          surface: "gateway",
          runtime,
          deps: {
            readConfigFileSnapshot: vi.fn(async () => ({
              exists: true,
              valid: true,
              config: initialConfig,
              runtimeConfig: initialConfig,
            })) as never,
            resolvePluginProviders: () => [provider],
            resolveManifestProviderAuthChoice: groqSetupChoice,
            runEmbeddedAgent: vi.fn(async () =>
              successfulRun("groq", "llama-3.3-70b-versatile"),
            ) as never,
            transformConfigWithPendingPluginInstalls: configHarness.transform as never,
            createTempDir: makeTempDir,
          },
        }),
      ).rejects.toThrow("Provider configuration changed during the live inference test");

      expect(configHarness.current()).toEqual(concurrentConfig);
      expect(
        Object.keys(readAuthProfileStoreForTest(agentDir).profiles).filter((id) =>
          id.startsWith("groq:setup-"),
        ),
      ).toEqual([]);
    } finally {
      await removeOAuthTestTempRoot(stateDir);
    }
  });

  it("resolves the config transformer before persisting a verified credential", async () => {
    const stateDir = await makeTempDir();
    const agentDir = path.join(stateDir, "agent");
    const initialConfig = {
      agents: { list: [{ id: "main", default: true, agentDir }] },
    } satisfies OpenClawConfig;
    resolveAgentDir(initialConfig, "main");
    const authWriteDirs: string[] = [];
    const deps = {
      readConfigFileSnapshot: vi.fn(async () => ({
        exists: true,
        valid: true,
        config: initialConfig,
        runtimeConfig: initialConfig,
      })) as never,
      resolvePluginProviders: () => [createGroqSetupProvider()],
      resolveManifestProviderAuthChoice: groqSetupChoice,
      runEmbeddedAgent: vi.fn(async () =>
        successfulRun("groq", "llama-3.3-70b-versatile"),
      ) as never,
      updateAuthProfileStoreWithLock: vi.fn(async (params) => {
        authWriteDirs.push(params.agentDir ?? "");
        return await updateAuthProfileStoreWithLock(params);
      }),
      createTempDir: makeTempDir,
    };
    Object.defineProperty(deps, "transformConfigWithPendingPluginInstalls", {
      get: () => {
        throw new Error("simulated transformer resolution failure");
      },
    });

    try {
      await expect(
        activateSetupInference({
          kind: "api-key",
          authChoice: "groq-api-key",
          apiKey: "candidate-key",
          surface: "gateway",
          runtime,
          deps: deps as never,
        }),
      ).rejects.toThrow("simulated transformer resolution failure");

      expect(authWriteDirs).not.toContain(agentDir);
      expect(readAuthProfileStoreForTest(agentDir).profiles).toEqual({});
    } finally {
      await removeOAuthTestTempRoot(stateDir);
    }
  });

  it.each([
    {
      name: "uses a provider starter model instead of an unrelated existing default",
      existingModel: "openai/gpt-5.2",
      starterModel: "github-copilot/claude-sonnet-4.5",
    },
    {
      name: "accepts an unchanged provider-owned dynamic model",
      existingModel: "github-copilot/claude-sonnet-4.5",
      starterModel: undefined,
    },
  ])("$name without starting interactive login", async ({ existingModel, starterModel }) => {
    const stateDir = await makeTempDir();
    const agentDir = path.join(stateDir, "agent");
    const runInteractive = vi.fn();
    const runNonInteractive = vi.fn(
      async (ctx: {
        agentDir?: string;
        opts: { githubCopilotToken?: unknown };
        config: OpenClawConfig;
      }) => {
        const token =
          typeof ctx.opts.githubCopilotToken === "string" ? ctx.opts.githubCopilotToken : "";
        await upsertAuthProfileWithLock({
          profileId: "github-copilot:github",
          credential: { type: "token", provider: "github-copilot", token },
          agentDir: ctx.agentDir,
        });
        return {
          ...ctx.config,
          agents: {
            ...ctx.config.agents,
            defaults: {
              ...ctx.config.agents?.defaults,
              model: ctx.config.agents?.defaults?.model ?? {
                primary: "github-copilot/claude-sonnet-4.5",
              },
            },
          },
        } satisfies OpenClawConfig;
      },
    );
    const provider: ProviderPlugin = {
      id: "github-copilot",
      label: "GitHub Copilot",
      pluginId: "github-copilot",
      auth: [
        {
          id: "device",
          label: "GitHub device login",
          kind: "device_code",
          ...(starterModel ? { starterModel } : {}),
          run: runInteractive as never,
          runNonInteractive: runNonInteractive as never,
        },
      ],
    };
    const runEmbeddedAgent = vi.fn(async (_params: { authProfileId?: string }) =>
      successfulRun("github-copilot", "claude-sonnet-4.5"),
    );
    const initialConfig = {
      gateway: { port: 18789 },
      agents: {
        defaults: { model: { primary: existingModel } },
        list: [{ id: "main", default: true, agentDir }],
      },
    } satisfies OpenClawConfig;
    const concurrentConfig: OpenClawConfig = {
      gateway: { port: 19000 },
      agents: {
        defaults: { model: { primary: existingModel } },
        list: [{ id: "main", default: true, agentDir }],
      },
    } satisfies OpenClawConfig;
    const configHarness = createConfigTransformHarness(concurrentConfig);

    try {
      const result = await activateSetupInference({
        kind: "api-key",
        authChoice: "github-copilot",
        apiKey: "github-token",
        workspace: "/tmp/openclaw-workspace",
        surface: "gateway",
        runtime,
        deps: {
          readConfigFileSnapshot: vi.fn(async () => ({
            exists: true,
            valid: true,
            path: "/tmp/openclaw.json",
            issues: [],
            config: initialConfig,
            runtimeConfig: initialConfig,
          })) as never,
          resolvePluginProviders: () => [provider],
          resolveManifestProviderAuthChoice: () => ({
            pluginId: "github-copilot",
            providerId: "github-copilot",
            methodId: "device",
            choiceId: "github-copilot",
            choiceLabel: "GitHub Copilot",
            optionKey: "githubCopilotToken",
            cliOption: "--github-copilot-token <token>",
            appGuidedSecret: true,
          }),
          runEmbeddedAgent: runEmbeddedAgent as never,
          transformConfigWithPendingPluginInstalls: configHarness.transform as never,
          createTempDir: makeTempDir,
        },
      });

      expect(result).toMatchObject({
        ok: true,
        modelRef: "github-copilot/claude-sonnet-4.5",
      });
      expect(runInteractive).not.toHaveBeenCalled();
      expect(runNonInteractive).toHaveBeenCalledWith(
        expect.objectContaining({
          opts: expect.objectContaining({ githubCopilotToken: "github-token" }),
        }),
      );
      const activatedProfileId = runEmbeddedAgent.mock.calls[0]?.[0].authProfileId;
      if (!activatedProfileId) {
        throw new Error("expected setup auth profile");
      }
      expect(activatedProfileId).toMatch(/^github-copilot:setup-/);
      expect(runEmbeddedAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: "crestodian",
          agentDir: expect.stringContaining("setup-inference-test-"),
          authProfileId: activatedProfileId,
          provider: "github-copilot",
          model: "claude-sonnet-4.5",
        }),
      );
      expect(readAuthProfileStoreForTest(agentDir).profiles[activatedProfileId]).toMatchObject({
        type: "token",
        provider: "github-copilot",
        token: "github-token",
      });
      const persistedConfig = configHarness.current();
      expect(persistedConfig.gateway?.port).toBe(19000);
      expect(persistedConfig.agents?.defaults?.model).toEqual({
        primary: `github-copilot/claude-sonnet-4.5@${activatedProfileId}`,
      });
    } finally {
      await removeOAuthTestTempRoot(stateDir);
    }
  });

  it("does not persist a provider key after a failed live test", async () => {
    const stateDir = await makeTempDir();
    const agentDir = path.join(stateDir, "agent");
    const provider: ProviderPlugin = {
      id: "groq",
      label: "Groq",
      pluginId: "groq",
      auth: [
        {
          id: "api-key",
          label: "Groq API key",
          kind: "api_key",
          wizard: { choiceId: "groq-api-key" },
          run: async (ctx) => ({
            profiles: [
              {
                profileId: "groq:default",
                credential: { type: "api_key", provider: "groq", key: ctx.opts?.token },
              },
            ],
            defaultModel: "groq/llama-3.3-70b-versatile",
          }),
        },
      ],
    };

    try {
      const result = await activateSetupInference({
        kind: "api-key",
        authChoice: "groq-api-key",
        apiKey: "bad-groq-key",
        workspace: "/tmp/openclaw-workspace",
        surface: "gateway",
        runtime,
        deps: {
          resolvePluginProviders: () => [provider],
          resolveManifestProviderAuthChoice: () => ({
            pluginId: "groq",
            providerId: "groq",
            methodId: "api-key",
            choiceId: "groq-api-key",
            choiceLabel: "Groq API key",
            appGuidedSecret: true,
          }),
          runEmbeddedAgent: vi.fn(async () => {
            throw new Error("401 rejected credential bad-groq-key");
          }) as never,
          createTempDir: makeTempDir,
        },
      });

      expect(result).toMatchObject({ ok: false, status: "auth" });
      if (!result.ok) {
        expect(result.error).toContain("401 rejected credential [redacted]");
        expect(result.error).not.toContain("bad-groq-key");
      }
      expect(readAuthProfileStoreForTest(agentDir).profiles["groq:default"]).toBeUndefined();
    } finally {
      await removeOAuthTestTempRoot(stateDir);
    }
  });

  it("installs the codex runtime independently of a custom OpenAI route", async () => {
    const events: string[] = [];
    const runtimeLog = vi.fn();
    const initialConfig = {
      gateway: { port: 18789 },
      agents: {
        defaults: { model: { primary: "openai/gpt-5.4" } },
        list: [
          {
            id: "ops",
            default: true,
            model: {
              primary: "anthropic/claude-opus-4-8",
              fallbacks: ["google/gemini-3.1-pro-preview"],
            },
            models: {
              "openai/gpt-5.5": { agentRuntime: { id: "openclaw" } },
            },
          },
        ],
      },
      models: {
        providers: {
          openai: {
            baseUrl: "https://proxy.example.test/v1",
            models: [],
          },
        },
      },
      plugins: {
        entries: {
          codex: {
            enabled: false,
            config: { appServer: { command: "codex", mode: "yolo" } },
          },
        },
      },
    } satisfies OpenClawConfig;
    const ensureCodex = vi.fn(async (params: { cfg: OpenClawConfig }) => {
      events.push("install-plugin");
      return {
        cfg: {
          ...params.cfg,
          plugins: {
            ...params.cfg.plugins,
            entries: {
              ...params.cfg.plugins?.entries,
              codex: {
                ...params.cfg.plugins?.entries?.codex,
                enabled: true,
              },
            },
            installs: {
              ...params.cfg.plugins?.installs,
              codex: {
                source: "npm" as const,
                spec: "@openclaw/codex",
                installPath: "/tmp/plugins/codex",
              },
            },
          },
        },
        required: true,
        installed: true,
        status: "installed" as const,
      };
    });
    const runEmbeddedAgent = vi.fn(async (_params: unknown) => {
      events.push("live-test");
      return successfulRun("openai", "gpt-5.5");
    });
    let persistedConfig: OpenClawConfig = {
      ...initialConfig,
      gateway: { port: 19000 },
    };
    const pendingCodexInstalls: unknown[] = [];
    const transformConfig = vi.fn(
      async (params: {
        transform: (
          config: OpenClawConfig,
          context: { snapshot: { config: OpenClawConfig; runtimeConfig: OpenClawConfig } },
        ) => Promise<{ nextConfig: OpenClawConfig }>;
      }) => {
        const transformed = (
          await params.transform(persistedConfig, {
            snapshot: { config: persistedConfig, runtimeConfig: persistedConfig },
          })
        ).nextConfig;
        const configuredRuntime =
          transformed.agents?.defaults?.models?.["openai/gpt-5.5"]?.agentRuntime?.id ??
          transformed.agents?.list?.find((agent) => agent.id === "ops")?.models?.["openai/gpt-5.5"]
            ?.agentRuntime?.id;
        events.push(configuredRuntime === "codex" ? "persist-plugin-config" : "unexpected-write");
        pendingCodexInstalls.push(transformed.plugins?.installs?.codex);
        persistedConfig = withoutPluginInstallRecords(transformed);
        return { nextConfig: persistedConfig };
      },
    );
    const refreshPluginRegistry = vi.fn(async () => {
      events.push("refresh-plugin-registry");
      throw new Error("simulated registry refresh failure");
    });
    const result = await activateSetupInference({
      kind: "codex-cli",
      workspace: "/tmp/openclaw-workspace",
      surface: "gateway",
      runtime: { log: runtimeLog, error: () => {}, exit: () => {} } as never,
      deps: {
        readConfigFileSnapshot: vi.fn(async () => ({
          exists: true,
          valid: true,
          path: "/tmp/openclaw.json",
          issues: [],
          config: initialConfig,
          runtimeConfig: initialConfig,
        })) as never,
        runEmbeddedAgent: runEmbeddedAgent as never,
        ensureCodexRuntimePlugin: ensureCodex as never,
        transformConfigWithPendingPluginInstalls: transformConfig as never,
        refreshPluginRegistryAfterConfigMutation: refreshPluginRegistry as never,
        createTempDir: makeTempDir,
      },
    });
    expect(result.ok).toBe(true);
    expect(runtimeLog).not.toHaveBeenCalled();
    expect(ensureCodex).toHaveBeenCalledOnce();
    expect(ensureCodex).toHaveBeenCalledWith(
      expect.objectContaining({
        cfg: expect.objectContaining({
          agents: {
            defaults: { model: { primary: "openai/gpt-5.4" } },
            list: [
              expect.objectContaining({
                id: "ops",
                model: {
                  primary: "openai/gpt-5.5",
                  fallbacks: ["google/gemini-3.1-pro-preview"],
                },
                models: { "openai/gpt-5.5": { agentRuntime: { id: "codex" } } },
              }),
            ],
          },
          models: {
            providers: {
              openai: { baseUrl: "https://proxy.example.test/v1", models: [] },
            },
          },
        }),
        model: "openai/gpt-5.5",
        agentId: "ops",
      }),
    );
    expect(events).toEqual([
      "install-plugin",
      "live-test",
      "persist-plugin-config",
      "refresh-plugin-registry",
    ]);
    expect(transformConfig).toHaveBeenCalledOnce();
    expect(transformConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        afterWrite: {
          mode: "none",
          reason: "Crestodian activates verified inference",
        },
      }),
    );
    expect(refreshPluginRegistry).toHaveBeenCalledWith({
      config: persistedConfig,
      reason: "source-changed",
      workspaceDir: "/tmp/openclaw-workspace",
      logger: expect.objectContaining({ warn: expect.any(Function) }),
    });
    // Harness selection: codex tests run embedded with the codex harness.
    expect(runEmbeddedAgent.mock.calls[0]?.[0]).toMatchObject({
      agentId: "crestodian",
      agentDir: expect.stringContaining("setup-inference-test-"),
      provider: "openai",
      config: {
        agents: {
          defaults: {
            model: { primary: "openai/gpt-5.4" },
          },
          list: [
            expect.objectContaining({
              id: "ops",
              model: {
                primary: "openai/gpt-5.5",
                fallbacks: ["google/gemini-3.1-pro-preview"],
              },
              models: { "openai/gpt-5.5": { agentRuntime: { id: "codex" } } },
            }),
          ],
        },
        plugins: {
          entries: { codex: { enabled: true } },
        },
      },
    });
    expect(runEmbeddedAgent.mock.calls[0]?.[0]).toMatchObject({
      agentHarnessRuntimeOverride: "codex",
    });
    expect(persistedConfig).toMatchObject({
      gateway: { port: 19000 },
      models: {
        providers: {
          openai: { baseUrl: "https://proxy.example.test/v1" },
        },
      },
      agents: {
        defaults: { model: { primary: "openai/gpt-5.4" } },
        list: [
          expect.objectContaining({
            id: "ops",
            model: {
              primary: "openai/gpt-5.5",
              fallbacks: ["google/gemini-3.1-pro-preview"],
            },
            models: { "openai/gpt-5.5": { agentRuntime: { id: "codex" } } },
          }),
        ],
      },
      plugins: {
        entries: {
          codex: {
            enabled: true,
            config: { appServer: { command: "codex", mode: "yolo" } },
          },
        },
      },
    });
    expect(persistedConfig.plugins?.installs).toBeUndefined();
    expect(pendingCodexInstalls[0]).toMatchObject({
      source: "npm",
      spec: "@openclaw/codex",
      installPath: "/tmp/plugins/codex",
    });
    expect(pendingCodexInstalls).toHaveLength(1);
  });

  it("commits only the refreshed codex record when authored install metadata is stale", async () => {
    const staleAuthoredRecords = {
      codex: {
        source: "npm" as const,
        spec: "@openclaw/codex@1.0.0",
        installPath: "/tmp/plugins/codex-v1",
      },
      unrelated: {
        source: "npm" as const,
        spec: "@openclaw/unrelated@1.0.0",
        installPath: "/tmp/plugins/unrelated-v1",
      },
    };
    const canonicalRecords = {
      codex: {
        source: "npm" as const,
        spec: "@openclaw/codex@2.0.0",
        installPath: "/tmp/plugins/codex-v2",
      },
      unrelated: {
        source: "npm" as const,
        spec: "@openclaw/unrelated@2.0.0",
        installPath: "/tmp/plugins/unrelated-v2",
      },
    };
    const refreshedCodexRecord = {
      source: "npm" as const,
      spec: "@openclaw/codex@3.0.0",
      installPath: "/tmp/plugins/codex-v3",
    };
    const sourceConfig = {
      plugins: { installs: staleAuthoredRecords },
    } satisfies OpenClawConfig;
    const runtimeConfig = {
      plugins: { installs: canonicalRecords },
    } satisfies OpenClawConfig;
    const ensureCodex = vi.fn(async (params: { cfg: OpenClawConfig }) => ({
      cfg: {
        ...params.cfg,
        plugins: {
          ...params.cfg.plugins,
          installs: { codex: refreshedCodexRecord },
        },
      },
      required: true,
      installed: true,
      status: "installed" as const,
    }));
    let persistedConfig: OpenClawConfig = sourceConfig;
    let installIndex: Record<string, PluginInstallRecord> = structuredClone(canonicalRecords);
    const pendingInstallRecords: unknown[] = [];
    const transformConfig = vi.fn(
      async (params: {
        transform: (
          config: OpenClawConfig,
          context: { snapshot: { config: OpenClawConfig; runtimeConfig: OpenClawConfig } },
        ) => Promise<{ nextConfig: OpenClawConfig }>;
      }) => {
        const transformed = (
          await params.transform(persistedConfig, {
            snapshot: { config: runtimeConfig, runtimeConfig },
          })
        ).nextConfig;
        const pending = transformed.plugins?.installs;
        pendingInstallRecords.push(pending);
        installIndex = { ...installIndex, ...pending };
        persistedConfig = withoutPluginInstallRecords(transformed);
        return { nextConfig: persistedConfig };
      },
    );

    const result = await activateSetupInference({
      kind: "codex-cli",
      workspace: "/tmp/openclaw-workspace",
      surface: "gateway",
      runtime,
      deps: {
        readConfigFileSnapshot: vi.fn(async () => ({
          exists: true,
          valid: true,
          path: "/tmp/openclaw.json",
          issues: [],
          config: sourceConfig,
          runtimeConfig,
        })) as never,
        ensureCodexRuntimePlugin: ensureCodex as never,
        runEmbeddedAgent: vi.fn(async () => successfulRun("openai", "gpt-5.5")) as never,
        transformConfigWithPendingPluginInstalls: transformConfig as never,
        refreshPluginRegistryAfterConfigMutation: vi.fn(async () => {}) as never,
        createTempDir: makeTempDir,
      },
    });

    expect(result.ok).toBe(true);
    expect(ensureCodex).toHaveBeenCalledWith(
      expect.objectContaining({
        cfg: expect.not.objectContaining({
          plugins: expect.objectContaining({ installs: expect.anything() }),
        }),
      }),
    );
    expect(pendingInstallRecords).toStrictEqual([{ codex: refreshedCodexRecord }]);
    expect(installIndex).toStrictEqual({
      codex: refreshedCodexRecord,
      unrelated: canonicalRecords.unrelated,
    });
    expect(persistedConfig.plugins?.installs).toBeUndefined();
  });

  it("does not run or persist when the codex runtime install fails", async () => {
    const runEmbeddedAgent = vi.fn();
    const transformConfig = vi.fn();
    const refreshPluginRegistry = vi.fn();
    const result = await activateSetupInference({
      kind: "codex-cli",
      surface: "gateway",
      runtime,
      deps: {
        ensureCodexRuntimePlugin: vi.fn(async () => ({
          cfg: {},
          required: true,
          installed: false,
          status: "failed" as const,
        })) as never,
        runEmbeddedAgent: runEmbeddedAgent as never,
        transformConfigWithPendingPluginInstalls: transformConfig as never,
        refreshPluginRegistryAfterConfigMutation: refreshPluginRegistry as never,
        createTempDir: makeTempDir,
      },
    });

    expect(result).toMatchObject({ ok: false, status: "unavailable" });
    expect(runEmbeddedAgent).not.toHaveBeenCalled();
    expect(transformConfig).not.toHaveBeenCalled();
    expect(refreshPluginRegistry).not.toHaveBeenCalled();
  });

  it("does not install codex when plugin policy blocks it", async () => {
    const ensureCodex = vi.fn();
    const runEmbeddedAgent = vi.fn();
    const transformConfig = vi.fn();
    const refreshPluginRegistry = vi.fn();
    const blockedConfig: OpenClawConfig = { plugins: { allow: ["other"] } };
    const result = await activateSetupInference({
      kind: "codex-cli",
      surface: "gateway",
      runtime,
      deps: {
        readConfigFileSnapshot: vi.fn(async () => ({
          exists: true,
          valid: true,
          path: "/tmp/openclaw.json",
          issues: [],
          config: blockedConfig,
          runtimeConfig: blockedConfig,
        })) as never,
        ensureCodexRuntimePlugin: ensureCodex as never,
        runEmbeddedAgent: runEmbeddedAgent as never,
        transformConfigWithPendingPluginInstalls: transformConfig as never,
        refreshPluginRegistryAfterConfigMutation: refreshPluginRegistry as never,
        createTempDir: makeTempDir,
      },
    });

    expect(result).toMatchObject({
      ok: false,
      status: "unavailable",
      error: expect.stringContaining("blocked by allowlist"),
    });
    expect(ensureCodex).not.toHaveBeenCalled();
    expect(runEmbeddedAgent).not.toHaveBeenCalled();
    expect(transformConfig).not.toHaveBeenCalled();
    expect(refreshPluginRegistry).not.toHaveBeenCalled();
  });

  it("marks an unowned Codex package generation retained when the live test fails", async () => {
    const installProjectDir = await makeTempDir();
    const packageDir = path.join(installProjectDir, "node_modules", "@openclaw", "codex");
    await fs.mkdir(packageDir, { recursive: true });
    const transformConfig = vi.fn();
    const refreshPluginRegistry = vi.fn();
    const runEmbeddedAgent = vi.fn(async () => {
      throw new Error("401 invalid_api_key");
    });
    try {
      const result = await activateSetupInference({
        kind: "codex-cli",
        surface: "gateway",
        runtime,
        deps: {
          ensureCodexRuntimePlugin: vi.fn(async (params: { cfg: OpenClawConfig }) => ({
            cfg: {
              ...params.cfg,
              plugins: {
                ...params.cfg.plugins,
                installs: {
                  ...params.cfg.plugins?.installs,
                  codex: {
                    source: "npm" as const,
                    spec: "@openclaw/codex",
                    installPath: packageDir,
                  },
                },
              },
            },
            required: true,
            installed: true,
            status: "installed" as const,
          })) as never,
          runEmbeddedAgent: runEmbeddedAgent as never,
          transformConfigWithPendingPluginInstalls: transformConfig as never,
          readPersistedInstalledPluginIndexInstallRecords: vi.fn(async () => ({})),
          refreshPluginRegistryAfterConfigMutation: refreshPluginRegistry as never,
          createTempDir: makeTempDir,
        },
      });

      expect(result).toMatchObject({ ok: false, status: "auth" });
      expect(runEmbeddedAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          config: expect.objectContaining({
            plugins: expect.objectContaining({
              installs: {
                codex: expect.objectContaining({ installPath: packageDir }),
              },
            }),
          }),
        }),
      );
      await expect(fs.stat(packageDir)).resolves.toBeDefined();
      expect(hasRetainedManagedNpmInstallMarker(packageDir)).toBe(true);
      expect(transformConfig).not.toHaveBeenCalled();
      expect(refreshPluginRegistry).not.toHaveBeenCalled();
    } finally {
      await fs.rm(installProjectDir, { recursive: true, force: true });
    }
  });

  it("clears transient Codex install caches before a same-process retry", async () => {
    const installRecords = [
      {
        source: "npm" as const,
        spec: "@openclaw/codex@generation-1",
        installPath: "/tmp/plugins/codex-generation-1",
      },
      {
        source: "npm" as const,
        spec: "@openclaw/codex@generation-2",
        installPath: "/tmp/plugins/codex-generation-2",
      },
    ];
    const createdRecords: PluginInstallRecord[] = [];
    let installedRecordCache: PluginInstallRecord | undefined;
    let metadataCache: PluginInstallRecord | undefined;
    let discoveryCache: PluginInstallRecord | undefined;
    const ensureCodex = vi.fn(async ({ cfg }: { cfg: OpenClawConfig }) => {
      const cachedRecord = installedRecordCache ?? metadataCache ?? discoveryCache;
      if (cachedRecord) {
        return {
          cfg,
          required: true,
          installed: true,
          status: "installed" as const,
        };
      }
      const record = installRecords[createdRecords.length];
      if (!record) {
        throw new Error("unexpected Codex install generation");
      }
      createdRecords.push(record);
      installedRecordCache = record;
      metadataCache = record;
      discoveryCache = record;
      return {
        cfg: {
          ...cfg,
          plugins: {
            ...cfg.plugins,
            installs: { ...cfg.plugins?.installs, codex: record },
          },
        },
        required: true,
        installed: true,
        status: "installed" as const,
      };
    });
    const runEmbeddedAgent = vi
      .fn()
      .mockRejectedValueOnce(new Error("401 invalid_api_key"))
      .mockResolvedValueOnce(successfulRun("openai", "gpt-5.5"));
    const clearInstallRecords = vi.fn(() => {
      installedRecordCache = undefined;
    });
    const clearMetadata = vi.fn(() => {
      metadataCache = undefined;
    });
    const clearDiscovery = vi.fn(async () => {
      discoveryCache = undefined;
    });
    const markRetained = vi.fn(async () => true);
    const committedInstallRecords: PluginInstallRecord[] = [];
    const transformConfig = vi.fn(
      async (params: {
        transform: (
          config: OpenClawConfig,
          context: { snapshot: { config: OpenClawConfig; runtimeConfig: OpenClawConfig } },
        ) => Promise<{ nextConfig: OpenClawConfig }>;
      }) => {
        const transformed = await params.transform(
          {},
          { snapshot: { config: {}, runtimeConfig: {} } },
        );
        const record = transformed.nextConfig.plugins?.installs?.codex;
        if (record) {
          committedInstallRecords.push(record);
        }
        return { nextConfig: withoutPluginInstallRecords(transformed.nextConfig) };
      },
    );
    const deps = {
      ensureCodexRuntimePlugin: ensureCodex as never,
      runEmbeddedAgent: runEmbeddedAgent as never,
      transformConfigWithPendingPluginInstalls: transformConfig as never,
      refreshPluginRegistryAfterConfigMutation: vi.fn(async () => {}) as never,
      readPersistedInstalledPluginIndexInstallRecords: vi.fn(async () => ({})),
      markRetainedManagedNpmInstall: markRetained,
      clearLoadInstalledPluginIndexInstallRecordsCache: clearInstallRecords,
      clearPluginMetadataLifecycleCaches: clearMetadata,
      invalidatePluginRuntimeDiscoveryAfterConfigMutation: clearDiscovery as never,
      createTempDir: makeTempDir,
    };

    const first = await activateSetupInference({
      kind: "codex-cli",
      surface: "gateway",
      runtime,
      deps,
    });
    const second = await activateSetupInference({
      kind: "codex-cli",
      surface: "gateway",
      runtime,
      deps,
    });

    expect(first).toMatchObject({ ok: false, status: "auth" });
    expect(second).toMatchObject({ ok: true, modelRef: "openai/gpt-5.5" });
    expect(createdRecords).toStrictEqual(installRecords);
    expect(markRetained).toHaveBeenCalledWith({
      packageDir: installRecords[0].installPath,
      pluginId: "codex",
      reason: "crestodian-inference-activation-not-committed",
    });
    expect(clearInstallRecords).toHaveBeenCalledOnce();
    expect(clearMetadata).toHaveBeenCalledOnce();
    expect(clearDiscovery).toHaveBeenCalledOnce();
    expect(transformConfig).toHaveBeenCalledOnce();
    expect(committedInstallRecords).toStrictEqual([installRecords[1]]);
  });

  it.each([
    { name: "missing", installRecords: {} as Record<string, PluginInstallRecord>, succeeds: false },
    {
      name: "mismatched",
      installRecords: {
        codex: {
          source: "npm" as const,
          spec: "@openclaw/codex@other",
          installPath: "/tmp/plugins/codex-other",
        },
      },
      succeeds: false,
    },
    {
      name: "exact",
      installRecords: undefined as Record<string, PluginInstallRecord> | undefined,
      succeeds: true,
    },
  ])("reconciles a post-write Codex error only with an $name install record", async (testCase) => {
    const installRecord: PluginInstallRecord = {
      source: "npm",
      spec: "@openclaw/codex",
      installPath: "/tmp/plugins/codex",
    };
    const installRecords = testCase.installRecords ?? { codex: installRecord };
    let committedConfig: OpenClawConfig | undefined;
    const readConfigFileSnapshot = vi.fn(async () => {
      const sourceConfig = committedConfig ?? {};
      const runtimeConfig =
        committedConfig && installRecords.codex
          ? {
              ...sourceConfig,
              plugins: { ...sourceConfig.plugins, installs: { codex: installRecords.codex } },
            }
          : sourceConfig;
      return {
        exists: true,
        valid: true,
        config: sourceConfig,
        sourceConfig,
        runtimeConfig,
      };
    });
    const transformConfig = vi.fn(
      async (params: {
        transform: (
          config: OpenClawConfig,
          context: { snapshot: { config: OpenClawConfig; runtimeConfig: OpenClawConfig } },
        ) => Promise<{ nextConfig: OpenClawConfig }>;
      }) => {
        const transformed = await params.transform(
          {},
          { snapshot: { config: {}, runtimeConfig: {} } },
        );
        committedConfig = withoutPluginInstallRecords(transformed.nextConfig);
        throw new Error("simulated post-write failure");
      },
    );
    const readInstallRecords = vi.fn(async () => installRecords);
    const markRetainedInstall = vi.fn(async () => true);

    const activation = activateSetupInference({
      kind: "codex-cli",
      surface: "gateway",
      runtime,
      deps: {
        readConfigFileSnapshot: readConfigFileSnapshot as never,
        ensureCodexRuntimePlugin: vi.fn(async ({ cfg }: { cfg: OpenClawConfig }) => ({
          cfg: {
            ...cfg,
            plugins: {
              ...cfg.plugins,
              installs: { ...cfg.plugins?.installs, codex: installRecord },
            },
          },
          required: true,
          installed: true,
          status: "installed" as const,
        })) as never,
        runEmbeddedAgent: vi.fn(async () => successfulRun("openai", "gpt-5.5")) as never,
        transformConfigWithPendingPluginInstalls: transformConfig as never,
        readPersistedInstalledPluginIndexInstallRecords: readInstallRecords,
        markRetainedManagedNpmInstall: markRetainedInstall,
        refreshPluginRegistryAfterConfigMutation: vi.fn(async () => {}) as never,
        createTempDir: makeTempDir,
      },
    });

    if (testCase.succeeds) {
      await expect(activation).resolves.toMatchObject({ ok: true, modelRef: "openai/gpt-5.5" });
    } else {
      await expect(activation).rejects.toThrow("simulated post-write failure");
    }
    expect(readInstallRecords).toHaveBeenCalledOnce();
    expect(markRetainedInstall).toHaveBeenCalledTimes(testCase.succeeds ? 0 : 1);
  });
});

describe("verifySetupInference", () => {
  function configuredSnapshot() {
    return {
      exists: true,
      valid: true,
      config: {
        agents: { defaults: { model: { primary: "openai/gpt-5.5" } } },
      },
    };
  }

  it.each([
    ["missing config", { exists: false, valid: true, config: {} }],
    ["invalid config", { exists: true, valid: false, config: {} }],
    ["missing default-agent model", { exists: true, valid: true, config: {} }],
  ])("rejects %s before starting a model", async (_label, snapshot) => {
    const runEmbeddedAgent = vi.fn();
    const createTempDir = vi.fn(makeTempDir);

    const result = await verifySetupInference({
      runtime,
      deps: {
        readConfigFileSnapshot: vi.fn(async () => snapshot) as never,
        runEmbeddedAgent: runEmbeddedAgent as never,
        createTempDir,
      },
    });

    expect(result).toMatchObject({ ok: false, status: "unavailable" });
    expect(runEmbeddedAgent).not.toHaveBeenCalled();
    expect(createTempDir).not.toHaveBeenCalled();
  });

  it("returns a passing live check without persisting setup", async () => {
    const result = await verifySetupInference({
      runtime,
      deps: {
        readConfigFileSnapshot: vi.fn(async () => configuredSnapshot()) as never,
        runEmbeddedAgent: vi.fn(async () => successfulRun("openai", "gpt-5.5")) as never,
        createTempDir: makeTempDir,
      },
    });

    expect(result).toMatchObject({ ok: true, modelRef: "openai/gpt-5.5" });
  });

  it("rejects a configured route that changes during its live check", async () => {
    const initialConfig = {
      agents: { defaults: { model: { primary: "openai/gpt-5.5" } } },
    } satisfies OpenClawConfig;
    const changedConfig = {
      agents: { defaults: { model: { primary: "anthropic/claude-opus-4-8" } } },
    } satisfies OpenClawConfig;
    const readConfigFileSnapshot = vi
      .fn()
      .mockResolvedValueOnce({ exists: true, valid: true, config: initialConfig })
      .mockResolvedValueOnce({ exists: true, valid: true, config: changedConfig });

    const result = await verifySetupInference({
      runtime,
      deps: {
        readConfigFileSnapshot: readConfigFileSnapshot as never,
        runEmbeddedAgent: vi.fn(async () => successfulRun("openai", "gpt-5.5")) as never,
        createTempDir: makeTempDir,
      },
    });

    expect(result).toMatchObject({
      ok: false,
      status: "unknown",
      error: expect.stringContaining("route changed during its live test"),
    });
    expect(readConfigFileSnapshot).toHaveBeenCalledTimes(2);
  });

  it("probes the configured default agent's exact embedded runtime", async () => {
    const runEmbeddedAgent = vi.fn(async () => successfulRun("openai", "gpt-5.5"));

    const result = await verifySetupInferenceConfig({
      config: {
        agents: {
          list: [
            {
              id: "ops",
              default: true,
              model: { primary: "openai/gpt-5.5" },
              models: {
                "openai/gpt-5.5": { agentRuntime: { id: "codex" } },
              },
            },
          ],
        },
      },
      runtime,
      deps: {
        runEmbeddedAgent: runEmbeddedAgent as never,
        createTempDir: makeTempDir,
      },
    });

    expect(result).toMatchObject({ ok: true, modelRef: "openai/gpt-5.5" });
    expect(runEmbeddedAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "crestodian",
        provider: "openai",
        model: "gpt-5.5",
        agentHarnessRuntimeOverride: "codex",
        authProfileStateMode: "read-only",
      }),
    );
  });

  it("probes the configured default agent CLI auth owner", async () => {
    const agentDir = "/configured/ops-agent";
    const runCliAgent = vi.fn(async () => successfulRun("claude-cli", "claude-opus-4-8"));

    const result = await verifySetupInferenceConfig({
      config: {
        agents: {
          defaults: {
            cliBackends: { "claude-cli": { command: "claude" } },
          },
          list: [
            {
              id: "ops",
              default: true,
              agentDir,
              model: { primary: "claude-cli/claude-opus-4-8@claude-cli:ops" },
            },
          ],
        },
      },
      runtime,
      deps: {
        runCliAgent: runCliAgent as never,
        loadAuthProfileStoreForRuntime: vi.fn(() => ({
          version: 1,
          profiles: {
            "claude-cli:ops": {
              type: "oauth",
              provider: "claude-cli",
              access: "test-access",
              refresh: "test-refresh",
              expires: Date.now() + 3_600_000,
            },
          },
        })) as never,
        createTempDir: makeTempDir,
      },
    });

    expect(result).toMatchObject({
      ok: true,
      modelRef: "claude-cli/claude-opus-4-8",
    });
    expect(runCliAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "claude-cli",
        model: "claude-opus-4-8",
        agentDir,
        authProfileId: "claude-cli:ops",
        executionMode: "side-question",
        disableTools: true,
      }),
    );
  });

  it.each([
    { name: "missing", profiles: {} },
    {
      name: "wrong-owner",
      profiles: {
        "openai:locked": {
          type: "api_key" as const,
          provider: "anthropic",
          key: "test-key",
        },
      },
    },
  ])("rejects a $name embedded profile before inference", async ({ profiles }) => {
    const runEmbeddedAgent = vi.fn();
    const result = await verifySetupInferenceConfig({
      config: {
        agents: { defaults: { model: "openai/gpt-5.5@openai:locked" } },
      },
      runtime,
      deps: {
        loadAuthProfileStoreForRuntime: vi.fn(() => ({ version: 1, profiles })) as never,
        runEmbeddedAgent: runEmbeddedAgent as never,
        createTempDir: makeTempDir,
      },
    });

    expect(result).toMatchObject({ ok: false, status: "auth" });
    expect(runEmbeddedAgent).not.toHaveBeenCalled();
  });

  it.each([
    { name: "missing", profiles: {} },
    {
      name: "wrong-owner",
      profiles: {
        "claude-cli:locked": {
          type: "api_key" as const,
          provider: "openai",
          key: "test-key",
        },
      },
    },
  ])("rejects a $name CLI profile before inference", async ({ profiles }) => {
    const runCliAgent = vi.fn();
    const result = await verifySetupInferenceConfig({
      config: {
        agents: {
          defaults: {
            model: "claude-cli/claude-opus-4-8@claude-cli:locked",
            cliBackends: { "claude-cli": { command: "claude" } },
          },
        },
      },
      runtime,
      deps: {
        loadAuthProfileStoreForRuntime: vi.fn(() => ({ version: 1, profiles })) as never,
        runCliAgent: runCliAgent as never,
        createTempDir: makeTempDir,
      },
    });

    expect(result).toMatchObject({ ok: false, status: "auth" });
    expect(runCliAgent).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "Gemini CLI OAuth",
      profileId: "google-gemini-cli:user@example.test",
      profileProvider: "google-gemini-cli",
      credential: {
        type: "oauth" as const,
        provider: "google-gemini-cli",
        access: "test-access",
        refresh: "test-refresh",
        expires: Date.now() + 3_600_000,
        email: "user@example.test",
      },
    },
    {
      name: "canonical Google API key fallback",
      profileId: "google:default",
      profileProvider: "google",
      credential: {
        type: "api_key" as const,
        provider: "google",
        key: "test-google-key",
      },
    },
  ])("resolves $name but rejects Gemini CLI as a setup verifier", async (testCase) => {
    const stateDir = await makeTempDir();
    const agentDir = path.join(stateDir, "agent");
    const runCliAgent = vi.fn(async () =>
      successfulRun("google-gemini-cli", "gemini-3.1-pro-preview"),
    );
    const modelRef = "google/gemini-3.1-pro-preview";
    const config: OpenClawConfig = {
      auth: {
        order: { [testCase.profileProvider]: [testCase.profileId] },
      },
      agents: {
        defaults: { cliBackends: { "google-gemini-cli": { command: "gemini" } } },
        list: [
          {
            id: "ops",
            default: true,
            agentDir,
            model: { primary: modelRef },
            models: {
              [modelRef]: { agentRuntime: { id: "google-gemini-cli" } },
            },
          },
        ],
      },
    };
    resolveAgentDir(config, "ops");
    await upsertAuthProfileWithLock({
      profileId: testCase.profileId,
      credential: testCase.credential,
      agentDir,
    });

    try {
      const route = await resolveCrestodianConfiguredRouteFromConfig(config);
      expect(route).toMatchObject({
        runner: "cli",
        provider: "google-gemini-cli",
        authProfileId: testCase.profileId,
      });

      const result = await verifySetupInferenceConfig({
        config,
        runtime,
        deps: {
          runCliAgent: runCliAgent as never,
          createTempDir: makeTempDir,
        },
      });

      expect(result).toMatchObject({
        ok: false,
        status: "unavailable",
        error: expect.stringContaining("no hard tool-free mode"),
      });
      expect(runCliAgent).not.toHaveBeenCalled();
    } finally {
      await removeOAuthTestTempRoot(stateDir);
    }
  });

  it("redacts live-check failures without writing config or auth", async () => {
    const secret = "sk-verifysetupsecret123"; // pragma: allowlist secret
    const result = await verifySetupInference({
      runtime,
      timeoutMs: 50,
      deps: {
        readConfigFileSnapshot: vi.fn(async () => configuredSnapshot()) as never,
        runEmbeddedAgent: vi.fn(async () => {
          throw new Error(`401 invalid_api_key OPENAI_API_KEY=${secret}`);
        }) as never,
        createTempDir: makeTempDir,
      },
    });

    expect(result).toMatchObject({ ok: false, status: "auth" });
    if (!result.ok) {
      expect(result.error).not.toContain(secret);
      expect(result.error).toContain("OPENAI_API_KEY=");
    }
  });
});
