import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import * as secretResolve from "./resolve.js";
import { createResolverContext } from "./runtime-shared.js";
import { resolveRuntimeWebTools } from "./runtime-web-tools.js";

type ProviderUnderTest = "brave" | "gemini" | "grok" | "kimi" | "perplexity";

function asConfig(value: unknown): OpenClawConfig {
  return value as OpenClawConfig;
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
  const search: Record<string, unknown> = {
    enabled: true,
    provider,
  };
  if (provider === "brave") {
    search.apiKey = { source: "env", provider: "default", id: envRefId };
  } else {
    search[provider] = {
      apiKey: { source: "env", provider: "default", id: envRefId },
    };
  }
  return asConfig({
    tools: {
      web: {
        search,
      },
    },
  });
}

function readProviderKey(config: OpenClawConfig, provider: ProviderUnderTest): unknown {
  if (provider === "brave") {
    return config.tools?.web?.search?.apiKey;
  }
  if (provider === "gemini") {
    return config.tools?.web?.search?.gemini?.apiKey;
  }
  if (provider === "grok") {
    return config.tools?.web?.search?.grok?.apiKey;
  }
  if (provider === "kimi") {
    return config.tools?.web?.search?.kimi?.apiKey;
  }
  return config.tools?.web?.search?.perplexity?.apiKey;
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
              apiKey: { source: "env", provider: "default", id: "BRAVE_REF" },
              gemini: {
                apiKey: { source: "env", provider: "default", id: "GEMINI_REF" },
              },
              grok: {
                apiKey: { source: "env", provider: "default", id: "GROK_REF" },
              },
              kimi: {
                apiKey: { source: "env", provider: "default", id: "KIMI_REF" },
              },
              perplexity: {
                apiKey: { source: "env", provider: "default", id: "PERPLEXITY_REF" },
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
    expect(resolvedConfig.tools?.web?.search?.apiKey).toBe("brave-precedence-key");
    expect(context.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "tools.web.search.gemini.apiKey" }),
        expect.objectContaining({ path: "tools.web.search.grok.apiKey" }),
        expect.objectContaining({ path: "tools.web.search.kimi.apiKey" }),
        expect.objectContaining({ path: "tools.web.search.perplexity.apiKey" }),
      ]),
    );
  });

  it("auto-detects first available provider and keeps lower-priority refs inactive", async () => {
    const { metadata, resolvedConfig, context } = await runRuntimeWebTools({
      config: asConfig({
        tools: {
          web: {
            search: {
              apiKey: { source: "env", provider: "default", id: "BRAVE_API_KEY_REF" },
              gemini: {
                apiKey: {
                  source: "env",
                  provider: "default",
                  id: "MISSING_GEMINI_API_KEY_REF",
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
    expect(resolvedConfig.tools?.web?.search?.apiKey).toBe("brave-runtime-key");
    expect(resolvedConfig.tools?.web?.search?.gemini?.apiKey).toEqual({
      source: "env",
      provider: "default",
      id: "MISSING_GEMINI_API_KEY_REF",
    });
    expect(context.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "SECRETS_REF_IGNORED_INACTIVE_SURFACE",
          path: "tools.web.search.gemini.apiKey",
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
              apiKey: { source: "env", provider: "default", id: "MISSING_BRAVE_API_KEY_REF" },
              gemini: {
                apiKey: { source: "env", provider: "default", id: "GEMINI_API_KEY_REF" },
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
    expect(resolvedConfig.tools?.web?.search?.gemini?.apiKey).toBe("gemini-runtime-key");
    expect(context.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "SECRETS_REF_IGNORED_INACTIVE_SURFACE",
          path: "tools.web.search.apiKey",
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
              gemini: {
                apiKey: { source: "env", provider: "default", id: "GEMINI_API_KEY_REF" },
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
    expect(resolvedConfig.tools?.web?.search?.gemini?.apiKey).toBe("gemini-runtime-key");
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
            gemini: {
              apiKey: { source: "env", provider: "default", id: "MISSING_GEMINI_API_KEY_REF" },
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
          path: "tools.web.search.gemini.apiKey",
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
