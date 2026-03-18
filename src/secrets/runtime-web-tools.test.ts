import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import * as webSearchProviders from "../plugins/web-search-providers.js";
import * as secretResolve from "./resolve.js";
import { createResolverContext } from "./runtime-shared.js";
import { resolveRuntimeWebTools } from "./runtime-web-tools.js";

type ProviderUnderTest = "brave" | "gemini" | "grok" | "kimi" | "perplexity";

function asConfig(value: unknown): OpenClawConfig {
  return value as OpenClawConfig;
}

function providerPluginId(provider: ProviderUnderTest): string {
  switch (provider) {
    case "gemini":
      return "google";
    case "grok":
      return "xai";
    case "kimi":
      return "moonshot";
    default:
      return provider;
  }
}

async function runRuntimeWebTools(params: { config: OpenClawConfig; env?: NodeJS.ProcessEnv }) {
  const sourceConfig = structuredClone(params.config);
  const resolvedConfig = structuredClone(params.config);
  const context = createResolverContext({
    sourceConfig,
    env: params.env ?? {},
  });
  const metadata = await resolveRuntimeWebTools({
    sourceConfig,
    resolvedConfig,
    context,
  });
  return { metadata, resolvedConfig, context };
}

function createProviderSecretRefConfig(
  provider: ProviderUnderTest,
  envRefId: string,
): OpenClawConfig {
  return asConfig({
    tools: {
      web: {
        search: {
          enabled: true,
          provider,
        },
      },
    },
    plugins: {
      entries: {
        [providerPluginId(provider)]: {
          enabled: true,
          config: {
            webSearch: {
              apiKey: { source: "env", provider: "default", id: envRefId },
            },
          },
        },
      },
    },
  });
}

function readProviderKey(config: OpenClawConfig, provider: ProviderUnderTest): unknown {
  const pluginConfig = config.plugins?.entries?.[providerPluginId(provider)]?.config as
    | { webSearch?: { apiKey?: unknown } }
    | undefined;
  return pluginConfig?.webSearch?.apiKey;
}

function expectInactiveFirecrawlSecretRef(params: {
  resolveSpy: ReturnType<typeof vi.spyOn>;
  metadata: Awaited<ReturnType<typeof runRuntimeWebTools>>["metadata"];
  context: Awaited<ReturnType<typeof runRuntimeWebTools>>["context"];
}) {
  expect(params.resolveSpy).not.toHaveBeenCalled();
  expect(params.metadata.fetch.firecrawl.active).toBe(false);
  expect(params.metadata.fetch.firecrawl.apiKeySource).toBe("secretRef");
  expect(params.context.warnings).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        code: "SECRETS_REF_IGNORED_INACTIVE_SURFACE",
        path: "tools.web.fetch.firecrawl.apiKey",
      }),
    ]),
  );
}

