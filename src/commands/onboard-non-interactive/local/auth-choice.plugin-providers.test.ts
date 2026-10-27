import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import type { ModelProviderConfig } from "../../../config/types.models.js";
import * as pluginEnable from "../../../plugins/enable.js";
import type { ProviderAuthMethod } from "../../../plugins/types.js";
import "../../../system-agent/setup-inference-credentials.js";
import { migrateLegacyConfig } from "../../doctor/shared/legacy-config-migrate.js";
import { createTestModelDefinition } from "../../test-runtime-config-helpers.js";
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

beforeEach(() => vi.resetAllMocks());

const runtime = { error: vi.fn(), exit: vi.fn(), log: vi.fn() };

const target = { agentId: "main", agentDir: "/tmp/main-agent", workspaceDir: "/tmp/workspace" };

function utilityFixtureProvider(id = "small"): ModelProviderConfig {
  return {
    baseUrl: "http://127.0.0.1:9/v1",
    models: [createTestModelDefinition(id, { name: "Local fixture", maxTokens: 1024 })],
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

function mockArg(mock: MockCalls, callIndex = 0, argIndex = 0): Record<string, unknown> {
  return expectDefined(
    mock.mock.calls[callIndex]?.[argIndex],
    `Expected mock argument ${callIndex}:${argIndex}`,
  ) as Record<string, unknown>;
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
  pluginId = id,
) {
  const provider = { id, pluginId, label: id };
  resolvePluginProvidersCore.mockReturnValue([provider] as never);
  resolveProviderPluginChoice.mockReturnValue({
    provider,
    method: { runNonInteractive },
    wizard,
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
          defaults: {
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
      const runNonInteractive = vi.fn<NonNullable<ProviderAuthMethod["runNonInteractive"]>>();
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

  it("projects preferred-provider selection onto the explicit-fleet agent", async () => {
    const nextConfig: OpenClawConfig = {
      agents: {
        ownership: "explicit",
        defaults: {
          systemAgent: { agentId: "ops" },
          model: { primary: "anthropic/global" },
        },
        entries: {
          main: { model: { primary: "anthropic/main" } },
          ops: { model: { primary: "openai/ops" } },
        },
      },
    };
    resolvePreferredProviderForAuthChoice.mockResolvedValue("nvidia" as never);
    mockProvider("nvidia", async ({ config }) => ({
      ...config,
      agents: { ...config.agents, defaults: { model: { primary: "nvidia/selected" } } },
    }));
    const result = await applyChoice({
      nextConfig,
      authChoice: "nvidia-api-key",
      target: { agentId: "ops", agentDir: "/tmp/ops-agent", workspaceDir: "/tmp/ops-workspace" },
    });
    expect(result?.agents?.defaults?.model).toEqual({ primary: "anthropic/global" });
    expect(result?.agents?.entries).toEqual({
      main: { model: { primary: "anthropic/main" } },
      ops: { model: { primary: "nvidia/selected" } },
    });
    expect(mockArg(resolvePluginProvidersCore).providerRefs).toEqual(["nvidia"]);
    expect(mockArg(ensureModelSelectionRuntimePlugins).model).toBe("nvidia/selected");
  });

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
    expect(mockArg(resolveProviderInstallCatalogEntries).includeUntrustedWorkspacePlugins).toBe(
      false,
    );
    expect(ensureOnboardingPluginInstalled).toHaveBeenCalledWith(
      expect.objectContaining({
        entry: expect.objectContaining({ trustedSourceLinkedOfficialInstall: true }),
        promptInstall: false,
      }),
    );
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
  });

  it.each([
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

  it.each([
    ["provider-plugin:   ", true, true],
    ["provider-plugin::method", true, false],
    ["provider-plugin:workspace-provider:api-key", false, false],
    ["provider-plugin:workspace-provider:api-key", false, true],
  ] as const)(
    "rejects unavailable provider choice %s (missing=%s, json=%s)",
    async (authChoice, missing, json) => {
      expect(await applyChoice({ authChoice, opts: { json } })).toBeNull();
      const message = missing
        ? "is missing a provider id"
        : `Auth choice "${authChoice}" was not matched to a trusted provider plugin.`;
      expectRuntimeErrorIncludes(message);
      expect(runtime.exit).toHaveBeenCalledWith(1);
      expect(resolvePreferredProviderForAuthChoice).not.toHaveBeenCalled();
      expect(resolveProviderInstallCatalogEntries).not.toHaveBeenCalled();
      if (missing) {
        expectRuntimeErrorIncludes('"provider-plugin:<provider-id>"');
        expect(resolvePluginProvidersCore).not.toHaveBeenCalled();
      }
      expectJsonError(expect.stringContaining(message), json);
    },
  );

  it("fails explicitly when a non-prefixed auth choice resolves only with untrusted providers", async () => {
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
    expect(resolveProviderInstallCatalogEntries).not.toHaveBeenCalled();
    const trustedManifestInput = mockArg(resolveManifestProviderAuthChoice, 0, 1);
    expect(trustedManifestInput.includeUntrustedWorkspacePlugins).toBe(false);
    const untrustedManifestInput = mockArg(resolveManifestProviderAuthChoice, 1, 1);
    expect(untrustedManifestInput.workspaceDir).toBe(target.workspaceDir);
    expect(untrustedManifestInput.includeUntrustedWorkspacePlugins).toBe(true);
  });

  it("limits setup-provider resolution to owning plugin ids without pre-enabling them", async () => {
    const runNonInteractive = vi.fn(async () => ({ plugins: { allow: ["demo-plugin"] } }));
    resolveOwningPluginIdsForProvider.mockReturnValue(["demo-plugin"] as never);
    mockProvider("demo-provider", runNonInteractive, undefined, "demo-plugin");

    const result = await applyChoice({
      authChoice: "provider-plugin:demo-provider:custom",
    });

    const providersInput = mockArg(resolvePluginProvidersCore);
    expect(providersInput.onlyPluginIds).toEqual(["demo-plugin"]);
    expect(providersInput.includeUntrustedWorkspacePlugins).toBe(false);
    expect(runNonInteractive).toHaveBeenCalledOnce();
    expect(runNonInteractive).toHaveBeenCalledWith(
      expect.objectContaining({ agentDir: target.agentDir, workspaceDir: target.workspaceDir }),
    );
    expect(result).toEqual({ plugins: { allow: ["demo-plugin"] } });
    expect(resolvePreferredProviderForAuthChoice).not.toHaveBeenCalled();
    expect(resolveProviderInstallCatalogEntries).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "ensures the selected runtime and gates migration hints on Codex installation (%s)",
    async (codexInstalled) => {
      const model = "openai/gpt-5.5";
      const authChoice = "openai-api-key";
      const selectedConfig: OpenClawConfig = {
        agents: { defaults: { model: { primary: model } } },
      };
      const installedConfig = {
        ...selectedConfig,
        plugins: { entries: { codex: { enabled: true } } },
      };
      const runNonInteractive = vi.fn(async () => selectedConfig);
      ensureModelSelectionRuntimePlugins.mockResolvedValue({
        ok: true,
        cfg: installedConfig,
        codexInstalled,
      });
      mockProvider("openai", runNonInteractive);
      expect(await applyChoice({ authChoice })).toBe(installedConfig);
      expect(runNonInteractive).toHaveBeenCalledOnce();
      expect(mockArg(ensureModelSelectionRuntimePlugins).model).toBe(model);
      expect(mockArg(resolvePreferredProviderForAuthChoice)).toMatchObject({
        choice: authChoice,
        includeUntrustedWorkspacePlugins: false,
      });
      if (codexInstalled) {
        expect(offerPostInstallMigrations).toHaveBeenCalledOnce();
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
