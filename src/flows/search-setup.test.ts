import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, expect, it, vi } from "vitest";
import { createWizardPrompter } from "../../test/helpers/wizard-prompter.js";
import { configFor } from "../agents/model-auth.fixtures.test-support.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import * as pluginEnable from "../plugins/enable.js";
import type { PluginWebSearchProviderEntry } from "../plugins/types.js";
import { createNonExitingRuntime } from "../runtime.js";
import { withEnvAsync } from "../test-utils/env.js";
import { runSearchSetupFlow } from "./search-setup.js";

type SearchSetup = NonNullable<PluginWebSearchProviderEntry["runSetup"]>;
type SearchCredentialConfig = {
  entries?: Record<string, { config?: { webSearch?: { apiKey?: unknown } } }>;
};

const authMocks = vi.hoisted(() => ({
  hasAuthProfileForProvider: vi.fn((_params: { provider: string; type?: string }) => false),
}));
const webSearchProviderMocks = vi.hoisted(() => ({
  resolvePluginWebSearchProviders: vi.fn(),
}));

vi.mock("../agents/tools/model-config.helpers.js", () => ({
  hasAuthProfileForProvider: authMocks.hasAuthProfileForProvider,
}));

const mockGrokProvider = vi.hoisted(() => ({
  id: "grok",
  pluginId: "xai",
  label: "Grok",
  hint: "Search with xAI",
  docsUrl: "https://docs.openclaw.ai/tools/web",
  requiresCredential: true,
  credentialLabel: "xAI API key",
  placeholder: "xai-...",
  signupUrl: "https://x.ai/api",
  envVars: ["XAI_API_KEY"],
  authProviderId: "xai",
  onboardingScopes: ["text-inference"],
  credentialPath: "plugins.entries.xai.config.webSearch.apiKey",
  credentialNote: "Configure Grok web search prerequisites before entering the credential.",
  getConfiguredCredentialValue: (config?: Record<string, unknown>) =>
    (config?.plugins as SearchCredentialConfig | undefined)?.entries?.xai?.config?.webSearch
      ?.apiKey,
  setConfiguredCredentialValue: (configTarget: Record<string, unknown>, value: unknown) => {
    const plugins = (configTarget.plugins ??= {}) as Record<string, unknown>;
    const entries = (plugins.entries ??= {}) as Record<string, unknown>;
    const xaiEntry = (entries.xai ??= {}) as Record<string, unknown>;
    const xaiConfig = (xaiEntry.config ??= {}) as Record<string, unknown>;
    const webSearch = (xaiConfig.webSearch ??= {}) as Record<string, unknown>;
    webSearch.apiKey = value;
  },
  runSetup: async ({ config, prompter }: Parameters<SearchSetup>[0]) => {
    const enableXSearch = await prompter.select({
      message: "Enable x_search",
      options: [
        { value: "yes", label: "Yes" },
        { value: "no", label: "No" },
      ],
    });
    if (enableXSearch !== "yes") {
      return config;
    }
    const model = await prompter.select({
      message: "Grok model",
      options: [{ value: "grok-4.3", label: "grok-4.3" }],
    });
    const entries = { ...config.plugins?.entries };
    const entry = entries.xai;
    entries.xai = { ...entry, config: { ...entry?.config, xSearch: { enabled: true, model } } };
    return { ...config, plugins: { ...config.plugins, entries } };
  },
}));

const mockCodexProvider = vi.hoisted(() => ({
  id: "codex",
  pluginId: "codex",
  label: "Codex Hosted Search",
  hint: "Grounded answers through your Codex app-server account",
  requiresCredential: false,
  envVars: [],
  onboardingScopes: ["text-inference"],
}));

vi.mock("../plugins/web-search-providers.runtime.js", () => ({
  resolvePluginWebSearchProviders: webSearchProviderMocks.resolvePluginWebSearchProviders,
}));

