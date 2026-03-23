import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { validateConfigObjectWithPlugins } from "./config.js";
import { buildWebSearchProviderConfig } from "./test-helpers.js";

vi.mock("../runtime.js", () => ({
  defaultRuntime: { log: vi.fn(), error: vi.fn() },
}));

vi.mock("../plugins/web-search-providers.js", () => {
  const getScoped = (key: string) => (search?: Record<string, unknown>) =>
    (search?.[key] as { apiKey?: unknown } | undefined)?.apiKey;
  const getConfigured = (pluginId: string) => (config?: Record<string, unknown>) =>
    (
      config?.plugins as
        | { entries?: Record<string, { config?: { webSearch?: { apiKey?: unknown } } }> }
        | undefined
    )?.entries?.[pluginId]?.config?.webSearch?.apiKey;
  return {
    resolveBundledPluginWebSearchProviders: () => [
      {
        id: "brave",
        envVars: ["BRAVE_API_KEY"],
        credentialPath: "plugins.entries.brave.config.webSearch.apiKey",
        getCredentialValue: (search?: Record<string, unknown>) => search?.apiKey,
        getConfiguredCredentialValue: getConfigured("brave"),
      },
      {
        id: "firecrawl",
        envVars: ["FIRECRAWL_API_KEY"],
        credentialPath: "plugins.entries.firecrawl.config.webSearch.apiKey",
        getCredentialValue: getScoped("firecrawl"),
        getConfiguredCredentialValue: getConfigured("firecrawl"),
      },
      {
        id: "gemini",
        envVars: ["GEMINI_API_KEY"],
        credentialPath: "plugins.entries.google.config.webSearch.apiKey",
        getCredentialValue: getScoped("gemini"),
        getConfiguredCredentialValue: getConfigured("google"),
      },
      {
        id: "grok",
        envVars: ["XAI_API_KEY"],
        credentialPath: "plugins.entries.xai.config.webSearch.apiKey",
        getCredentialValue: getScoped("grok"),
        getConfiguredCredentialValue: getConfigured("xai"),
      },
      {
        id: "kimi",
        envVars: ["KIMI_API_KEY", "MOONSHOT_API_KEY"],
        credentialPath: "plugins.entries.moonshot.config.webSearch.apiKey",
        getCredentialValue: getScoped("kimi"),
        getConfiguredCredentialValue: getConfigured("moonshot"),
      },
      {
        id: "perplexity",
        envVars: ["PERPLEXITY_API_KEY", "OPENROUTER_API_KEY"],
        credentialPath: "plugins.entries.perplexity.config.webSearch.apiKey",
        getCredentialValue: getScoped("perplexity"),
        getConfiguredCredentialValue: getConfigured("perplexity"),
      },
      {
        id: "tavily",
        envVars: ["TAVILY_API_KEY"],
        credentialPath: "plugins.entries.tavily.config.webSearch.apiKey",
        getCredentialValue: getScoped("tavily"),
        getConfiguredCredentialValue: getConfigured("tavily"),
      },
    ],
    resolvePluginWebSearchProviders: () => [
      {
        id: "brave",
        envVars: ["BRAVE_API_KEY"],
        credentialPath: "plugins.entries.brave.config.webSearch.apiKey",
        getCredentialValue: (search?: Record<string, unknown>) => search?.apiKey,
        getConfiguredCredentialValue: getConfigured("brave"),
      },
      {
        id: "firecrawl",
        envVars: ["FIRECRAWL_API_KEY"],
        credentialPath: "plugins.entries.firecrawl.config.webSearch.apiKey",
        getCredentialValue: getScoped("firecrawl"),
        getConfiguredCredentialValue: getConfigured("firecrawl"),
      },
      {
        id: "gemini",
        envVars: ["GEMINI_API_KEY"],
        credentialPath: "plugins.entries.google.config.webSearch.apiKey",
        getCredentialValue: getScoped("gemini"),
        getConfiguredCredentialValue: getConfigured("google"),
      },
      {
        id: "grok",
        envVars: ["XAI_API_KEY"],
        credentialPath: "plugins.entries.xai.config.webSearch.apiKey",
        getCredentialValue: getScoped("grok"),
        getConfiguredCredentialValue: getConfigured("xai"),
      },
      {
        id: "kimi",
        envVars: ["KIMI_API_KEY", "MOONSHOT_API_KEY"],
        credentialPath: "plugins.entries.moonshot.config.webSearch.apiKey",
        getCredentialValue: getScoped("kimi"),
        getConfiguredCredentialValue: getConfigured("moonshot"),
      },
      {
        id: "perplexity",
        envVars: ["PERPLEXITY_API_KEY", "OPENROUTER_API_KEY"],
        credentialPath: "plugins.entries.perplexity.config.webSearch.apiKey",
        getCredentialValue: getScoped("perplexity"),
        getConfiguredCredentialValue: getConfigured("perplexity"),
      },
      {
        id: "tavily",
        envVars: ["TAVILY_API_KEY"],
        credentialPath: "plugins.entries.tavily.config.webSearch.apiKey",
        getCredentialValue: getScoped("tavily"),
        getConfiguredCredentialValue: getConfigured("tavily"),
      },
    ],
  };
});