describe("runtime web tools resolution", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("skips loading web search providers when search config is absent", async () => {
    const providerSpy = vi.spyOn(webSearchProviders, "resolvePluginWebSearchProviders");

    const { metadata } = await runRuntimeWebTools({
      config: asConfig({
        tools: {
          web: {
            fetch: {
              firecrawl: {
                apiKey: { source: "env", provider: "default", id: "FIRECRAWL_API_KEY_REF" },
              },
            },
          },
        },
      }),
      env: {
        FIRECRAWL_API_KEY: "firecrawl-runtime-key", // pragma: allowlist secret
      },
    });

    expect(providerSpy).not.toHaveBeenCalled();
    expect(metadata.search.providerSource).toBe("none");
    expect(metadata.fetch.firecrawl.active).toBe(true);
    expect(metadata.fetch.firecrawl.apiKeySource).toBe("env");
  });

  it.each([
    {
      provider: "brave" as const,
      envRefId: "BRAVE_PROVIDER_REF",
      resolvedKey: "brave-provider-key",
    },
    {
      provider: "gemini" as const,
      envRefId: "GEMINI_PROVIDER_REF",
      resolvedKey: "gemini-provider-key",
    },
    {
      provider: "grok" as const,
      envRefId: "GROK_PROVIDER_REF",
      resolvedKey: "grok-provider-key",
    },
    {
      provider: "kimi" as const,
      envRefId: "KIMI_PROVIDER_REF",
      resolvedKey: "kimi-provider-key",
    },
    {
      provider: "perplexity" as const,
      envRefId: "PERPLEXITY_PROVIDER_REF",
      resolvedKey: "pplx-provider-key",
    },
  ])(
    "resolves configured provider SecretRef for $provider",
    async ({ provider, envRefId, resolvedKey }) => {
      const { metadata, resolvedConfig, context } = await runRuntimeWebTools({
        config: createProviderSecretRefConfig(provider, envRefId),
        env: {
          [envRefId]: resolvedKey,
        },
      });

      expect(metadata.search.providerConfigured).toBe(provider);
      expect(metadata.search.providerSource).toBe("configured");
      expect(metadata.search.selectedProvider).toBe(provider);
      expect(metadata.search.selectedProviderKeySource).toBe("secretRef");
      expect(readProviderKey(resolvedConfig, provider)).toBe(resolvedKey);
      expect(context.warnings.map((warning) => warning.code)).not.toContain(
        "WEB_SEARCH_KEY_UNRESOLVED_NO_FALLBACK",
      );
      if (provider === "perplexity") {
        expect(metadata.search.perplexityTransport).toBe("search_api");
      }
    },
  );

  it("auto-detects provider precedence across all configured providers", async () => {
    const { metadata, resolvedConfig, context } = await runRuntimeWebTools({
      config: asConfig({
        tools: {
          web: {
            search: {
              enabled: true,
            },
          },
        },
        plugins: {
          entries: {
            brave: {
              enabled: true,
              config: {
                webSearch: { apiKey: { source: "env", provider: "default", id: "BRAVE_REF" } },
              },
            },
            google: {
              enabled: true,
              config: {
                webSearch: { apiKey: { source: "env", provider: "default", id: "GEMINI_REF" } },
              },
            },
            xai: {
              enabled: true,
              config: {
                webSearch: { apiKey: { source: "env", provider: "default", id: "GROK_REF" } },
              },
            },
            moonshot: {
              enabled: true,
              config: {
                webSearch: { apiKey: { source: "env", provider: "default", id: "KIMI_REF" } },
              },
            },
            perplexity: {
              enabled: true,
              config: {
                webSearch: { apiKey: { source: "env", provider: "default", id: "PERPLEXITY_REF" } },
              },
            },
          },
        },
      }),
      env: {
        BRAVE_REF: "brave-precedence-key",
        GEMINI_REF: "gemini-precedence-key",
        GROK_REF: "grok-precedence-key",
        KIMI_REF: "kimi-precedence-key",
        PERPLEXITY_REF: "pplx-precedence-key",
      },
    });

    expect(metadata.search.providerSource).toBe("auto-detect");
    expect(metadata.search.selectedProvider).toBe("brave");
    expect(readProviderKey(resolvedConfig, "brave")).toBe("brave-precedence-key");
    expect(context.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "plugins.entries.google.config.webSearch.apiKey" }),
        expect.objectContaining({ path: "plugins.entries.xai.config.webSearch.apiKey" }),
        expect.objectContaining({ path: "plugins.entries.moonshot.config.webSearch.apiKey" }),
        expect.objectContaining({ path: "plugins.entries.perplexity.config.webSearch.apiKey" }),
      ]),
    );
  });

  it("auto-detects first available provider and keeps lower-priority refs inactive", async () => {
    const { metadata, resolvedConfig, context } = await runRuntimeWebTools({
      config: asConfig({
        tools: {
          web: {
            search: {
              enabled: true,
            },
          },
        },
        plugins: {
          entries: {
            brave: {
              enabled: true,
              config: {
                webSearch: {
                  apiKey: { source: "env", provider: "default", id: "BRAVE_API_KEY_REF" },
                },
              },
            },
            google: {
              enabled: true,
              config: {
                webSearch: {
                  apiKey: { source: "env", provider: "default", id: "MISSING_GEMINI_API_KEY_REF" },
                },
              },
            },
          },
        },
      }),
      env: {
        BRAVE_API_KEY_REF: "brave-runtime-key", // pragma: allowlist secret
      },
    });

    expect(metadata.search.providerSource).toBe("auto-detect");
    expect(metadata.search.selectedProvider).toBe("brave");
    expect(metadata.search.selectedProviderKeySource).toBe("secretRef");
    expect(readProviderKey(resolvedConfig, "brave")).toBe("brave-runtime-key");
    expect(readProviderKey(resolvedConfig, "gemini")).toEqual({
      source: "env",
      provider: "default",
      id: "MISSING_GEMINI_API_KEY_REF",
    });
    expect(context.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "SECRETS_REF_IGNORED_INACTIVE_SURFACE",
          path: "plugins.entries.google.config.webSearch.apiKey",
        }),
      ]),
    );
    expect(context.warnings.map((warning) => warning.code)).not.toContain(
      "WEB_SEARCH_KEY_UNRESOLVED_NO_FALLBACK",
    );
  });

  it("auto-detects the next provider when a higher-priority ref is unresolved", async () => {
    const { metadata, resolvedConfig, context } = await runRuntimeWebTools({
      config: asConfig({
        tools: {
          web: {
            search: {
              enabled: true,
            },
          },
        },
        plugins: {
          entries: {
            brave: {
              enabled: true,
              config: {
                webSearch: {
                  apiKey: { source: "env", provider: "default", id: "MISSING_BRAVE_API_KEY_REF" },
                },
              },
            },
            google: {
              enabled: true,
              config: {
                webSearch: {
                  apiKey: { source: "env", provider: "default", id: "GEMINI_API_KEY_REF" },
                },
              },
            },
          },
        },
      }),
      env: {
        GEMINI_API_KEY_REF: "gemini-runtime-key", // pragma: allowlist secret
      },
    });

    expect(metadata.search.providerSource).toBe("auto-detect");
    expect(metadata.search.selectedProvider).toBe("gemini");
    expect(readProviderKey(resolvedConfig, "gemini")).toBe("gemini-runtime-key");
    expect(context.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "SECRETS_REF_IGNORED_INACTIVE_SURFACE",
          path: "plugins.entries.brave.config.webSearch.apiKey",
        }),
      ]),
    );
    expect(context.warnings.map((warning) => warning.code)).not.toContain(
      "WEB_SEARCH_KEY_UNRESOLVED_NO_FALLBACK",
    );
  });

  it("warns when provider is invalid and falls back to auto-detect", async () => {
    const { metadata, resolvedConfig, context } = await runRuntimeWebTools({
      config: asConfig({
        tools: {
          web: {
            search: {
              provider: "invalid-provider",
            },
          },
        },
        plugins: {
          entries: {
            google: {
              enabled: true,
              config: {
                webSearch: {
                  apiKey: { source: "env", provider: "default", id: "GEMINI_API_KEY_REF" },
                },
              },
            },
          },
        },
      }),
      env: {
        GEMINI_API_KEY_REF: "gemini-runtime-key", // pragma: allowlist secret
      },
    });

    expect(metadata.search.providerConfigured).toBeUndefined();
    expect(metadata.search.providerSource).toBe("auto-detect");
    expect(metadata.search.selectedProvider).toBe("gemini");
    expect(readProviderKey(resolvedConfig, "gemini")).toBe("gemini-runtime-key");
    expect(metadata.search.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "WEB_SEARCH_PROVIDER_INVALID_AUTODETECT",
          path: "tools.web.search.provider",
        }),
      ]),
    );
    expect(context.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "WEB_SEARCH_PROVIDER_INVALID_AUTODETECT",
          path: "tools.web.search.provider",
        }),
      ]),
    );
  });

  it("fails fast when configured provider ref is unresolved with no fallback", async () => {
    const sourceConfig = asConfig({
      tools: {
        web: {
          search: {
            provider: "gemini",
          },
        },
      },
      plugins: {
        entries: {
          google: {
            enabled: true,
            config: {
              webSearch: {
                apiKey: { source: "env", provider: "default", id: "MISSING_GEMINI_API_KEY_REF" },
              },
            },
          },
        },
      },
    });
    const resolvedConfig = structuredClone(sourceConfig);
    const context = createResolverContext({
      sourceConfig,
      env: {},
    });

    await expect(
      resolveRuntimeWebTools({
        sourceConfig,
        resolvedConfig,
        context,
      }),
    ).rejects.toThrow("[WEB_SEARCH_KEY_UNRESOLVED_NO_FALLBACK]");
    expect(context.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "WEB_SEARCH_KEY_UNRESOLVED_NO_FALLBACK",
          path: "plugins.entries.google.config.webSearch.apiKey",
        }),
      ]),
    );
  });

  it("does not resolve Firecrawl SecretRef when Firecrawl is inactive", async () => {
    const resolveSpy = vi.spyOn(secretResolve, "resolveSecretRefValues");
    const { metadata, context } = await runRuntimeWebTools({
      config: asConfig({
        tools: {
          web: {
            fetch: {
              enabled: false,
              firecrawl: {
                apiKey: { source: "env", provider: "default", id: "MISSING_FIRECRAWL_REF" },
              },
            },
          },
        },
      }),
    });

    expectInactiveFirecrawlSecretRef({ resolveSpy, metadata, context });
  });

  it("does not resolve Firecrawl SecretRef when Firecrawl is disabled", async () => {
    const resolveSpy = vi.spyOn(secretResolve, "resolveSecretRefValues");
    const { metadata, context } = await runRuntimeWebTools({
      config: asConfig({
        tools: {
          web: {
            fetch: {
              enabled: true,
              firecrawl: {
                enabled: false,
                apiKey: { source: "env", provider: "default", id: "MISSING_FIRECRAWL_REF" },
              },
            },
          },
        },
      }),
    });

    expectInactiveFirecrawlSecretRef({ resolveSpy, metadata, context });
  });

  it("uses env fallback for unresolved Firecrawl SecretRef when active", async () => {
    const { metadata, resolvedConfig, context } = await runRuntimeWebTools({
      config: asConfig({
        tools: {
          web: {
            fetch: {
              firecrawl: {
                apiKey: { source: "env", provider: "default", id: "MISSING_FIRECRAWL_REF" },
              },
            },
          },
        },
      }),
      env: {
        FIRECRAWL_API_KEY: "firecrawl-fallback-key", // pragma: allowlist secret
      },
    });

    expect(metadata.fetch.firecrawl.active).toBe(true);
    expect(metadata.fetch.firecrawl.apiKeySource).toBe("env");
    expect(resolvedConfig.tools?.web?.fetch?.firecrawl?.apiKey).toBe("firecrawl-fallback-key");
    expect(context.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "WEB_FETCH_FIRECRAWL_KEY_UNRESOLVED_FALLBACK_USED",
          path: "tools.web.fetch.firecrawl.apiKey",
        }),
      ]),
    );
  });

  it("fails fast when active Firecrawl SecretRef is unresolved with no fallback", async () => {
    const sourceConfig = asConfig({
      tools: {
        web: {
          fetch: {
            firecrawl: {
              apiKey: { source: "env", provider: "default", id: "MISSING_FIRECRAWL_REF" },
            },
          },
        },
      },
    });
    const resolvedConfig = structuredClone(sourceConfig);
    const context = createResolverContext({
      sourceConfig,
      env: {},
    });

    await expect(
      resolveRuntimeWebTools({
        sourceConfig,
        resolvedConfig,
        context,
      }),
    ).rejects.toThrow("[WEB_FETCH_FIRECRAWL_KEY_UNRESOLVED_NO_FALLBACK]");
    expect(context.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "WEB_FETCH_FIRECRAWL_KEY_UNRESOLVED_NO_FALLBACK",
          path: "tools.web.fetch.firecrawl.apiKey",
        }),
      ]),
    );
  });
});
