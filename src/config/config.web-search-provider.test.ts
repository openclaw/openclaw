import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildWebSearchProviderConfig } from "./test-helpers.js";

vi.mock("../runtime.js", () => ({
  defaultRuntime: { log: vi.fn(), error: vi.fn() },
}));

vi.mock("../plugin-sdk/telegram-command-config.js", () => ({
  TELEGRAM_COMMAND_NAME_PATTERN: /^[a-z0-9_]+$/,
  normalizeTelegramCommandName: (value: string) => value.trim().toLowerCase(),
  normalizeTelegramCommandDescription: (value: string) => value.trim(),
  resolveTelegramCustomCommands: () => ({ commands: [], issues: [] }),
}));

const getScopedWebSearchCredential = (key: string) => (search?: Record<string, unknown>) =>
  (search?.[key] as { apiKey?: unknown } | undefined)?.apiKey;
const getConfiguredPluginWebSearchConfig =
  (pluginId: string) => (config?: Record<string, unknown>) =>
    (
      config?.plugins as
        | {
            entries?: Record<
              string,
              { config?: { webSearch?: { apiKey?: unknown; baseUrl?: unknown } } }
            >;
          }
        | undefined
    )?.entries?.[pluginId]?.config?.webSearch;
const getConfiguredPluginWebSearchCredential =
  (pluginId: string) => (config?: Record<string, unknown>) =>
    getConfiguredPluginWebSearchConfig(pluginId)(config)?.apiKey;

const mockWebSearchProviders = [
  {
    id: "brave",
    pluginId: "brave",
    envVars: ["BRAVE_API_KEY"],
    credentialPath: "plugins.entries.brave.config.webSearch.apiKey",
    getCredentialValue: (search?: Record<string, unknown>) => search?.apiKey,
    getConfiguredCredentialValue: getConfiguredPluginWebSearchCredential("brave"),
  },
  {
    id: "firecrawl",
    pluginId: "firecrawl",
    envVars: ["FIRECRAWL_API_KEY"],
    credentialPath: "plugins.entries.firecrawl.config.webSearch.apiKey",
    getCredentialValue: getScopedWebSearchCredential("firecrawl"),
    getConfiguredCredentialValue: getConfiguredPluginWebSearchCredential("firecrawl"),
  },
  {
    id: "gemini",
    pluginId: "google",
    envVars: ["GEMINI_API_KEY"],
    credentialPath: "plugins.entries.google.config.webSearch.apiKey",
    getCredentialValue: getScopedWebSearchCredential("gemini"),
    getConfiguredCredentialValue: getConfiguredPluginWebSearchCredential("google"),
  },
  {
    id: "grok",
    pluginId: "xai",
    envVars: ["XAI_API_KEY"],
    credentialPath: "plugins.entries.xai.config.webSearch.apiKey",
    getCredentialValue: getScopedWebSearchCredential("grok"),
    getConfiguredCredentialValue: getConfiguredPluginWebSearchCredential("xai"),
  },
  {
    id: "kimi",
    pluginId: "moonshot",
    envVars: ["KIMI_API_KEY", "MOONSHOT_API_KEY"],
    credentialPath: "plugins.entries.moonshot.config.webSearch.apiKey",
    getCredentialValue: getScopedWebSearchCredential("kimi"),
    getConfiguredCredentialValue: getConfiguredPluginWebSearchCredential("moonshot"),
  },
  {
    id: "minimax",
    pluginId: "minimax",
    envVars: ["MINIMAX_CODE_PLAN_KEY", "MINIMAX_CODING_API_KEY"],
    credentialPath: "plugins.entries.minimax.config.webSearch.apiKey",
    getCredentialValue: getScopedWebSearchCredential("minimax"),
    getConfiguredCredentialValue: getConfiguredPluginWebSearchCredential("minimax"),
  },
  {
    id: "perplexity",
    pluginId: "perplexity",
    envVars: ["PERPLEXITY_API_KEY", "OPENROUTER_API_KEY"],
    credentialPath: "plugins.entries.perplexity.config.webSearch.apiKey",
    getCredentialValue: getScopedWebSearchCredential("perplexity"),
    getConfiguredCredentialValue: getConfiguredPluginWebSearchCredential("perplexity"),
  },
  {
    id: "searxng",
  it("accepts minimax provider config on the plugin-owned path", () => {
    const res = validateConfigObjectWithPlugins(
      buildWebSearchProviderConfig({
        enabled: true,
        provider: "minimax",
        providerConfig: {
          apiKey: {
            source: "env",
            provider: "default",
            id: "MINIMAX_CODE_PLAN_KEY",
          },
        },
      }),
    );

    expect(res.ok).toBe(true);
  });

  it("accepts searxng provider config on the plugin-owned path", () => {
    const res = validateConfigObjectWithPlugins(
      buildWebSearchProviderConfig({
        enabled: true,
        provider: "searxng",
        providerConfig: {
          baseUrl: {
            source: "env",
            provider: "default",
            id: "SEARXNG_BASE_URL",
          },
        },
      }),
    );

    expect(res.ok).toBe(true);
  });

  it("rejects legacy scoped Tavily config", () => {
    const res = validateConfigObjectWithPlugins({
      tools: {
        web: {
          search: {
            provider: "tavily",
            tavily: {
              apiKey: "tvly-test-key",
            },
          },
        },
      },
    });

    expect(res.ok).toBe(false);
  });

  it("detects legacy scoped provider config for bundled providers", () => {
    const res = validateConfigObjectWithPlugins({
      tools: {
        web: {
          search: {
            provider: "gemini",
            gemini: {
              apiKey: "legacy-key",
            },
          },
        },
      },
    });

    expect(res.ok).toBe(false);
  });

  it("accepts gemini provider with no extra config", () => {
    const res = validateConfigObjectWithPlugins(
      buildWebSearchProviderConfig({
        provider: "gemini",
      }),
    );

    expect(res.ok).toBe(true);
  });
});

