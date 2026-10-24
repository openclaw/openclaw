// Non-interactive plugin provider auth tests cover provider choice setup and runtime plugin install requirements.
import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import type { ModelProviderConfig } from "../../../config/types.models.js";
import * as pluginEnable from "../../../plugins/enable.js";
import type { ProviderAuthMethod } from "../../../plugins/types.js";
import "../../../system-agent/setup-inference-credentials.js";
import { migrateLegacyConfig } from "../../doctor/shared/legacy-config-migrate.js";
import { applyNonInteractivePluginProviderChoice } from "./auth-choice.plugin-providers.js";

type ModelSelectionRuntimePluginsResult =
  | { ok: true; cfg: OpenClawConfig; codexInstalled: boolean }
  | { ok: false; message: string };
const ensureModelSelectionRuntimePlugins = vi.hoisted(() =>
  vi.fn(async ({ cfg }: { cfg: OpenClawConfig }): Promise<ModelSelectionRuntimePluginsResult> => ({
    ok: true,
    cfg,
    codexInstalled: false,
  })),
);
vi.mock("../../runtime-plugin-install.js", () => ({
  CODEX_RUNTIME_PLUGIN_ID: "codex",
  ensureModelSelectionRuntimePlugins,
}));
const offerPostInstallMigrations = vi.hoisted(() => vi.fn(async () => {}));
// mock-isolation: Provider selection must not run post-install state migrations.
vi.mock("../../../wizard/setup.post-install-migration.js", () => ({ offerPostInstallMigrations }));
const resolvePreferredProviderForAuthChoice = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("../../../plugins/provider-auth-choice-preference.js", () => ({
  resolvePreferredProviderForAuthChoice,
}));
const resolveManifestProviderAuthChoice = vi.hoisted(() => vi.fn(() => undefined));
// mock-isolation: Synthetic manifests keep provider discovery independent of installed plugins.
vi.mock("../../../plugins/provider-auth-choices.js", () => ({ resolveManifestProviderAuthChoice }));
const resolveProviderInstallCatalogEntries = vi.hoisted(() =>
  vi.fn<
    typeof import("../../../plugins/provider-install-catalog.js").resolveProviderInstallCatalogEntries
  >(() => []),
);
vi.mock("../../../plugins/provider-install-catalog.js", () => ({
  resolveProviderInstallCatalogEntries,
}));
const ensureOnboardingPluginInstalled = vi.hoisted(() => vi.fn());
// mock-isolation: Record installation requests without installing packages.
vi.mock("../../onboarding-plugin-install.js", () => ({ ensureOnboardingPluginInstalled }));