const ensureOnboardingPluginInstalled = vi.hoisted(() =>
  vi.fn<typeof import("../commands/onboarding-plugin-install.js").ensureOnboardingPluginInstalled>(
    async ({ cfg, entry }) => ({
      cfg: {
        ...cfg,
        plugins: {
          ...cfg.plugins,
          installs: {
            ...cfg.plugins?.installs,
            [entry.pluginId]: {
              source: "npm",
              spec: entry.install.npmSpec,
              installPath: `/tmp/openclaw-plugins/${entry.pluginId}`,
            },
          },
        },
      },
      installed: true,
      pluginId: entry.pluginId,
      status: "installed",
    }),
  ),
);

vi.mock("../commands/onboarding-plugin-install.js", () => ({
  ensureOnboardingPluginInstalled,
}));

function latestPluginInstallRequest() {
  return expectDefined(
    ensureOnboardingPluginInstalled.mock.calls.at(-1),
    "plugin install request",
  )[0];
}

function grokPluginsWithCredential(enabled?: boolean): OpenClawConfig["plugins"] {
  return {
    allow: ["xai"],
    entries: {
      xai: {
        ...(enabled === undefined ? {} : { enabled }),
        config: { webSearch: { apiKey: "xai-test-key" } },
      },
    },
  };
}

function setup(
  config: OpenClawConfig,
  prompter = createWizardPrompter(),
  options?: Parameters<typeof runSearchSetupFlow>[3],
) {
  return runSearchSetupFlow(config, createNonExitingRuntime(), prompter, options);
}

function grokPrompter(selectValues = ["grok", "no"], key = "") {
  return createWizardPrompter({ text: vi.fn(async () => key) }, { selectValues });
}

function expectSearch(config: OpenClawConfig, provider: string, enabled = true) {
  expect(config.tools?.web?.search).toMatchObject({ provider, enabled });
}

beforeEach(() => {
  ensureOnboardingPluginInstalled.mockClear();
  authMocks.hasAuthProfileForProvider.mockReset();
  authMocks.hasAuthProfileForProvider.mockReturnValue(false);
  webSearchProviderMocks.resolvePluginWebSearchProviders.mockReset();
  webSearchProviderMocks.resolvePluginWebSearchProviders.mockReturnValue([mockGrokProvider]);
});

it("keeps search config unchanged when plugin capability consent is declined", async () => {
  const config: OpenClawConfig = { plugins: { entries: { xai: { enabled: false } } } };
  const reason = "Plugin requires capability consent.";
  const enable = vi.spyOn(pluginEnable, "enablePluginWithCapabilityConsent").mockResolvedValueOnce({
    config,
    enabled: false,
    pluginId: "xai",
    reason,
  });
  const text = vi.fn(async () => "unused-key");
  const note = vi.fn(async () => {});
  try {
    const result = await setup(
      config,
      createWizardPrompter({
        select: vi.fn(async () => "grok") as never,
        text,
        note,
      }),
    );
    expect(result).toEqual({
      outcome: "install-failed",
      config,
      providerId: "grok",
      reason: "failed",
    });
    expect(note).toHaveBeenCalledWith(reason, "Web search unavailable");
    expect(text).not.toHaveBeenCalled();
    expect(ensureOnboardingPluginInstalled).not.toHaveBeenCalled();
  } finally {
    enable.mockRestore();
  }
});

it("names no-provider and user-skip outcomes as kept-current", async () => {
  webSearchProviderMocks.resolvePluginWebSearchProviders.mockReturnValue([]);
  const original: OpenClawConfig = { gateway: { mode: "local" } };
  const noProviderConfig: OpenClawConfig = { ...original, plugins: { enabled: false } };
  expect(await setup(noProviderConfig)).toEqual({
    outcome: "kept-current",
    config: noProviderConfig,
    reason: "no-providers",
  });

  webSearchProviderMocks.resolvePluginWebSearchProviders.mockReturnValue([mockGrokProvider]);
  expect(await setup(original, grokPrompter(["__skip__"]))).toEqual({
    outcome: "kept-current",
    config: original,
    reason: "user-skipped",
  });
});