describe("web search provider auto-detection", () => {
  const savedEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.BRAVE_API_KEY;
    delete process.env.FIRECRAWL_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.KIMI_API_KEY;
    delete process.env.MINIMAX_API_KEY;
    delete process.env.MINIMAX_CODE_PLAN_KEY;
    delete process.env.MINIMAX_CODING_API_KEY;
    delete process.env.MOONSHOT_API_KEY;
    delete process.env.PERPLEXITY_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.SEARXNG_BASE_URL;
    delete process.env.TAVILY_API_KEY;
    delete process.env.XAI_API_KEY;
    delete process.env.KIMI_API_KEY;
    delete process.env.MOONSHOT_API_KEY;
  });

  afterEach(() => {
    process.env = { ...savedEnv };
    vi.restoreAllMocks();
  });

  it("falls back to brave when no keys available", () => {
    expect(resolveSearchProvider({})).toBe("brave");
  });

  it("auto-detects brave when only BRAVE_API_KEY is set", () => {
    process.env.BRAVE_API_KEY = "test-brave-key"; // pragma: allowlist secret
    expect(resolveSearchProvider({})).toBe("brave");
  });

  it("auto-detects gemini when only GEMINI_API_KEY is set", () => {
    process.env.GEMINI_API_KEY = "test-gemini-key"; // pragma: allowlist secret
    expect(resolveSearchProvider({})).toBe("gemini");
  });

  it("auto-detects tavily when only TAVILY_API_KEY is set", () => {
    process.env.TAVILY_API_KEY = "tvly-test-key"; // pragma: allowlist secret
    expect(resolveSearchProvider({})).toBe("tavily");
  });

  it("auto-detects firecrawl when only FIRECRAWL_API_KEY is set", () => {
    process.env.FIRECRAWL_API_KEY = "fc-test-key"; // pragma: allowlist secret
    expect(resolveSearchProvider({})).toBe("firecrawl");
  });

  it("auto-detects searxng when only SEARXNG_BASE_URL is set", () => {
    process.env.SEARXNG_BASE_URL = "http://localhost:8080";
    expect(resolveSearchProvider({})).toBe("searxng");
  });

  it("auto-detects kimi when only KIMI_API_KEY is set", () => {
    process.env.KIMI_API_KEY = "test-kimi-key"; // pragma: allowlist secret
    expect(resolveSearchProvider({})).toBe("kimi");
  });

  it("auto-detects minimax when only MINIMAX_CODE_PLAN_KEY is set", () => {
    process.env.MINIMAX_CODE_PLAN_KEY = "sk-cp-test";
    expect(resolveSearchProvider({})).toBe("minimax");
  });

  it("auto-detects perplexity when only PERPLEXITY_API_KEY is set", () => {
    process.env.PERPLEXITY_API_KEY = "test-perplexity-key"; // pragma: allowlist secret
    expect(resolveSearchProvider({})).toBe("perplexity");
  });

  it("auto-detects perplexity when only OPENROUTER_API_KEY is set", () => {
    process.env.OPENROUTER_API_KEY = "sk-or-v1-test"; // pragma: allowlist secret
    expect(resolveSearchProvider({})).toBe("perplexity");
  });

  it("auto-detects grok when only XAI_API_KEY is set", () => {
    process.env.XAI_API_KEY = "test-xai-key"; // pragma: allowlist secret
    expect(resolveSearchProvider({})).toBe("grok");
  });

  it("auto-detects kimi when only KIMI_API_KEY is set", () => {
    process.env.KIMI_API_KEY = "test-kimi-key"; // pragma: allowlist secret
    expect(resolveSearchProvider({})).toBe("kimi");
  });

  it("auto-detects kimi when only MOONSHOT_API_KEY is set", () => {
    process.env.MOONSHOT_API_KEY = "test-moonshot-key"; // pragma: allowlist secret
    expect(resolveSearchProvider({})).toBe("kimi");
  });

  it("follows alphabetical order — brave wins when multiple keys available", () => {
    process.env.BRAVE_API_KEY = "test-brave-key"; // pragma: allowlist secret
    process.env.GEMINI_API_KEY = "test-gemini-key"; // pragma: allowlist secret
    process.env.PERPLEXITY_API_KEY = "test-perplexity-key"; // pragma: allowlist secret
    process.env.XAI_API_KEY = "test-xai-key"; // pragma: allowlist secret
    expect(resolveSearchProvider({})).toBe("brave");
  });

  it("gemini wins over grok, kimi, and perplexity when brave unavailable", () => {
    process.env.GEMINI_API_KEY = "test-gemini-key"; // pragma: allowlist secret
    process.env.PERPLEXITY_API_KEY = "test-perplexity-key"; // pragma: allowlist secret
    process.env.XAI_API_KEY = "test-xai-key"; // pragma: allowlist secret
    expect(resolveSearchProvider({})).toBe("gemini");
  });

  it("grok wins over kimi and perplexity when brave and gemini unavailable", () => {
    process.env.XAI_API_KEY = "test-xai-key"; // pragma: allowlist secret
    process.env.KIMI_API_KEY = "test-kimi-key"; // pragma: allowlist secret
    process.env.PERPLEXITY_API_KEY = "test-perplexity-key"; // pragma: allowlist secret
    expect(resolveSearchProvider({})).toBe("grok");
  });

  it("explicit provider always wins regardless of keys", () => {
    process.env.BRAVE_API_KEY = "test-brave-key"; // pragma: allowlist secret
    expect(
      resolveSearchProvider({ provider: "gemini" } as unknown as Parameters<
        typeof resolveSearchProvider
      >[0]),
    ).toBe("gemini");
  });
});