const resolveOwningPluginIdsForProvider = vi.hoisted(() => vi.fn(() => undefined));
const resolveProviderPluginChoice = vi.hoisted(() => vi.fn());
const resolvePluginProvidersCore = vi.hoisted(() => vi.fn(() => []));
vi.mock("./auth-choice.plugin-providers.runtime.js", () => ({
  authChoicePluginProvidersRuntime: {
    resolveOwningPluginIdsForProviderRef: resolveOwningPluginIdsForProvider,
    resolveProviderPluginChoice,
    resolvePluginProviders: resolvePluginProvidersCore,
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  runtime = createRuntime();
  resolvePreferredProviderForAuthChoice.mockResolvedValue(undefined);
  resolveManifestProviderAuthChoice.mockReturnValue(undefined);
  resolveProviderInstallCatalogEntries.mockReturnValue([]);
  ensureOnboardingPluginInstalled.mockResolvedValue(undefined);
  resolveOwningPluginIdsForProvider.mockReturnValue(undefined as never);
  resolveProviderPluginChoice.mockReturnValue(undefined);
  resolvePluginProvidersCore.mockReturnValue([] as never);
  ensureModelSelectionRuntimePlugins.mockImplementation(async ({ cfg }) => ({
    ok: true,
    cfg,
    codexInstalled: false,
  }));
});

let runtime: ReturnType<typeof createRuntime>;
function createRuntime() {
  return { error: vi.fn(), exit: vi.fn(), log: vi.fn() };
}

const target = { agentId: "main", agentDir: "/tmp/main-agent", workspaceDir: "/tmp/workspace" };

function utilityFixtureProvider(id = "small"): ModelProviderConfig {
  return {
    baseUrl: "http://127.0.0.1:9/v1",
    models: [
      {
        id,
        name: "Local fixture",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 8192,
        maxTokens: 1024,
      },
    ],
  };
}

type ChoiceParams = Parameters<typeof applyNonInteractivePluginProviderChoice>[0];

function applyChoice(params: Pick<ChoiceParams, "authChoice"> & Partial<ChoiceParams>) {
  const nextConfig = params.nextConfig ?? { agents: { defaults: {} } };
  return applyNonInteractivePluginProviderChoice({
    nextConfig,
    baseConfig: nextConfig,
    opts: {},
    runtime,
    target,
    resolveApiKey: vi.fn(),
    toApiKeyCredential: vi.fn(),
    ...params,
  });
}

type MockCalls = { mock: { calls: Array<Array<unknown>> } };

function mockCall(mock: MockCalls, callIndex = 0): Array<unknown> {
  return expectDefined(mock.mock.calls[callIndex], `expected mock call ${callIndex}`);
}

function mockArg(mock: MockCalls, callIndex = 0, argIndex = 0): Record<string, unknown> {
  const arg = mockCall(mock, callIndex)[argIndex];
  if (!arg || typeof arg !== "object") {
    throw new Error(`expected mock arg at call ${callIndex}, arg ${argIndex}`);
  }
  return arg as Record<string, unknown>;
}

function expectWorkspaceDir(value: unknown) {
  expect(typeof value).toBe("string");
  expect((value as string).length).toBeGreaterThan(0);
}

function expectRuntimeErrorIncludes(text: string) {
  const errorOutput = runtime.error.mock.calls.map(([message]) => String(message)).join("\n");
  expect(errorOutput).toContain(text);
}

function expectJsonError(message: unknown, json = true) {
  if (!json) {
    expect(runtime.log).not.toHaveBeenCalled();
    return;
  }
  expect(runtime.log).toHaveBeenCalledOnce();
  expect(JSON.parse(String(runtime.log.mock.calls[0]?.[0]))).toEqual({
    ok: false,
    error: { type: "cli_error", message },
    phase: "options",
    message,
  });
}

function mockProvider(
  id: string,
  runNonInteractive: ProviderAuthMethod["runNonInteractive"],
  wizard?: { modelTarget: "utility" },
) {
  const provider = { id, pluginId: id, label: id };
  resolvePluginProvidersCore.mockReturnValue([provider] as never);
  resolveProviderPluginChoice.mockReturnValue({
    provider,
    method: { runNonInteractive },
    wizard,
  });
}

async function applyProviderModelChoice(params: {
  providerId: string;
  modelRef: string;
  nextConfig?: OpenClawConfig;
  target?: typeof target;
}) {
  const nextConfig = params.nextConfig ?? { agents: { defaults: {} } };
  const runNonInteractive = vi.fn(async ({ config }: { config: OpenClawConfig }) => ({
    ...config,
    agents: {
      ...config.agents,
      defaults: { ...config.agents?.defaults, model: { primary: params.modelRef } },
    },
  }));
  mockProvider(params.providerId, runNonInteractive);

  return applyChoice({
    nextConfig,
    authChoice: `provider-plugin:${params.providerId}:custom`,
    target: params.target ?? target,
  });
}

describe("applyNonInteractivePluginProviderChoice", () => {
  it.each([false, true])(
    "keeps utility onboarding separate from the previous implicit primary (legacy: %s)",
    async (legacy) => {
      const localProvider = utilityFixtureProvider();
      let baseConfig: OpenClawConfig = legacy
        ? { models: { providers: { "local-fixture": localProvider } } }
        : {};
      const runNonInteractive = vi.fn(async ({ config }: { config: OpenClawConfig }) => ({
        ...config,
        models: { providers: { "utility-fixture": localProvider, ...config.models?.providers } },
        agents: {
          ...config.agents,
          defaults: {
            ...config.agents?.defaults,
            model: { primary: "utility-fixture/small" },
            utilityModel: {
              primary: "utility-fixture/small",
              fallbacks: ["utility-fixture/backup"],
            },
          },
        },
      }));
      mockProvider("utility-fixture", runNonInteractive, { modelTarget: "utility" });
      const apply = () =>
        applyChoice({
          nextConfig: baseConfig,
          authChoice: "provider-plugin:utility-fixture:custom",
        });
      if (legacy) {
        const original = structuredClone(baseConfig);
        expect(await apply()).toBeNull();
        expectRuntimeErrorIncludes("openclaw doctor --fix");
        expect(runNonInteractive).not.toHaveBeenCalled();
        expect(ensureModelSelectionRuntimePlugins).not.toHaveBeenCalled();
        expect(baseConfig).toEqual(original);
        baseConfig = expectDefined(
          migrateLegacyConfig(baseConfig, { sourceConfigBeforeMigrations: baseConfig }).config,
          "migrated config",
        );
      }
      const before = structuredClone(baseConfig);
      const result = await apply();
      expect(result?.agents?.defaults?.utilityModel).toEqual({
        primary: "utility-fixture/small",
        fallbacks: ["utility-fixture/backup"],
      });
      expect(result?.agents?.defaults?.model).toEqual(
        legacy ? { primary: "local-fixture/small" } : undefined,
      );
      expect(result?.meta?.migrations?.utilityModelSeparation).toBe(true);
      expect(baseConfig).toEqual(before);
      expect(runNonInteractive).toHaveBeenCalledOnce();
    },
  );

  it.each(["${LOCAL_MODEL}", "small@experimental"])(
    "rejects utility preparation before an unsafe legacy catalog %s can be reordered",
    async (id) => {
      const baseConfig: OpenClawConfig = {
        models: { providers: { "local-fixture": utilityFixtureProvider(id) } },
      };
      const original = structuredClone(baseConfig);
      const runNonInteractive = vi.fn(async ({ config }: { config: OpenClawConfig }) => ({
        ...config,
        models: {
          providers: { "utility-fixture": utilityFixtureProvider(), ...config.models?.providers },
        },
      }));
      mockProvider("utility-fixture", runNonInteractive, { modelTarget: "utility" });
      expect(
        await applyChoice({
          nextConfig: baseConfig,
          authChoice: "provider-plugin:utility-fixture:custom",
        }),
      ).toBeNull();
      expectRuntimeErrorIncludes("explicit primary model");
      expect(runNonInteractive).not.toHaveBeenCalled();
      expect(ensureOnboardingPluginInstalled).not.toHaveBeenCalled();
      expect(ensureModelSelectionRuntimePlugins).not.toHaveBeenCalled();
      expect(baseConfig).toEqual(original);
    },
  );

  it("requires capability consent before loading a disabled provider in noninteractive setup", async () => {
    const config: OpenClawConfig = { plugins: { entries: { example: { enabled: false } } } };
    resolveManifestProviderAuthChoice.mockReturnValue({ pluginId: "example" } as never);
    const enable = vi
      .spyOn(pluginEnable, "enablePluginWithCapabilityConsent")
      .mockResolvedValueOnce({
        config,
        enabled: false,
        pluginId: "example",
        reason: "Plugin requires capability consent.",
      });
    try {
      const result = await applyChoice({
        nextConfig: config,
        authChoice: "example-api-key",
        opts: {},
      });
      expect(result).toBeNull();
      expectRuntimeErrorIncludes("capability consent");
      expect(resolvePluginProvidersCore).not.toHaveBeenCalled();
      expect(resolveProviderPluginChoice).not.toHaveBeenCalled();
    } finally {
      enable.mockRestore();
    }
  });

  it("keeps provider model selection on the configured explicit-fleet agent", async () => {
    const providerId = "nvidia";
    const modelRef = `${providerId}/selected`;
    const result = await applyProviderModelChoice({
      providerId,
      modelRef,
      target: { agentId: "ops", agentDir: "/tmp/ops-agent", workspaceDir: "/tmp/ops-workspace" },
      nextConfig: {
        agents: {
          ownership: "explicit",
          defaults: {
            systemAgent: { agentId: "ops" },
            model: { primary: "anthropic/global" },
            models: { "anthropic/global": { alias: "Global" } },
          },
          entries: {
            main: { model: { primary: "anthropic/main" } },
            ops: {
              model: { primary: "openai/ops" },
              models: { "openai/ops": { alias: "Operations" } },
            },
          },
        },
      },
    });
    expect(result?.agents?.defaults?.model).toEqual({ primary: "anthropic/global" });
    expect(result?.agents?.defaults?.models).toEqual({ "anthropic/global": { alias: "Global" } });
    expect(result?.agents?.entries?.ops?.model).toEqual({ primary: modelRef });
    expect(result?.agents?.entries?.ops?.models).toEqual({ "openai/ops": { alias: "Operations" } });
    expect(result?.agents?.entries?.main?.model).toEqual({ primary: "anthropic/main" });
    expect(ensureModelSelectionRuntimePlugins).toHaveBeenCalledWith(
      expect.objectContaining({ model: modelRef }),
    );
  });

  it.each([
    ["ollama", "ollama/qwen3:8b", undefined],
    ["ollama", "ollama/qwen3:8b", false],
    ["openai", "openai/gpt-5.6-luna", true],
  ] as const)(
    "preserves lean-tool choice for %s (%s, %s)",
    async (providerId, modelRef, localModelLean) => {
      const result = await applyProviderModelChoice({
        providerId,
        modelRef,
        nextConfig: {
          agents: {
            defaults: localModelLean === undefined ? {} : { experimental: { localModelLean } },
          },
        },
      });
      expect(result?.agents?.defaults?.model).toEqual({ primary: modelRef });
      expect(result?.agents?.defaults?.experimental?.localModelLean).toBe(localModelLean);
      expect(result?.wizard).toBeUndefined();
    },
  );

  it.each([false, true])(
    "keeps media setup global without replacing the text model (explicit fleet: %s)",
    async (explicitFleet) => {
      const provider = { id: "pixverse", pluginId: "pixverse", label: "PixVerse" };
      const initialConfig: OpenClawConfig = {
        agents: {
          defaults: { model: { primary: "openai/gpt-5.6" } },
          ...(explicitFleet
            ? { ownership: "explicit", entries: { main: { model: { primary: "openai/agent" } } } }
            : {}),
        },
      };
      const runNonInteractive = vi.fn(async ({ config }: { config: OpenClawConfig }) => ({
        ...config,
        agents: {
          ...config.agents,
          defaults: {
            ...config.agents?.defaults,
            mediaModels: { video: { primary: "pixverse/pixverse-v5.6" } },
          },
        },
      }));
      resolvePreferredProviderForAuthChoice.mockResolvedValue("pixverse" as never);
      resolvePluginProvidersCore.mockImplementation((...args: unknown[]) => {
        const input = args[0] as { providerRefs?: string[] } | undefined;
        return (input?.providerRefs?.includes("pixverse") ? [provider] : []) as never;
      });
      resolveProviderPluginChoice.mockImplementation((...args: unknown[]) => {
        const input = args[0] as { providers?: unknown[] } | undefined;
        return input?.providers?.includes(provider)
          ? { provider, method: { runNonInteractive } }
          : undefined;
      });

      const result = await applyChoice({
        nextConfig: initialConfig,
        authChoice: "pixverse-api-key",
        opts: { pixverseApiKey: "pixverse-test-key" } as never,
        runtime,
      });

      expect(runNonInteractive).toHaveBeenCalledOnce();
      expect(result?.agents?.defaults?.model).toEqual({ primary: "openai/gpt-5.6" });
      expect(result?.agents?.defaults?.mediaModels?.video).toEqual({
        primary: "pixverse/pixverse-v5.6",
      });
      if (explicitFleet) {
        expect(result?.agents?.entries?.main?.model).toEqual({ primary: "openai/agent" });
      }
    },
  );

  it("installs an official catalog provider for a cold auth choice with whitespace", async () => {
    const runNonInteractive = vi.fn(async ({ config }: { config: OpenClawConfig }) => ({
      ...config,
      agents: { defaults: { model: { primary: "groq/openai/gpt-oss-120b" } } },
    }));
    const provider = { id: "groq", pluginId: "groq", label: "Groq" };
    resolveProviderInstallCatalogEntries.mockReturnValue([
      {
        pluginId: "groq",
        providerId: "groq",
        methodId: "api-key",
        choiceId: "groq-api-key",
        choiceLabel: "Groq API key",
        label: "Groq",
        origin: "bundled",
        install: { npmSpec: "@openclaw/groq-provider", defaultChoice: "npm" },
      },
    ]);
    ensureOnboardingPluginInstalled.mockResolvedValue({
      cfg: { plugins: { entries: { groq: { enabled: true } } } },
      installed: true,
      pluginId: "groq",
      status: "installed",
    });
    resolvePluginProvidersCore.mockReturnValue([provider] as never);
    resolveProviderPluginChoice.mockReturnValueOnce(undefined).mockReturnValue({
      provider,
      method: { runNonInteractive },
    });
    const result = await applyChoice({
      authChoice: "  groq-api-key  ",
      opts: { groqApiKey: "groq-key" } as never,
    });
    expect(resolveProviderInstallCatalogEntries).toHaveBeenCalledExactlyOnceWith({
      config: { agents: { defaults: {} } },
      workspaceDir: target.workspaceDir,
      includeUntrustedWorkspacePlugins: false,
    });
    expect(ensureOnboardingPluginInstalled).toHaveBeenCalledWith(
      expect.objectContaining({
        cfg: { agents: { defaults: {} } },
        entry: {
          pluginId: "groq",
          label: "Groq",
          install: { npmSpec: "@openclaw/groq-provider", defaultChoice: "npm" },
          trustedSourceLinkedOfficialInstall: true,
        },
        promptInstall: false,
      }),
    );
    expect(resolvePluginProvidersCore).toHaveBeenCalledTimes(2);
    expect(mockArg(resolvePluginProvidersCore, 1).providerRefs).toEqual(["groq"]);
    expect(runNonInteractive).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      agents: { defaults: { model: { primary: "groq/openai/gpt-oss-120b" } } },
      plugins: { entries: { groq: { enabled: true } } },
    });
  });

  it("guides deprecated official auth choices before a current catalog match can install", async () => {
    const choice = {
      pluginId: "qwen",
      providerId: "qwen",
      methodId: "api-key",
      choiceId: "qwen-api-key",
      choiceLabel: "Qwen API key",
      label: "Qwen",
      origin: "bundled" as const,
      install: { npmSpec: "@openclaw/qwen-provider" },
    };
    resolveProviderInstallCatalogEntries.mockReturnValue([
      { ...choice, choiceId: "modelstudio-api-key" },
      { ...choice, deprecatedChoiceIds: ["modelstudio-api-key"] },
    ]);
    const result = await applyChoice({ authChoice: "modelstudio-api-key" });
    expect(result).toBeNull();
    expectRuntimeErrorIncludes(
      '"modelstudio-api-key" is no longer supported. Use --auth-choice "qwen-api-key" instead.',
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(ensureOnboardingPluginInstalled).not.toHaveBeenCalled();
    expect(resolveProviderInstallCatalogEntries).toHaveBeenCalledOnce();
  });

  it.each([
    { authChoice: "", catalogReads: 0 },
    { authChoice: "   ", catalogReads: 0 },
    { authChoice: "unknown-choice", catalogReads: 1 },
  ])(
    "leaves unmatched auth choice %j without setup effects",
    async ({ authChoice, catalogReads }) => {
      const resolveApiKey = vi.fn();
      const result = await applyChoice({ authChoice, resolveApiKey });
      expect(result).toBeUndefined();
      expect(resolveProviderInstallCatalogEntries).toHaveBeenCalledTimes(catalogReads);
      expect(ensureOnboardingPluginInstalled).not.toHaveBeenCalled();
      expect(resolveApiKey).not.toHaveBeenCalled();
      expect(runtime.error).not.toHaveBeenCalled();
      expect(runtime.exit).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    "rejects an unmatched provider-plugin auth choice while honoring json=%s",
    async (json) => {
      const result = await applyChoice({
        authChoice: "provider-plugin:workspace-provider:api-key",
        opts: { json } as never,
      });
      expect(result).toBeNull();
      expect(resolvePreferredProviderForAuthChoice).not.toHaveBeenCalled();
      expect(resolveProviderInstallCatalogEntries).not.toHaveBeenCalled();
      expectRuntimeErrorIncludes(
        'Auth choice "provider-plugin:workspace-provider:api-key" was not matched to a trusted provider plugin.',
      );
      expect(runtime.exit).toHaveBeenCalledWith(1);
      expectJsonError(
        expect.stringContaining("was not matched to a trusted provider plugin"),
        json,
      );
    },
  );

  it.each([
    { authChoice: "provider-plugin:", json: true },
    { authChoice: "provider-plugin:   ", json: false },
    { authChoice: "provider-plugin::method", json: false },
  ])(
    "rejects a missing provider id before provider discovery (%j)",
    async ({ authChoice, json }) => {
      const nextConfig = { agents: { defaults: {} } } as OpenClawConfig;
      const result = await applyChoice({ nextConfig, authChoice, opts: { json } as never });
      expect(result).toBeNull();
      expect(runtime.exit).toHaveBeenCalledWith(1);
      expectRuntimeErrorIncludes("is missing a provider id");
      expectRuntimeErrorIncludes('"provider-plugin:<provider-id>"');
      expect(resolvePluginProvidersCore).not.toHaveBeenCalled();
      expect(resolvePreferredProviderForAuthChoice).not.toHaveBeenCalled();
      expect(resolveProviderInstallCatalogEntries).not.toHaveBeenCalled();
      expectJsonError(expect.stringContaining("is missing a provider id"), json);
    },
  );

  it("fails explicitly when a non-prefixed auth choice resolves only with untrusted providers", async () => {
    resolvePreferredProviderForAuthChoice.mockResolvedValue(undefined);
    resolveManifestProviderAuthChoice.mockReturnValueOnce(undefined).mockReturnValueOnce({
      pluginId: "workspace-provider",
      providerId: "workspace-provider",
    } as never);
    const result = await applyChoice({ authChoice: "workspace-provider-api-key" });
    expect(result).toBeNull();
    expectRuntimeErrorIncludes(
      'Auth choice "workspace-provider-api-key" matched a provider plugin that is not trusted or enabled for setup.',
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(mockArg(resolvePluginProvidersCore).includeUntrustedWorkspacePlugins).toBe(false);
    expect(resolveProviderPluginChoice).toHaveBeenCalledTimes(1);
    expect(resolvePluginProvidersCore).toHaveBeenCalledTimes(1);
    expect(mockCall(resolveManifestProviderAuthChoice, 0)[0]).toBe("workspace-provider-api-key");
    expect(resolveProviderInstallCatalogEntries).not.toHaveBeenCalled();
    const trustedManifestInput = mockArg(resolveManifestProviderAuthChoice, 0, 1);
    expect(trustedManifestInput.includeUntrustedWorkspacePlugins).toBe(false);
    expect(mockCall(resolveManifestProviderAuthChoice, 1)[0]).toBe("workspace-provider-api-key");
    const untrustedManifestInput = mockArg(resolveManifestProviderAuthChoice, 1, 1);
    expect(untrustedManifestInput.config).toEqual({ agents: { defaults: {} } });
    expectWorkspaceDir(untrustedManifestInput.workspaceDir);
    expect(untrustedManifestInput.includeUntrustedWorkspacePlugins).toBe(true);
  });

  it("limits setup-provider resolution to owning plugin ids without pre-enabling them", async () => {
    const runNonInteractive = vi.fn(async () => ({ plugins: { allow: ["demo-plugin"] } }));
    resolveOwningPluginIdsForProvider.mockReturnValue(["demo-plugin"] as never);
    resolvePluginProvidersCore.mockReturnValue([
      { id: "demo-provider", pluginId: "demo-plugin" },
    ] as never);
    resolveProviderPluginChoice.mockReturnValue({
      provider: { id: "demo-provider", pluginId: "demo-plugin", label: "Demo Provider" },
      method: { runNonInteractive },
    });

    const result = await applyChoice({
      authChoice: "provider-plugin:demo-provider:custom",
      runtime,
    });

    const providersInput = mockArg(resolvePluginProvidersCore);
    expect(providersInput.config).toEqual({ agents: { defaults: {} } });
    expect(providersInput.onlyPluginIds).toEqual(["demo-plugin"]);
    expect(providersInput.includeUntrustedWorkspacePlugins).toBe(false);
    expect(runNonInteractive).toHaveBeenCalledOnce();
    expect(runNonInteractive).toHaveBeenCalledWith(
      expect.objectContaining({ agentDir: target.agentDir, workspaceDir: target.workspaceDir }),
    );
    expect(result).toEqual({ plugins: { allow: ["demo-plugin"] } });
    expect(resolveOwningPluginIdsForProvider).toHaveBeenCalledOnce();
    expect(mockArg(resolveOwningPluginIdsForProvider).provider).toBe("demo-provider");
    expect(resolvePreferredProviderForAuthChoice).not.toHaveBeenCalled();
    expect(resolvePluginProvidersCore).toHaveBeenCalledOnce();
    expect(resolveProviderPluginChoice).toHaveBeenCalledOnce();
    expect(resolveProviderInstallCatalogEntries).not.toHaveBeenCalled();
  });

  it.each([
    ["openai", "openai-api-key", "codex"],
    ["openai", "openai-api-key", undefined],
    ["github-copilot", "github-copilot", "copilot"],
  ] as const)(
    "ensures the selected %s runtime (%s, %s)",
    async (providerId, authChoice, runtimeId) => {
      const model = `${providerId}/gpt-5.5`;
      const selectedConfig: OpenClawConfig = {
        agents: { defaults: { model: { primary: model } } },
        ...(runtimeId === "copilot"
          ? {
              models: {
                providers: {
                  [providerId]: {
                    baseUrl: "https://copilot.example",
                    models: [],
                    agentRuntime: { id: "copilot" },
                  },
                },
              },
            }
          : {}),
      };
      const installedConfig = runtimeId
        ? { ...selectedConfig, plugins: { entries: { [runtimeId]: { enabled: true } } } }
        : selectedConfig;
      const runNonInteractive = vi.fn(async () => selectedConfig);
      ensureModelSelectionRuntimePlugins.mockResolvedValue({
        ok: true,
        cfg: installedConfig,
        codexInstalled: runtimeId === "codex",
      });
      mockProvider(providerId, runNonInteractive);
      expect(await applyChoice({ authChoice })).toBe(installedConfig);
      expect(runNonInteractive).toHaveBeenCalledOnce();
      const ensureInput = mockArg(ensureModelSelectionRuntimePlugins);
      expect(ensureInput.cfg).toBe(selectedConfig);
      expect(ensureInput.runtime).toBe(runtime);
      expect(ensureInput.model).toBe(model);
      expectWorkspaceDir(ensureInput.workspaceDir);
      expect(mockArg(resolvePreferredProviderForAuthChoice)).toMatchObject({
        choice: authChoice,
        includeUntrustedWorkspacePlugins: false,
      });
      expect(mockArg(resolvePluginProvidersCore).includeUntrustedWorkspacePlugins).toBe(false);
      if (runtimeId === "codex") {
        expect(offerPostInstallMigrations).toHaveBeenCalledOnce();
        expect(mockArg(offerPostInstallMigrations).config).toBe(installedConfig);
        expect(mockArg(offerPostInstallMigrations)).toMatchObject({
          config: installedConfig,
          installedPluginIds: ["codex"],
          nonInteractive: true,
        });
      } else {
        expect(offerPostInstallMigrations).not.toHaveBeenCalled();
      }
    },
  );

  it("rejects an unavailable required runtime before later setup effects", async () => {
    const selectedConfig = {
      agents: { defaults: { model: { primary: "openai/gpt-5.5" } } },
    } as OpenClawConfig;
    const runNonInteractive = vi.fn(async () => selectedConfig);
    const message =
      "Codex runtime is required but unavailable (status: failed). Retry setup after checking npm and the configured registry.";
    ensureModelSelectionRuntimePlugins.mockResolvedValue({ ok: false, message });
    mockProvider("openai", runNonInteractive);
    const result = await applyChoice({
      authChoice: "openai-api-key",
      opts: { json: true } as never,
    });
    expect(result).toBeNull();
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(runtime.error).toHaveBeenCalledWith(message);
    expectJsonError(message);
    expect(offerPostInstallMigrations).not.toHaveBeenCalled();
  });
});
