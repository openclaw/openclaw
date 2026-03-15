import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "../wizard/prompts.js";

const loadOpenClawPlugins = vi.hoisted(() =>
  vi.fn(() => ({ searchProviders: [] as unknown[], plugins: [] as unknown[], typedHooks: [] })),
);
const loadPluginManifestRegistry = vi.hoisted(() =>
  vi.fn(() => ({ plugins: [] as unknown[], diagnostics: [] as unknown[] })),
);
const ensureOnboardingPluginInstalled = vi.hoisted(() =>
  vi.fn(async ({ cfg }: { cfg: OpenClawConfig }) => ({ cfg, installed: false })),
);
const ensureGenericOnboardingPluginInstalled = vi.hoisted(() =>
  vi.fn(async ({ cfg }: { cfg: OpenClawConfig }) => ({ cfg, installed: false })),
);
const reloadOnboardingPluginRegistry = vi.hoisted(() => vi.fn());

vi.mock("../plugins/loader.js", () => ({
  loadOpenClawPlugins,
}));

vi.mock("../plugins/manifest-registry.js", () => ({
  loadPluginManifestRegistry,
}));

vi.mock("./onboarding/plugin-install.js", () => ({
  ensureGenericOnboardingPluginInstalled,
  ensureOnboardingPluginInstalled,
  reloadOnboardingPluginRegistry,
}));

import { SEARCH_PROVIDER_OPTIONS, setupSearch } from "./onboard-search.js";

const runtime: RuntimeEnv = {
  log: vi.fn(),
  error: vi.fn(),
  exit: ((code: number) => {
    throw new Error(`unexpected exit ${code}`);
  }) as RuntimeEnv["exit"],
};

function createPrompter(params: { selectValue?: string; textValue?: string }): {
  prompter: WizardPrompter;
  notes: Array<{ title?: string; message: string }>;
} {
  const notes: Array<{ title?: string; message: string }> = [];
  const prompter: WizardPrompter = {
    intro: vi.fn(async () => {}),
    outro: vi.fn(async () => {}),
    note: vi.fn(async (message: string, title?: string) => {
      notes.push({ title, message });
    }),
    select: vi.fn(
      async () => params.selectValue ?? "perplexity",
    ) as unknown as WizardPrompter["select"],
    multiselect: vi.fn(async () => []) as unknown as WizardPrompter["multiselect"],
    text: vi.fn(async () => params.textValue ?? ""),
    confirm: vi.fn(async () => true),
    progress: vi.fn(() => ({ update: vi.fn(), stop: vi.fn() })),
  };
  return { prompter, notes };
}

function createPerplexityConfig(apiKey: string, enabled?: boolean): OpenClawConfig {
  return {
    tools: {
      web: {
        search: {
          provider: "perplexity",
          ...(enabled === undefined ? {} : { enabled }),
          perplexity: { apiKey },
        },
      },
    },
  };
}

async function runBlankPerplexityKeyEntry(
  apiKey: string,
  enabled?: boolean,
): Promise<OpenClawConfig> {
  const cfg = createPerplexityConfig(apiKey, enabled);
  const { prompter } = createPrompter({
    selectValue: "perplexity",
    textValue: "",
  });
  return setupSearch(cfg, runtime, prompter);
}

async function runQuickstartPerplexitySetup(
  apiKey: string,
  enabled?: boolean,
): Promise<{ result: OpenClawConfig; prompter: WizardPrompter }> {
  const cfg = createPerplexityConfig(apiKey, enabled);
  const { prompter } = createPrompter({ selectValue: "perplexity" });
  const result = await setupSearch(cfg, runtime, prompter, {
    quickstartDefaults: true,
  });
  return { result, prompter };
}

