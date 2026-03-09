import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import * as secretResolve from "./resolve.js";
import { createResolverContext } from "./runtime-shared.js";
import { resolveRuntimeWebTools } from "./runtime-web-tools.js";

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

describe("runtime web tools resolution", () => {
  afterEach(() => {
    vi.restoreAllMocks();
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
        BRAVE_API_KEY_REF: "brave-runtime-key",
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
        GEMINI_API_KEY_REF: "gemini-runtime-key",
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

    expect(resolveSpy).not.toHaveBeenCalled();
    expect(metadata.fetch.firecrawl.active).toBe(false);
    expect(metadata.fetch.firecrawl.apiKeySource).toBe("secretRef");
    expect(context.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "SECRETS_REF_IGNORED_INACTIVE_SURFACE",
          path: "tools.web.fetch.firecrawl.apiKey",
        }),
      ]),
    );
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
        FIRECRAWL_API_KEY: "firecrawl-fallback-key",
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