it("recommends Codex hosted search first when the configured model uses Codex", async () => {
  webSearchProviderMocks.resolvePluginWebSearchProviders.mockReturnValue([
    mockGrokProvider,
    mockCodexProvider,
  ]);
  const prompter = grokPrompter(["__skip__"]);
  await setup({ agents: { defaults: { model: { primary: "openai/gpt-5.5" } } } }, prompter);
  const prompt = vi.mocked(prompter.select).mock.calls[0]?.[0];
  expect(prompt?.options?.[0]).toEqual(
    expect.objectContaining({
      value: "codex",
      label: expect.stringContaining("Codex Hosted Search"),
    }),
  );
  expect(prompt?.initialValue).toBe("codex");
});

it.each([
  ["interactive", "inline"],
  ["interactive", "ref"],
  ["quickstart", "inline"],
  ["quickstart", "ref"],
  ["reference-mode", "inline"],
  ["reference-mode", "ref"],
] as const)(
  "retains provider-declared model credentials during %s setup (%s)",
  async (mode, kind) => {
    await withEnvAsync({ XAI_API_KEY: undefined }, async () => {
      webSearchProviderMocks.resolvePluginWebSearchProviders.mockReturnValue([
        {
          ...mockGrokProvider,
          runSetup: undefined,
          getConfiguredCredentialFallback: (config: OpenClawConfig) => ({
            path: "models.providers.xai.apiKey",
            value: config.models?.providers?.xai?.apiKey,
          }),
        },
      ]);
      const credential =
        kind === "inline"
          ? "synthetic-model-key"
          : { source: "env" as const, provider: "default", id: "XAI_MODEL_TEST_KEY" };
      const config: OpenClawConfig = {
        plugins: { allow: ["xai"] },
        ...configFor("xai", "https://api.x.ai/v1", { apiKey: credential }),
      };
      const original = structuredClone(config);
      const text = vi.fn(async () => "");
      const result = await setup(
        config,
        createWizardPrompter({ text }, { defaultSelect: "grok" }),
        {
          quickstartDefaults: mode === "quickstart",
          secretInputMode: mode === "reference-mode" ? "ref" : "plaintext",
        },
      );
      expectSearch(result.config, "grok");
      expect(result.config.models).toEqual(original.models);
      expect(result.config.plugins?.entries?.xai?.config).toBeUndefined();
      expect(config).toEqual(original);
      expect(text).toHaveBeenCalledTimes(mode === "interactive" ? 1 : 0);
    });
  },
);

it("uses existing xAI OAuth for Grok web search without prompting for an API key", async () => {
  authMocks.hasAuthProfileForProvider.mockImplementation(
    ({ provider, type }) => provider === "xai" && (!type || type === "oauth"),
  );
  const text = vi.fn(async () => {
    throw new Error("API key prompt should not run when xAI OAuth is available");
  });
  const prompter = createWizardPrompter({ text }, { selectValues: ["grok", "no"] });
  const { config: next } = await setup({ plugins: { allow: ["xai"] } }, prompter);
  expectSearch(next, "grok");
  expect(mockGrokProvider.getConfiguredCredentialValue(next)).toBeUndefined();
  expect(text).not.toHaveBeenCalled();
  expect(prompter.note).toHaveBeenCalledWith(
    expect.stringContaining("existing xAI OAuth sign-in"),
    "Web search",
  );
});

it("shows provider credential notes before SecretRef setup notes", async () => {
  const prompter = grokPrompter();
  await withEnvAsync({ XAI_API_KEY: undefined }, async () => {
    await setup({ plugins: { allow: ["xai"] } }, prompter, { secretInputMode: "ref" });
  });

  expect(prompter.note).toHaveBeenNthCalledWith(
    2,
    mockGrokProvider.credentialNote,
    mockGrokProvider.label,
  );
  expect(prompter.note).toHaveBeenNthCalledWith(
    3,
    [
      "Secret references enabled — OpenClaw will store a reference instead of the API key.",
      "Env var: XAI_API_KEY.",
      "Set XAI_API_KEY in the Gateway environment.",
      "Docs: https://docs.openclaw.ai/tools/web",
    ].join("\n"),
    "Web search",
  );
});