const { __testing } = await import("../agents/tools/web-search.js");
const { resolveSearchProvider } = __testing;

function pluginWebSearchApiKey(
  config: Record<string, unknown> | undefined,
  pluginId: string,
): unknown {
  return (
    config?.plugins as
      | { entries?: Record<string, { config?: { webSearch?: { apiKey?: unknown } } }> }
      | undefined
  )?.entries?.[pluginId]?.config?.webSearch?.apiKey;
}

describe("web search provider config", () => {
  it("does not warn for legacy brave config when bundled web search allowlist compat applies", () => {
    const res = validateConfigObjectWithPlugins({
      plugins: {
        allow: ["bluebubbles", "memory-core"],
      },
      tools: {
        web: {
          search: {
            enabled: true,
            apiKey: "test-brave-key", // pragma: allowlist secret
          },
        },
      },
    });

    expect(res.ok).toBe(true);
    if (!res.ok) {
      return;
    }
    expect(res.warnings).not.toContainEqual(
      expect.objectContaining({
        path: "plugins.entries.brave",
        message: expect.stringContaining(
          "plugin disabled (not in allowlist) but config is present",
        ),
      }),
    );
  });

  it("accepts perplexity provider and config", () => {
    const res = validateConfigObjectWithPlugins(
      buildWebSearchProviderConfig({
        enabled: true,
        provider: "perplexity",
        providerConfig: {
          apiKey: "test-key", // pragma: allowlist secret
          baseUrl: "https://openrouter.ai/api/v1",
          model: "perplexity/sonar-pro",
        },
      }),
    );

    expect(res.ok).toBe(true);
  });

  it("accepts gemini provider and config", () => {
    const res = validateConfigObjectWithPlugins(
      buildWebSearchProviderConfig({
        enabled: true,
        provider: "gemini",
        providerConfig: {
          apiKey: "test-key", // pragma: allowlist secret
          model: "gemini-2.5-flash",
        },
      }),
    );

    expect(res.ok).toBe(true);
  });

  it("accepts firecrawl provider and config", () => {
    const res = validateConfigObjectWithPlugins(
      buildWebSearchProviderConfig({
        enabled: true,
        provider: "firecrawl",
        providerConfig: {
          apiKey: "fc-test-key", // pragma: allowlist secret
          baseUrl: "https://api.firecrawl.dev",
        },
      }),
    );

    expect(res.ok).toBe(true);
  });

  it("accepts tavily provider config on the plugin-owned path", () => {
    const res = validateConfigObjectWithPlugins(
      buildWebSearchProviderConfig({
        enabled: true,
        provider: "tavily",
        providerConfig: {
          apiKey: {
            source: "env",
            provider: "default",
            id: "TAVILY_API_KEY",
          },
          baseUrl: "https://api.tavily.com",
        },
      }),
    );

    expect(res.ok).toBe(true);
  });

  it("does not migrate the nonexistent legacy Tavily scoped config", () => {
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

    expect(res.ok).toBe(true);
    if (!res.ok) {
      return;
    }
    expect(res.config.tools?.web?.search?.provider).toBe("tavily");
    expect((res.config.tools?.web?.search as Record<string, unknown> | undefined)?.tavily).toBe(
      undefined,
    );
    expect(pluginWebSearchApiKey(res.config as Record<string, unknown>, "tavily")).toBe(undefined);
  });

  it("accepts gemini provider with no extra config", () => {
    const res = validateConfigObjectWithPlugins(
      buildWebSearchProviderConfig({
        provider: "gemini",
      }),
    );

    expect(res.ok).toBe(true);
  });

  it("accepts brave llm-context mode config", () => {
    const res = validateConfigObjectWithPlugins(
      buildWebSearchProviderConfig({
        provider: "brave",
        providerConfig: {
          mode: "llm-context",
        },
      }),
    );

    expect(res.ok).toBe(true);
  });

  it("rejects invalid brave mode config values", () => {
    const res = validateConfigObjectWithPlugins(
      buildWebSearchProviderConfig({
        provider: "brave",
        providerConfig: {
          mode: "invalid-mode",
        },
      }),
    );

    expect(res.ok).toBe(false);
  });
});

describe("web search provider auto-detection", () => {
  const savedEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.BRAVE_API_KEY;
    delete process.env.FIRECRAWL_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.KIMI_API_KEY;
    delete process.env.MOONSHOT_API_KEY;
    delete process.env.PERPLEXITY_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
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

  it("auto-detects kimi when only KIMI_API_KEY is set", () => {
    process.env.KIMI_API_KEY = "test-kimi-key"; // pragma: allowlist secret
    expect(resolveSearchProvider({})).toBe("kimi");
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