describe("setupSearch", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  beforeEach(() => {
    vi.stubEnv("BRAVE_API_KEY", "");
    vi.stubEnv("GEMINI_API_KEY", "");
    vi.stubEnv("XAI_API_KEY", "");
    vi.stubEnv("MOONSHOT_API_KEY", "");
    vi.stubEnv("PERPLEXITY_API_KEY", "");
    loadOpenClawPlugins.mockReset();
    loadOpenClawPlugins.mockReturnValue({ searchProviders: [], plugins: [], typedHooks: [] });
    loadPluginManifestRegistry.mockReset();
    loadPluginManifestRegistry.mockReturnValue({ plugins: [], diagnostics: [] });
    ensureOnboardingPluginInstalled.mockReset();
    ensureOnboardingPluginInstalled.mockImplementation(
      async ({ cfg }: { cfg: OpenClawConfig }) => ({
        cfg,
        installed: false,
      }),
    );
    ensureGenericOnboardingPluginInstalled.mockReset();
    ensureGenericOnboardingPluginInstalled.mockImplementation(
      async ({ cfg }: { cfg: OpenClawConfig }) => ({
        cfg,
        installed: false,
      }),
    );
    reloadOnboardingPluginRegistry.mockReset();
  });

  it("shows registered plugin providers with source and configured hints", async () => {
    loadOpenClawPlugins.mockReturnValue({
      searchProviders: [
        {
          pluginId: "tavily-search",
          provider: {
            id: "tavily",
            name: "Tavily Search",
            description: "Plugin search",
            isAvailable: () => true,
            search: async () => ({ content: "ok" }),
          },
        },
      ],
      plugins: [
        {
          id: "tavily-search",
          name: "Tavily Search",
          description: "External Tavily plugin",
          origin: "workspace",
          source: "/tmp/tavily-search",
          configJsonSchema: undefined,
          configUiHints: undefined,
        },
      ],
      typedHooks: [],
    });

    const cfg: OpenClawConfig = {};
    const { prompter } = createPrompter({ selectValue: "__skip__" });
    await setupSearch(cfg, runtime, prompter);

    const providerSelectCall = (prompter.select as ReturnType<typeof vi.fn>).mock.calls.find(
      (call) => call[0]?.message === "Choose web search provider",
    );
    expect(providerSelectCall?.[0]).toEqual(
      expect.objectContaining({
        options: expect.arrayContaining([
          expect.objectContaining({
            value: "tavily",
            label: "Tavily Search",
            hint: expect.stringContaining("Plugin search · External plugin"),
          }),
        ]),
      }),
    );
    expect(loadOpenClawPlugins).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceDir: undefined,
      }),
    );
  });

  it("shows bundled plugin providers directly in the picker while keeping the external install path available", async () => {
    loadOpenClawPlugins.mockReturnValue({
      searchProviders: [],
      plugins: [],
      typedHooks: [],
    });
    loadPluginManifestRegistry.mockReturnValue({
      plugins: [
        {
          id: "tavily-search",
          name: "Tavily Search",
          description: "Search the web using Tavily.",
          provides: ["providers.search.tavily"],
          origin: "bundled",
          source: "/tmp/bundled/tavily-search",
          configSchema: {
            type: "object",
            required: ["apiKey"],
            properties: {
              apiKey: { type: "string", minLength: 1, pattern: "^tvly-\\S+$" },
            },
          },
          configUiHints: {
            apiKey: {
              label: "Tavily API key",
              placeholder: "tvly-...",
              sensitive: true,
            },
          },
        },
      ],
      diagnostics: [],
    });

    const cfg: OpenClawConfig = {};
    const { prompter } = createPrompter({ selectValue: "__skip__" });
    await setupSearch(cfg, runtime, prompter);

    const providerSelectCall = (prompter.select as ReturnType<typeof vi.fn>).mock.calls.find(
      (call) => call[0]?.message === "Choose web search provider",
    );
    expect(providerSelectCall?.[0]).toEqual(
      expect.objectContaining({
        options: expect.arrayContaining([
          expect.objectContaining({
            value: "tavily",
            label: "Tavily Search",
            hint: expect.stringContaining("Bundled plugin"),
          }),
        ]),
      }),
    );
    expect(providerSelectCall?.[0]?.options).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          value: "__install_plugin__",
          label: "Install external provider plugin",
        }),
      ]),
    );
  });

  it.each([
    ["brave", "Brave Search"],
    ["gemini", "Gemini (Google Search)"],
    ["grok", "Grok (xAI)"],
    ["kimi", "Kimi (Moonshot)"],
    ["perplexity", "Perplexity Search"],
  ] as const)(
    "does not duplicate built-in provider %s when a bundled search plugin registers the same provider id",
    async (providerId, providerLabel) => {
      loadOpenClawPlugins.mockReturnValue({
        searchProviders: [
          {
            pluginId: `search-${providerId}`,
            provider: {
              id: providerId,
              name: providerLabel,
              description: `Bundled ${providerLabel} provider`,
              pluginId: `search-${providerId}`,
              isAvailable: () => true,
              search: async () => ({ content: "ok" }),
            },
          },
        ],
        plugins: [
          {
            id: `search-${providerId}`,
            name: providerLabel,
            description: `Bundled ${providerLabel} provider`,
            origin: "bundled",
            source: `/tmp/bundled/search-${providerId}`,
            configJsonSchema: undefined,
            configUiHints: undefined,
          },
        ],
        typedHooks: [],
      });
      loadPluginManifestRegistry.mockReturnValue({
        plugins: [],
        diagnostics: [],
      });

      const cfg: OpenClawConfig = {};
      const { prompter } = createPrompter({ selectValue: "__skip__" });
      await setupSearch(cfg, runtime, prompter);

      const providerSelectCall = (prompter.select as ReturnType<typeof vi.fn>).mock.calls.find(
        (call) => call[0]?.message === "Choose web search provider",
      );
      const matchingOptions =
        providerSelectCall?.[0]?.options?.filter(
          (option: { value?: string }) => option.value === providerId,
        ) ?? [];
      expect(matchingOptions).toHaveLength(1);
      expect(matchingOptions[0]?.hint).toContain("Bundled plugin");
    },
  );

  it("uses the updated configure-or-install action label", async () => {
    vi.stubEnv("BRAVE_API_KEY", "BSA-test-key");
    loadOpenClawPlugins.mockReturnValue({
      searchProviders: [
        {
          pluginId: "tavily-search",
          provider: {
            id: "tavily",
            name: "Tavily Search",
            description: "Plugin search",
            isAvailable: () => true,
            search: async () => ({ content: "ok" }),
          },
        },
      ],
      plugins: [
        {
          id: "tavily-search",
          name: "Tavily Search",
          description: "External Tavily plugin",
          origin: "workspace",
          source: "/tmp/tavily-search",
          configJsonSchema: undefined,
          configUiHints: undefined,
        },
      ],
      typedHooks: [],
    });
    const cfg: OpenClawConfig = {
      tools: {
        web: {
          search: {
            provider: "brave",
            enabled: true,
          },
        },
      },
      plugins: {
        entries: {
          "tavily-search": {
            enabled: true,
            config: { apiKey: "tvly-installed-key" },
          },
        },
      },
    };
    const { prompter } = createPrompter({
      selectValue: "__skip__",
    });

    await setupSearch(cfg, runtime, prompter);

    expect(prompter.select).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Choose web search provider",
        options: expect.arrayContaining([
          expect.objectContaining({
            value: "__install_plugin__",
            label: "Install external provider plugin",
          }),
        ]),
      }),
    );
  });

  it("passes workspaceDir when resolving plugin providers for setup", async () => {
    const cfg: OpenClawConfig = {};
    const { prompter } = createPrompter({ selectValue: "__skip__" });

    await setupSearch(cfg, runtime, prompter, {
      workspaceDir: "/tmp/workspace-search",
    });

    expect(loadOpenClawPlugins).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceDir: "/tmp/workspace-search",
      }),
    );
  });

  it("returns config unchanged when user skips", async () => {
    const cfg: OpenClawConfig = {};
    const { prompter } = createPrompter({ selectValue: "__skip__" });
    const result = await setupSearch(cfg, runtime, prompter);
    expect(result).toBe(cfg);
  });

  it("preserves an existing plugin provider when user keeps current provider", async () => {
    const cfg: OpenClawConfig = {
      tools: {
        web: {
          search: {
            provider: "searxng",
            enabled: true,
          },
        },
      },
    };
    const { prompter } = createPrompter({ selectValue: "__keep_current__" });
    const result = await setupSearch(cfg, runtime, prompter);
    expect(result).toBe(cfg);
    expect(prompter.text).not.toHaveBeenCalled();
    expect(prompter.select).toHaveBeenCalledWith(
      expect.objectContaining({
        initialValue: "__keep_current__",
        options: expect.arrayContaining([
          expect.objectContaining({
            value: "__keep_current__",
            label: "Keep current provider (searxng)",
          }),
        ]),
      }),
    );
  });

  it("puts configured providers first and marks the active provider when multiple are configured", async () => {
    vi.stubEnv("BRAVE_API_KEY", "BSA-test-key");
    loadOpenClawPlugins.mockReturnValue({
      searchProviders: [
        {
          pluginId: "tavily-search",
          provider: {
            id: "tavily",
            name: "Tavily Search",
            description: "Plugin search",
            isAvailable: () => true,
            search: async () => ({ content: "ok" }),
          },
        },
      ],
      plugins: [
        {
          id: "tavily-search",
          name: "Tavily Search",
          description: "External Tavily plugin",
          origin: "workspace",
          source: "/tmp/tavily-search",
          configJsonSchema: undefined,
          configUiHints: undefined,
        },
      ],
      typedHooks: [],
    });
    const cfg: OpenClawConfig = {
      tools: {
        web: {
          search: {
            provider: "tavily",
          },
        },
      },
    };
    const { prompter } = createPrompter({ selectValue: "__skip__" });

    await setupSearch(cfg, runtime, prompter);

    const options = (prompter.select as ReturnType<typeof vi.fn>).mock.calls.find(
      (call) => call[0]?.message === "Choose web search provider",
    )?.[0]?.options;
    expect(options[0]).toMatchObject({
      value: "tavily",
      hint: "Plugin search · External plugin · Active now",
    });
    expect(options[1]).toMatchObject({
      value: "brave",
      hint: "Structured results · country/language/time filters · Built-in · Configured",
    });
  });

  it("keeps the install option visible in configure-provider flow even when Tavily is already loaded", async () => {
    vi.stubEnv("BRAVE_API_KEY", "BSA-test-key");
    loadOpenClawPlugins.mockReturnValue({
      searchProviders: [
        {
          pluginId: "tavily-search",
          provider: {
            id: "tavily",
            name: "Tavily Search",
            description: "Plugin search",
            isAvailable: () => true,
            search: async () => ({ content: "ok" }),
          },
        },
      ],
      plugins: [
        {
          id: "tavily-search",
          name: "Tavily Search",
          description: "External Tavily plugin",
          origin: "workspace",
          source: "/tmp/tavily-search",
          configJsonSchema: undefined,
          configUiHints: undefined,
        },
      ],
      typedHooks: [],
    });

    const cfg: OpenClawConfig = {
      tools: {
        web: {
          search: {
            provider: "brave",
            enabled: true,
          },
        },
      },
      plugins: {
        entries: {
          "tavily-search": {
            enabled: true,
            config: { apiKey: "tvly-installed-key" },
          },
        },
      },
    };
    const { prompter } = createPrompter({
      selectValue: "__skip__",
    });

    await setupSearch(cfg, runtime, prompter);

    const configurePickerCall = (prompter.select as ReturnType<typeof vi.fn>).mock.calls.find(
      (call) => call[0]?.message === "Choose web search provider",
    );
    expect(configurePickerCall?.[0]).toEqual(
      expect.objectContaining({
        options: expect.arrayContaining([
          expect.objectContaining({
            value: "brave",
            label: "Brave Search [Active]",
          }),
          expect.objectContaining({
            value: "__install_plugin__",
            label: "Install external provider plugin",
            hint: "Add an external web search plugin",
          }),
        ]),
      }),
    );
  });

  it("sets provider and key for perplexity", async () => {
    const cfg: OpenClawConfig = {};
    const { prompter } = createPrompter({
      selectValue: "perplexity",
      textValue: "pplx-test-key",
    });
    const result = await setupSearch(cfg, runtime, prompter);
    expect(result.tools?.web?.search?.provider).toBe("perplexity");
    expect(result.tools?.web?.search?.perplexity?.apiKey).toBe("pplx-test-key");
    expect(result.tools?.web?.search?.enabled).toBe(true);
  });

  it("sets provider and key for brave", async () => {
    const cfg: OpenClawConfig = {};
    const { prompter } = createPrompter({
      selectValue: "brave",
      textValue: "BSA-test-key",
    });
    const result = await setupSearch(cfg, runtime, prompter);
    expect(result.tools?.web?.search?.provider).toBe("brave");
    expect(result.tools?.web?.search?.enabled).toBe(true);
    expect(result.tools?.web?.search?.apiKey).toBe("BSA-test-key");
  });

  it("sets provider and key for gemini", async () => {
    const cfg: OpenClawConfig = {};
    const { prompter } = createPrompter({
      selectValue: "gemini",
      textValue: "AIza-test",
    });
    const result = await setupSearch(cfg, runtime, prompter);
    expect(result.tools?.web?.search?.provider).toBe("gemini");
    expect(result.tools?.web?.search?.enabled).toBe(true);
    expect(result.tools?.web?.search?.gemini?.apiKey).toBe("AIza-test");
  });

  it("sets provider and key for grok", async () => {
    const cfg: OpenClawConfig = {};
    const { prompter } = createPrompter({
      selectValue: "grok",
      textValue: "xai-test",
    });
    const result = await setupSearch(cfg, runtime, prompter);
    expect(result.tools?.web?.search?.provider).toBe("grok");
    expect(result.tools?.web?.search?.enabled).toBe(true);
    expect(result.tools?.web?.search?.grok?.apiKey).toBe("xai-test");
  });

  it("sets provider and key for kimi", async () => {
    const cfg: OpenClawConfig = {};
    const { prompter } = createPrompter({
      selectValue: "kimi",
      textValue: "sk-moonshot",
    });
    const result = await setupSearch(cfg, runtime, prompter);
    expect(result.tools?.web?.search?.provider).toBe("kimi");
    expect(result.tools?.web?.search?.enabled).toBe(true);
    expect(result.tools?.web?.search?.kimi?.apiKey).toBe("sk-moonshot");
  });

  it("sets plugin provider and prompts generic plugin config fields", async () => {
    loadOpenClawPlugins.mockReturnValue({
      searchProviders: [
        {
          pluginId: "tavily-search",
          provider: {
            id: "tavily",
            name: "Tavily Search",
            description: "Plugin search",
            configFieldOrder: ["apiKey", "searchDepth"],
            search: async () => ({ content: "ok" }),
          },
        },
      ],
      plugins: [
        {
          id: "tavily-search",
          name: "Tavily Search",
          description: "External Tavily plugin",
          origin: "workspace",
          source: "/tmp/tavily-search",
          configJsonSchema: {
            type: "object",
            properties: {
              apiKey: { type: "string" },
              searchDepth: { type: "string", enum: ["basic", "advanced"] },
            },
          },
          configUiHints: {
            apiKey: {
              label: "Tavily API key",
              placeholder: "tvly-...",
              sensitive: true,
            },
            searchDepth: {
              label: "Search depth",
            },
          },
        },
      ],
      typedHooks: [],
    });

    const cfg: OpenClawConfig = {};
    const { prompter } = createPrompter({
      selectValue: "tavily",
      textValue: "tvly-test-key",
    });
    (prompter.select as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce("tavily")
      .mockResolvedValueOnce("advanced");

    const result = await setupSearch(cfg, runtime, prompter);

    expect(result.tools?.web?.search?.provider).toBe("tavily");
    expect(result.tools?.web?.search?.enabled).toBe(true);
    expect(result.plugins?.entries?.["tavily-search"]?.enabled).toBe(true);
    expect(result.plugins?.entries?.["tavily-search"]?.config).toEqual({
      apiKey: "tvly-test-key",
      searchDepth: "advanced",
    });
    expect(loadOpenClawPlugins).toHaveBeenCalledWith(
      expect.objectContaining({
        suppressOpenAllowlistWarning: true,
      }),
    );
  });

  it("shows a provider setup note from before_search_provider_configure hooks", async () => {
    loadOpenClawPlugins.mockReturnValue({
      searchProviders: [
        {
          pluginId: "tavily-search",
          provider: {
            id: "tavily",
            name: "Tavily Search",
            description: "Plugin search",
            configFieldOrder: ["apiKey"],
            search: async () => ({ content: "ok" }),
          },
        },
      ],
      plugins: [
        {
          id: "tavily-search",
          name: "Tavily Search",
          description: "External Tavily plugin",
          origin: "workspace",
          source: "/tmp/tavily-search",
          configJsonSchema: {
            type: "object",
            properties: {
              apiKey: { type: "string" },
            },
          },
          configUiHints: {
            apiKey: {
              label: "Tavily API key",
              placeholder: "tvly-...",
              sensitive: true,
            },
          },
        },
      ],
      typedHooks: [
        {
          pluginId: "tavily-search",
          hookName: "before_provider_configure",
          priority: 10,
          source: "/tmp/tavily-search",
          handler: () => ({ note: "Generic provider guidance." }),
        },
        {
          pluginId: "tavily-search",
          hookName: "before_search_provider_configure",
          priority: 0,
          source: "/tmp/tavily-search",
          handler: () => ({ note: "Read the provider docs before entering your key." }),
        },
      ],
    });

    const { prompter, notes } = createPrompter({
      selectValue: "tavily",
      textValue: "tvly-test-key",
    });

    await setupSearch({}, runtime, prompter);

    expect(notes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          title: "Provider setup",
          message: "Generic provider guidance.",
        }),
      ]),
    );
  });

  it("fires after_search_provider_activate only when the active provider changes", async () => {
    const afterActivate = vi.fn();
    const afterProviderActivate = vi.fn();
    loadOpenClawPlugins.mockReturnValue({
      searchProviders: [
        {
          pluginId: "tavily-search",
          provider: {
            id: "tavily",
            name: "Tavily Search",
            description: "Plugin search",
            isAvailable: () => true,
            search: async () => ({ content: "ok" }),
          },
        },
      ],
      plugins: [
        {
          id: "tavily-search",
          name: "Tavily Search",
          description: "External Tavily plugin",
          origin: "workspace",
          source: "/tmp/tavily-search",
          configJsonSchema: undefined,
          configUiHints: undefined,
        },
      ],
      typedHooks: [
        {
          pluginId: "tavily-search",
          hookName: "after_provider_activate",
          priority: 0,
          source: "/tmp/tavily-search",
          handler: afterProviderActivate,
        },
        {
          pluginId: "tavily-search",
          hookName: "after_search_provider_activate",
          priority: 0,
          source: "/tmp/tavily-search",
          handler: afterActivate,
        },
      ],
    });

    const cfg: OpenClawConfig = {
      tools: {
        web: {
          search: {
            provider: "brave",
            enabled: true,
            apiKey: "BSA-test-key",
          },
        },
      },
      plugins: {
        entries: {
          "tavily-search": {
            enabled: true,
            config: {
              apiKey: "tvly-existing-key",
            },
          },
        },
      },
    };

    const { prompter } = createPrompter({
      selectValue: "tavily",
    });

    const result = await setupSearch(cfg, runtime, prompter);

    expect(result.tools?.web?.search?.provider).toBe("tavily");
    expect(afterProviderActivate).toHaveBeenCalledTimes(1);
    expect(afterProviderActivate).toHaveBeenCalledWith(
      expect.objectContaining({
        providerKind: "search",
        slot: "providers.search",
        providerId: "tavily",
        previousProviderId: "brave",
        intent: "switch-active",
      }),
      expect.objectContaining({
        workspaceDir: undefined,
      }),
    );
    expect(afterActivate).not.toHaveBeenCalled();
  });

  it("fires legacy after_search_provider_activate hooks when no generic provider hook is registered", async () => {
    const afterActivate = vi.fn();
    loadOpenClawPlugins.mockReturnValue({
      searchProviders: [
        {
          pluginId: "tavily-search",
          provider: {
            id: "tavily",
            name: "Tavily Search",
            description: "Plugin search",
            isAvailable: () => true,
            search: async () => ({ content: "ok" }),
          },
        },
      ],
      plugins: [
        {
          id: "tavily-search",
          name: "Tavily Search",
          description: "External Tavily plugin",
          origin: "workspace",
          source: "/tmp/tavily-search",
          configJsonSchema: undefined,
          configUiHints: undefined,
        },
      ],
      typedHooks: [
        {
          pluginId: "tavily-search",
          hookName: "after_search_provider_activate",
          priority: 0,
          source: "/tmp/tavily-search",
          handler: afterActivate,
        },
      ],
    });

    const cfg: OpenClawConfig = {
      tools: {
        web: {
          search: {
            provider: "brave",
            enabled: true,
            apiKey: "BSA-test-key",
          },
        },
      },
      plugins: {
        entries: {
          "tavily-search": {
            enabled: true,
            config: {
              apiKey: "tvly-existing-key",
            },
          },
        },
      },
    };

    const { prompter } = createPrompter({
      selectValue: "tavily",
    });

    const result = await setupSearch(cfg, runtime, prompter);

    expect(result.tools?.web?.search?.provider).toBe("tavily");
    expect(afterActivate).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: "tavily",
        previousProviderId: "brave",
        intent: "switch-active",
      }),
      expect.objectContaining({
        workspaceDir: undefined,
      }),
    );
  });

  it("re-prompts invalid plugin config values before saving", async () => {
    loadOpenClawPlugins.mockReturnValue({
      searchProviders: [
        {
          pluginId: "tavily-search",
          provider: {
            id: "tavily",
            name: "Tavily Search",
            description: "Plugin search",
            configFieldOrder: ["apiKey", "searchDepth"],
            search: async () => ({ content: "ok" }),
          },
        },
      ],
      plugins: [
        {
          id: "tavily-search",
          name: "Tavily Search",
          description: "External Tavily plugin",
          origin: "workspace",
          source: "/tmp/tavily-search",
          configJsonSchema: {
            type: "object",
            required: ["apiKey"],
            properties: {
              apiKey: { type: "string", minLength: 1, pattern: "^tvly-\\S+$" },
              searchDepth: { type: "string", enum: ["basic", "advanced"] },
            },
          },
          configUiHints: {
            apiKey: {
              label: "Tavily API key",
              placeholder: "tvly-...",
              sensitive: true,
            },
            searchDepth: {
              label: "Search depth",
            },
          },
        },
      ],
      typedHooks: [],
    });

    const cfg: OpenClawConfig = {};
    const { prompter, notes } = createPrompter({
      selectValue: "tavily",
      textValue: "",
    });
    (prompter.select as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce("tavily")
      .mockResolvedValueOnce("advanced")
      .mockResolvedValueOnce("advanced");
    (prompter.text as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce("bad-key")
      .mockResolvedValueOnce("tvly-valid-key");

    const result = await setupSearch(cfg, runtime, prompter);

    expect(notes.some((note) => note.title === "Invalid plugin config")).toBe(true);
    expect(result.plugins?.entries?.["tavily-search"]?.config).toEqual({
      apiKey: "tvly-valid-key",
      searchDepth: "advanced",
    });
  });

  it("does not switch active provider when plugin config is still invalid and unpromptable", async () => {
    loadOpenClawPlugins.mockReturnValue({
      searchProviders: [
        {
          pluginId: "tavily-search",
          provider: {
            id: "tavily",
            name: "Tavily Search",
            description: "Plugin search",
            search: async () => ({ content: "ok" }),
          },
        },
      ],
      plugins: [
        {
          id: "tavily-search",
          name: "Tavily Search",
          description: "External Tavily plugin",
          origin: "workspace",
          source: "/tmp/tavily-search",
          configJsonSchema: {
            type: "object",
            required: ["apiKey", "region"],
            properties: {
              apiKey: { type: "string", minLength: 1, pattern: "^tvly-\\S+$" },
              region: {
                type: "object",
                properties: {
                  code: { type: "string" },
                },
                required: ["code"],
              },
            },
          },
          configUiHints: {
            apiKey: {
              label: "Tavily API key",
              placeholder: "tvly-...",
              sensitive: true,
            },
          },
        },
      ],
      typedHooks: [],
    });

    const cfg: OpenClawConfig = {
      tools: {
        web: {
          search: {
            provider: "brave",
            enabled: true,
            apiKey: "BSA-test-key",
          },
        },
      },
      plugins: {
        entries: {
          "tavily-search": {
            enabled: true,
            config: {},
          },
        },
      },
    };

    const { prompter, notes } = createPrompter({
      selectValue: "tavily",
      textValue: "tvly-valid-key",
    });

    const result = await setupSearch(cfg, runtime, prompter);

    expect(result.tools?.web?.search?.provider).toBe("brave");
    expect(result.plugins?.entries?.["tavily-search"]?.enabled).toBe(true);
    expect(notes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          title: "Invalid plugin config",
        }),
      ]),
    );
  });

  it("keeps the existing sensitive plugin config value when left blank", async () => {
    loadOpenClawPlugins.mockReturnValue({
      searchProviders: [
        {
          pluginId: "tavily-search",
          provider: {
            id: "tavily",
            name: "Tavily Search",
            description: "Plugin search",
            configFieldOrder: ["apiKey", "searchDepth"],
            search: async () => ({ content: "ok" }),
          },
        },
      ],
      plugins: [
        {
          id: "tavily-search",
          name: "Tavily Search",
          description: "External Tavily plugin",
          origin: "workspace",
          source: "/tmp/tavily-search",
          configJsonSchema: {
            type: "object",
            required: ["apiKey"],
            properties: {
              apiKey: { type: "string", minLength: 1, pattern: "^tvly-\\S+$" },
              searchDepth: { type: "string", enum: ["basic", "advanced"] },
            },
          },
          configUiHints: {
            apiKey: {
              label: "Tavily API key",
              placeholder: "tvly-...",
              sensitive: true,
            },
            searchDepth: {
              label: "Search depth",
            },
          },
        },
      ],
      typedHooks: [],
    });

    const cfg: OpenClawConfig = {
      tools: {
        web: {
          search: {
            provider: "tavily",
            enabled: true,
          },
        },
      },
      plugins: {
        entries: {
          "tavily-search": {
            enabled: true,
            config: {
              apiKey: "tvly-existing-key",
              searchDepth: "basic",
            },
          },
        },
      },
    };
    const { prompter } = createPrompter({
      selectValue: "tavily",
      textValue: "",
    });
    (prompter.select as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce("tavily")
      .mockResolvedValueOnce("advanced");
    (prompter.text as ReturnType<typeof vi.fn>).mockResolvedValueOnce("");

    const result = await setupSearch(cfg, runtime, prompter);

    expect(result.plugins?.entries?.["tavily-search"]?.config).toEqual({
      apiKey: "tvly-existing-key",
      searchDepth: "advanced",
    });
  });

  it("installs an external search plugin and continues provider setup for the discovered provider", async () => {
    loadOpenClawPlugins.mockImplementation(({ config }: { config: OpenClawConfig }) => {
      const enabled = config.plugins?.entries?.["external-search"]?.enabled === true;
      return enabled
        ? {
            searchProviders: [
              {
                pluginId: "external-search",
                provider: {
                  id: "external-search",
                  name: "External Search",
                  description: "Plugin search",
                  configFieldOrder: ["apiKey", "searchDepth"],
                  search: async () => ({ content: "ok" }),
                },
              },
            ],
            plugins: [
              {
                id: "external-search",
                name: "External Search",
                description: "External search plugin",
                origin: "workspace",
                source: "/tmp/external-search",
                configJsonSchema: {
                  type: "object",
                  properties: {
                    apiKey: { type: "string" },
                    searchDepth: { type: "string", enum: ["basic", "advanced"] },
                  },
                },
                configUiHints: {
                  apiKey: {
                    label: "Tavily API key",
                    placeholder: "tvly-...",
                    sensitive: true,
                  },
                  searchDepth: {
                    label: "Search depth",
                  },
                },
              },
            ],
            typedHooks: [],
          }
        : { searchProviders: [], plugins: [], typedHooks: [] };
    });
    ensureGenericOnboardingPluginInstalled.mockImplementation(
      async ({ cfg }: { cfg: OpenClawConfig }) => ({
        cfg: {
          ...cfg,
          plugins: {
            ...cfg.plugins,
            entries: {
              ...cfg.plugins?.entries,
              "external-search": {
                ...(cfg.plugins?.entries?.["external-search"] as
                  | Record<string, unknown>
                  | undefined),
                enabled: true,
              },
            },
          },
        },
        installed: true,
        pluginId: "external-search",
      }),
    );

    const { prompter } = createPrompter({
      selectValue: "__install_plugin__",
      textValue: "tvly-installed-key",
    });
    (prompter.select as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce("__install_plugin__")
      .mockResolvedValueOnce("advanced");

    const result = await setupSearch({}, runtime, prompter, {
      workspaceDir: "/tmp/workspace-search",
    });

    expect(ensureGenericOnboardingPluginInstalled).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceDir: "/tmp/workspace-search",
      }),
    );
    expect(reloadOnboardingPluginRegistry).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceDir: "/tmp/workspace-search",
      }),
    );
    expect(result.tools?.web?.search?.provider).toBe("external-search");
    expect(result.plugins?.entries?.["external-search"]?.enabled).toBe(true);
    expect(result.plugins?.entries?.["external-search"]?.config).toEqual({
      apiKey: "tvly-installed-key",
      searchDepth: "advanced",
    });
  });

  it("continues into plugin config prompts even when the newly installed provider cannot register yet", async () => {
    loadOpenClawPlugins.mockImplementation(({ config }: { config: OpenClawConfig }) => {
      const hasApiKey = Boolean(config.plugins?.entries?.["external-search"]?.config?.apiKey);
      return hasApiKey
        ? {
            searchProviders: [
              {
                pluginId: "external-search",
                provider: {
                  id: "external-search",
                  name: "External Search",
                  description: "Plugin search",
                  configFieldOrder: ["apiKey", "searchDepth"],
                  search: async () => ({ content: "ok" }),
                },
              },
            ],
            plugins: [
              {
                id: "external-search",
                name: "External Search",
                description: "External search plugin",
                origin: "workspace",
                source: "/tmp/external-search",
                configJsonSchema: {
                  type: "object",
                  required: ["apiKey"],
                  properties: {
                    apiKey: { type: "string", minLength: 1, pattern: "^tvly-\\S+$" },
                    searchDepth: { type: "string", enum: ["basic", "advanced"] },
                  },
                },
                configUiHints: {
                  apiKey: {
                    label: "Tavily API key",
                    placeholder: "tvly-...",
                    sensitive: true,
                  },
                  searchDepth: {
                    label: "Search depth",
                  },
                },
              },
            ],
            typedHooks: [],
          }
        : {
            searchProviders: [],
            plugins: [
              {
                id: "external-search",
                name: "External Search",
                description: "External search plugin",
                origin: "workspace",
                source: "/tmp/external-search",
                configJsonSchema: {
                  type: "object",
                  required: ["apiKey"],
                  properties: {
                    apiKey: { type: "string", minLength: 1, pattern: "^tvly-\\S+$" },
                    searchDepth: { type: "string", enum: ["basic", "advanced"] },
                  },
                },
                configUiHints: {
                  apiKey: {
                    label: "Tavily API key",
                    placeholder: "tvly-...",
                    sensitive: true,
                  },
                  searchDepth: {
                    label: "Search depth",
                  },
                },
              },
            ],
            typedHooks: [],
          };
    });
    loadPluginManifestRegistry.mockReturnValue({
      plugins: [
        {
          id: "external-search",
          name: "External Search",
          description: "External search plugin",
          origin: "workspace",
          source: "/tmp/external-search",
          provides: ["providers.search.external-search"],
          configSchema: {
            type: "object",
            required: ["apiKey"],
            properties: {
              apiKey: { type: "string", minLength: 1, pattern: "^tvly-\\S+$" },
              searchDepth: { type: "string", enum: ["basic", "advanced"] },
            },
          },
          configUiHints: {
            apiKey: {
              label: "Tavily API key",
              placeholder: "tvly-...",
              sensitive: true,
            },
            searchDepth: {
              label: "Search depth",
            },
          },
        },
      ],
      diagnostics: [],
    });
    ensureGenericOnboardingPluginInstalled.mockImplementation(
      async ({ cfg }: { cfg: OpenClawConfig }) => ({
        cfg: {
          ...cfg,
          plugins: {
            ...cfg.plugins,
            entries: {
              ...cfg.plugins?.entries,
              "external-search": {
                ...(cfg.plugins?.entries?.["external-search"] as
                  | Record<string, unknown>
                  | undefined),
                enabled: true,
              },
            },
          },
        },
        installed: true,
        pluginId: "external-search",
      }),
    );

    const { prompter, notes } = createPrompter({
      selectValue: "__install_plugin__",
      textValue: "tvly-installed-key",
    });
    (prompter.select as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce("__install_plugin__")
      .mockResolvedValueOnce("advanced");

    const result = await setupSearch({}, runtime, prompter, {
      workspaceDir: "/tmp/workspace-search",
    });

    expect(
      notes.some((note) => note.message.includes("could not load its web search provider yet")),
    ).toBe(false);
    expect(result.tools?.web?.search?.provider).toBe("external-search");
    expect(result.plugins?.entries?.["external-search"]?.config).toEqual({
      apiKey: "tvly-installed-key",
      searchDepth: "advanced",
    });
  });

  it("shows missing-key note when no key is provided and no env var", async () => {
    const original = process.env.BRAVE_API_KEY;
    delete process.env.BRAVE_API_KEY;
    try {
      const cfg: OpenClawConfig = {};
      const { prompter, notes } = createPrompter({
        selectValue: "brave",
        textValue: "",
      });
      const result = await setupSearch(cfg, runtime, prompter);
      expect(result.tools?.web?.search?.provider).toBe("brave");
      expect(result.tools?.web?.search?.enabled).toBeUndefined();
      const missingNote = notes.find((n) => n.message.includes("No API key stored"));
      expect(missingNote).toBeDefined();
    } finally {
      if (original === undefined) {
        delete process.env.BRAVE_API_KEY;
      } else {
        process.env.BRAVE_API_KEY = original;
      }
    }
  });

  it("keeps existing key when user leaves input blank", async () => {
    const result = await runBlankPerplexityKeyEntry(
      "existing-key", // pragma: allowlist secret
    );
    expect(result.tools?.web?.search?.perplexity?.apiKey).toBe("existing-key");
    expect(result.tools?.web?.search?.enabled).toBe(true);
  });

  it("advanced preserves enabled:false when keeping existing key", async () => {
    const result = await runBlankPerplexityKeyEntry(
      "existing-key", // pragma: allowlist secret
      false,
    );
    expect(result.tools?.web?.search?.perplexity?.apiKey).toBe("existing-key");
    expect(result.tools?.web?.search?.enabled).toBe(false);
  });

  it("quickstart skips key prompt when config key exists", async () => {
    const { result, prompter } = await runQuickstartPerplexitySetup(
      "stored-pplx-key", // pragma: allowlist secret
    );
    expect(result.tools?.web?.search?.provider).toBe("perplexity");
    expect(result.tools?.web?.search?.perplexity?.apiKey).toBe("stored-pplx-key");
    expect(result.tools?.web?.search?.enabled).toBe(true);
    expect(prompter.text).not.toHaveBeenCalled();
  });

  it("quickstart preserves enabled:false when search was intentionally disabled", async () => {
    const { result, prompter } = await runQuickstartPerplexitySetup(
      "stored-pplx-key", // pragma: allowlist secret
      false,
    );
    expect(result.tools?.web?.search?.provider).toBe("perplexity");
    expect(result.tools?.web?.search?.perplexity?.apiKey).toBe("stored-pplx-key");
    expect(result.tools?.web?.search?.enabled).toBe(false);
    expect(prompter.text).not.toHaveBeenCalled();
  });

  it("quickstart falls through to key prompt when no key and no env var", async () => {
    const original = process.env.XAI_API_KEY;
    delete process.env.XAI_API_KEY;
    try {
      const cfg: OpenClawConfig = {};
      const { prompter } = createPrompter({ selectValue: "grok", textValue: "" });
      const result = await setupSearch(cfg, runtime, prompter, {
        quickstartDefaults: true,
      });
      expect(prompter.text).toHaveBeenCalled();
      expect(result.tools?.web?.search?.provider).toBe("grok");
      expect(result.tools?.web?.search?.enabled).toBeUndefined();
    } finally {
      if (original === undefined) {
        delete process.env.XAI_API_KEY;
      } else {
        process.env.XAI_API_KEY = original;
      }
    }
  });

  it("quickstart skips key prompt when env var is available", async () => {
    const orig = process.env.BRAVE_API_KEY;
    process.env.BRAVE_API_KEY = "env-brave-key"; // pragma: allowlist secret
    try {
      const cfg: OpenClawConfig = {};
      const { prompter } = createPrompter({ selectValue: "brave" });
      const result = await setupSearch(cfg, runtime, prompter, {
        quickstartDefaults: true,
      });
      expect(result.tools?.web?.search?.provider).toBe("brave");
      expect(result.tools?.web?.search?.enabled).toBe(true);
      expect(prompter.text).not.toHaveBeenCalled();
    } finally {
      if (orig === undefined) {
        delete process.env.BRAVE_API_KEY;
      } else {
        process.env.BRAVE_API_KEY = orig;
      }
    }
  });

  it("stores env-backed SecretRef when secretInputMode=ref for perplexity", async () => {
    const cfg: OpenClawConfig = {};
    const { prompter } = createPrompter({ selectValue: "perplexity" });
    const result = await setupSearch(cfg, runtime, prompter, {
      secretInputMode: "ref", // pragma: allowlist secret
    });
    expect(result.tools?.web?.search?.provider).toBe("perplexity");
    expect(result.tools?.web?.search?.perplexity?.apiKey).toEqual({
      source: "env",
      provider: "default",
      id: "PERPLEXITY_API_KEY", // pragma: allowlist secret
    });
    expect(prompter.text).not.toHaveBeenCalled();
  });

  it("stores env-backed SecretRef when secretInputMode=ref for brave", async () => {
    const cfg: OpenClawConfig = {};
    const { prompter } = createPrompter({ selectValue: "brave" });
    const result = await setupSearch(cfg, runtime, prompter, {
      secretInputMode: "ref", // pragma: allowlist secret
    });
    expect(result.tools?.web?.search?.provider).toBe("brave");
    expect(result.tools?.web?.search?.apiKey).toEqual({
      source: "env",
      provider: "default",
      id: "BRAVE_API_KEY",
    });
    expect(prompter.text).not.toHaveBeenCalled();
  });

  it("stores plaintext key when secretInputMode is unset", async () => {
    const cfg: OpenClawConfig = {};
    const { prompter } = createPrompter({
      selectValue: "brave",
      textValue: "BSA-plain",
    });
    const result = await setupSearch(cfg, runtime, prompter);
    expect(result.tools?.web?.search?.apiKey).toBe("BSA-plain");
  });

  it("exports all 5 providers in SEARCH_PROVIDER_OPTIONS", () => {
    expect(SEARCH_PROVIDER_OPTIONS).toHaveLength(5);
    const values = SEARCH_PROVIDER_OPTIONS.map((e) => e.value);
    expect(values).toEqual(["brave", "gemini", "grok", "kimi", "perplexity"]);
  });
});