it("skips provider credential notes in quickstart fast path", async () => {
  const prompter = grokPrompter();
  await setup({ plugins: grokPluginsWithCredential(true) }, prompter, {
    quickstartDefaults: true,
  });

  expect(prompter.note).not.toHaveBeenCalledWith(
    mockGrokProvider.credentialNote,
    mockGrokProvider.label,
  );
});

it.each([true, false])(
  "preserves disabled web_search unless explicitly overridden (%s)",
  async (preserve) => {
    const { config: next } = await setup(
      {
        plugins: grokPluginsWithCredential(preserve ? true : undefined),
        tools: { web: { search: { provider: "grok", enabled: false } } },
      },
      grokPrompter(preserve ? ["grok", "yes", "grok-4.3"] : ["grok", "no"]),
      { preserveDisabledSearchState: preserve },
    );
    expectSearch(next, "grok", !preserve);
    if (preserve) {
      expect(next.plugins?.entries?.xai?.config).toMatchObject({
        xSearch: { enabled: true, model: "grok-4.3" },
      });
    }
  },
);

it("offers and installs DeepSeek search before its plugin is installed", async () => {
  await withEnvAsync({ DEEPSEEK_API_KEY: undefined }, async () => {
    webSearchProviderMocks.resolvePluginWebSearchProviders.mockReturnValue([]);
    const prompts = grokPrompter(["deepseek"], "synthetic-deepseek-search-key");
    const result = await setup({}, prompts);
    expect(prompts.select).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.arrayContaining([expect.objectContaining({ value: "deepseek" })]),
      }),
    );
    expect(result.outcome).toBe("completed");
    expectSearch(result.config, "deepseek");
    expect(result.config.plugins?.entries?.deepseek?.config).toEqual({
      webSearch: { apiKey: "synthetic-deepseek-search-key" },
    });
    expect(latestPluginInstallRequest().entry).toMatchObject({
      pluginId: "deepseek",
      install: { npmSpec: "@openclaw/deepseek-provider" },
    });
  });
});

it("forwards the persistent-effect guard to external provider installation", async () => {
  const beforePersistentEffect = vi.fn(async () => {});
  await setup({}, grokPrompter(["brave"], "brave-test-key"), {
    beforePersistentEffect,
  });

  expect(latestPluginInstallRequest().beforePersistentEffect).toBe(beforePersistentEffect);
});

it("returns an install-failed outcome without changing config", async () => {
  ensureOnboardingPluginInstalled.mockResolvedValueOnce({
    cfg: { plugins: { installs: {} } },
    installed: false,
    pluginId: "brave",
    status: "failed",
  });
  const original: OpenClawConfig = { gateway: { mode: "local" } };
  const result = await setup(original, grokPrompter(["brave"], "brave-test-key"));

  expect(result).toEqual({
    outcome: "install-failed",
    config: original,
    providerId: "brave",
    reason: "failed",
  });
});

it("installs an external catalog search provider when web search stays disabled", async () => {
  const { config: next } = await setup(
    { tools: { web: { search: { provider: "brave", enabled: false } } } },
    grokPrompter(["brave"], "brave-disabled-key"),
  );

  expect(ensureOnboardingPluginInstalled).toHaveBeenCalledTimes(1);
  const installRequest = latestPluginInstallRequest();
  expect(installRequest).toMatchObject({
    entry: {
      pluginId: "brave",
      label: "Brave",
      trustedSourceLinkedOfficialInstall: true,
      install: { npmSpec: "@openclaw/brave-plugin" },
    },
    autoConfirmSingleSource: true,
  });
  expectSearch(next, "brave", false);
  expect(next.plugins?.entries?.brave?.config).toMatchObject({
    webSearch: { apiKey: "brave-disabled-key" },
  });
  expect(next.plugins?.entries?.brave?.enabled).toBeUndefined();
  expect(next.plugins?.installs?.brave).toMatchObject({
    source: "npm",
    spec: "@openclaw/brave-plugin",
  });
});
