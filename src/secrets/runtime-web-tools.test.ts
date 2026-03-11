import { afterEach, describe, expect, it, vi } from "vitest";
import * as authProfiles from "../agents/auth-profiles.js";
import type { OpenClawConfig } from "../config/config.js";
import * as secretResolve from "./resolve.js";
import { createResolverContext } from "./runtime-shared.js";
import { resolveRuntimeWebTools } from "./runtime-web-tools.js";

type ProviderUnderTest = "brave" | "gemini" | "grok" | "kimi" | "minimax" | "perplexity";

function asConfig(value: unknown): OpenClawConfig {
  return value as OpenClawConfig;
}

async function runRuntimeWebTools(params: {
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  loadAuthStore?: (
    agentDir?: string,
  ) => ReturnType<typeof authProfiles.loadAuthProfileStoreForSecretsRuntime>;
}) {
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
    loadAuthStore: params.loadAuthStore,
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
  if (provider === "minimax") {
    return config.tools?.web?.search?.minimax?.apiKey;
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

function readMinimaxBaseUrl(config: OpenClawConfig): string | undefined {
  const search = config.tools?.web?.search as Record<string, unknown> | undefined;
  const minimax =
    search && typeof search === "object"
      ? (search.minimax as Record<string, unknown> | undefined)
      : undefined;
  const value = minimax?.baseUrl;
  return typeof value === "string" ? value : undefined;
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
      provider: "minimax" as const,
      envRefId: "MINIMAX_PROVIDER_REF",
      resolvedKey: "minimax-provider-key",
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
              minimax: {
                apiKey: { source: "env", provider: "default", id: "MINIMAX_REF" },
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
        MINIMAX_REF: "minimax-precedence-key",
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
        expect.objectContaining({ path: "tools.web.search.minimax.apiKey" }),
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

  it("accepts MINIMAX_OAUTH_TOKEN as minimax credentials", async () => {
    const { metadata, resolvedConfig, context } = await runRuntimeWebTools({
      config: asConfig({
        tools: {
          web: {
            search: {
              provider: "minimax",
            },
          },
        },
      }),
      env: {
        MINIMAX_OAUTH_TOKEN: "minimax-oauth-token", // pragma: allowlist secret
      },
    });

    expect(metadata.search.providerConfigured).toBe("minimax");
    expect(metadata.search.providerSource).toBe("configured");
    expect(metadata.search.selectedProvider).toBe("minimax");
    expect(metadata.search.selectedProviderKeySource).toBe("env");
    expect(resolvedConfig.tools?.web?.search?.minimax?.apiKey).toBe("minimax-oauth-token");
    expect(context.warnings.map((warning) => warning.code)).not.toContain(
      "WEB_SEARCH_KEY_UNRESOLVED_NO_FALLBACK",
    );
  });

  it("prefers MINIMAX_OAUTH_TOKEN over MINIMAX_API_KEY when both are set", async () => {
    const { metadata, resolvedConfig, context } = await runRuntimeWebTools({
      config: asConfig({
        tools: {
          web: {
            search: {
              provider: "minimax",
            },
          },
        },
      }),
      env: {
        MINIMAX_API_KEY: "minimax-api-key", // pragma: allowlist secret
        MINIMAX_OAUTH_TOKEN: "minimax-oauth-token", // pragma: allowlist secret
      },
    });

    expect(metadata.search.providerConfigured).toBe("minimax");
    expect(metadata.search.providerSource).toBe("configured");
    expect(metadata.search.selectedProvider).toBe("minimax");
    expect(metadata.search.selectedProviderKeySource).toBe("env");
    expect(resolvedConfig.tools?.web?.search?.minimax?.apiKey).toBe("minimax-oauth-token");
    expect(context.warnings.map((warning) => warning.code)).not.toContain(
      "WEB_SEARCH_KEY_UNRESOLVED_NO_FALLBACK",
    );
  });

  it("resolves MINIMAX_API_HOST from runtime env snapshot", async () => {
    const { metadata, resolvedConfig } = await runRuntimeWebTools({
      config: asConfig({
        tools: {
          web: {
            search: {
              provider: "minimax",
            },
          },
        },
      }),
      env: {
        MINIMAX_OAUTH_TOKEN: "minimax-oauth-token", // pragma: allowlist secret
        MINIMAX_API_HOST: "https://api.minimaxi.com/anthropic",
      },
    });

    expect(metadata.search.minimaxApiHost).toBe("https://api.minimaxi.com");
    expect(readMinimaxBaseUrl(resolvedConfig)).toBe("https://api.minimaxi.com");
  });

  it("auto-detects minimax using auth profile oauth when env/config keys are missing", async () => {
    vi.spyOn(authProfiles, "loadAuthProfileStoreForSecretsRuntime").mockReturnValue({
      version: 1,
      profiles: {
        "minimax-cn:default": {
          type: "oauth",
          provider: "minimax-cn",
          access: "profile-oauth-token", // pragma: allowlist secret
          refresh: "refresh-token", // pragma: allowlist secret
          expires: Date.now() + 60_000,
        },
      },
      order: {},
    } as unknown as ReturnType<typeof authProfiles.loadAuthProfileStoreForSecretsRuntime>);
    vi.spyOn(authProfiles, "listProfilesForProvider").mockImplementation((store, provider) =>
      provider === "minimax-cn" ? ["minimax-cn:default"] : [],
    );

    const { metadata, resolvedConfig } = await runRuntimeWebTools({
      config: asConfig({
        tools: {
          web: {
            search: {
              enabled: true,
            },
          },
        },
      }),
      env: {},
    });

    expect(metadata.search.providerSource).toBe("auto-detect");
    expect(metadata.search.selectedProvider).toBe("minimax");
    expect(metadata.search.selectedProviderKeySource).toBe("auth_profile");
    expect(resolvedConfig.tools?.web?.search?.minimax?.apiKey).toBe("profile-oauth-token");
    expect(readMinimaxBaseUrl(resolvedConfig)).toBe("https://api.minimaxi.com");
  });

  it("prefers configured minimax-portal baseUrl when auth profile fallback is minimax-portal", async () => {
    vi.spyOn(authProfiles, "loadAuthProfileStoreForSecretsRuntime").mockReturnValue({
      version: 1,
      profiles: {
        "minimax-portal:default": {
          type: "oauth",
          provider: "minimax-portal",
          access: "profile-oauth-token", // pragma: allowlist secret
          refresh: "refresh-token", // pragma: allowlist secret
          expires: Date.now() + 60_000,
        },
      },
      order: {},
    } as unknown as ReturnType<typeof authProfiles.loadAuthProfileStoreForSecretsRuntime>);
    vi.spyOn(authProfiles, "listProfilesForProvider").mockImplementation((store, provider) =>
      provider === "minimax-portal" ? ["minimax-portal:default"] : [],
    );

    const { metadata, resolvedConfig } = await runRuntimeWebTools({
      config: asConfig({
        tools: {
          web: {
            search: {
              enabled: true,
            },
          },
        },
        models: {
          providers: {
            "minimax-portal": {
              baseUrl: "https://api.minimaxi.com/anthropic",
            },
          },
        },
      }),
      env: {},
    });

    expect(metadata.search.providerSource).toBe("auto-detect");
    expect(metadata.search.selectedProvider).toBe("minimax");
    expect(metadata.search.selectedProviderKeySource).toBe("auth_profile");
    expect(resolvedConfig.tools?.web?.search?.minimax?.apiKey).toBe("profile-oauth-token");
    expect(readMinimaxBaseUrl(resolvedConfig)).toBe("https://api.minimaxi.com");
  });

  it("keeps auth-profile probing read-only by ignoring expired oauth credentials", async () => {
    const resolveApiKeySpy = vi.spyOn(authProfiles, "resolveApiKeyForProfile");
    vi.spyOn(authProfiles, "loadAuthProfileStoreForSecretsRuntime").mockReturnValue({
      version: 1,
      profiles: {
        "minimax:default": {
          type: "oauth",
          provider: "minimax",
          access: "expired-token", // pragma: allowlist secret
          refresh: "refresh-token", // pragma: allowlist secret
          expires: Date.now() - 60_000,
        },
      },
      order: {},
    } as unknown as ReturnType<typeof authProfiles.loadAuthProfileStoreForSecretsRuntime>);
    vi.spyOn(authProfiles, "listProfilesForProvider").mockImplementation((store, provider) =>
      provider === "minimax" ? ["minimax:default"] : [],
    );

    const { metadata, resolvedConfig } = await runRuntimeWebTools({
      config: asConfig({
        tools: {
          web: {
            search: {
              provider: "minimax",
            },
          },
        },
      }),
      env: {},
    });

    expect(metadata.search.selectedProvider).toBeUndefined();
    expect(resolvedConfig.tools?.web?.search?.minimax?.apiKey).toBeUndefined();
    expect(resolveApiKeySpy).not.toHaveBeenCalled();
  });

  it("uses injected auth-store loader for minimax auth-profile probing", async () => {
    vi.spyOn(authProfiles, "loadAuthProfileStoreForSecretsRuntime").mockReturnValue({
      version: 1,
      profiles: {},
      order: {},
    } as unknown as ReturnType<typeof authProfiles.loadAuthProfileStoreForSecretsRuntime>);

    const injectedStore = {
      version: 1,
      profiles: {
        "minimax:default": {
          type: "oauth",
          provider: "minimax",
          access: "injected-token", // pragma: allowlist secret
          refresh: "refresh-token", // pragma: allowlist secret
          expires: Date.now() + 60_000,
        },
      },
      order: {},
    } as unknown as ReturnType<typeof authProfiles.loadAuthProfileStoreForSecretsRuntime>;

    const loadAuthStore = vi.fn(() => injectedStore);
    vi.spyOn(authProfiles, "listProfilesForProvider").mockImplementation((store, provider) =>
      provider === "minimax" ? ["minimax:default"] : [],
    );

    const { metadata, resolvedConfig } = await runRuntimeWebTools({
      config: asConfig({
        tools: {
          web: {
            search: {
              provider: "minimax",
            },
          },
        },
      }),
      env: {},
      loadAuthStore,
    });

    expect(loadAuthStore).toHaveBeenCalledWith(undefined);
    expect(metadata.search.selectedProvider).toBe("minimax");
    expect(metadata.search.selectedProviderKeySource).toBe("auth_profile");
    expect(resolvedConfig.tools?.web?.search?.minimax?.apiKey).toBe("injected-token");
  });

  it("treats configured provider as primary and falls back to next available provider", async () => {
    const { metadata, resolvedConfig } = await runRuntimeWebTools({
      config: asConfig({
        tools: {
          web: {
            search: {
              enabled: true,
              provider: "brave",
              minimax: {
                apiKey: "fallback-minimax-key", // pragma: allowlist secret
              },
            },
          },
        },
      }),
      env: {},
    });

    expect(metadata.search.providerConfigured).toBe("brave");
    expect(metadata.search.providerSource).toBe("configured");
    expect(metadata.search.selectedProvider).toBe("minimax");
    expect(metadata.search.selectedProviderKeySource).toBe("config");
    expect(resolvedConfig.tools?.web?.search?.minimax?.apiKey).toBe("fallback-minimax-key");
    expect(metadata.search.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "WEB_SEARCH_AUTODETECT_SELECTED",
          path: "tools.web.search.provider",
        }),
      ]),
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
