import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { PluginWebFetchProviderEntry } from "../plugins/types.js";
import type { RuntimeWebFetchMetadata } from "../secrets/runtime-web-tools.types.js";

type TestPluginWebFetchConfig = {
  webFetch?: {
    apiKey?: unknown;
  };
};

const { resolveBundledPluginWebFetchProvidersMock, resolveRuntimeWebFetchProvidersMock } =
  vi.hoisted(() => ({
    resolveBundledPluginWebFetchProvidersMock: vi.fn<() => PluginWebFetchProviderEntry[]>(() => []),
    resolveRuntimeWebFetchProvidersMock: vi.fn<() => PluginWebFetchProviderEntry[]>(() => []),
  }));

vi.mock("../plugins/web-fetch-providers.js", () => ({
  resolveBundledPluginWebFetchProviders: resolveBundledPluginWebFetchProvidersMock,
}));

vi.mock("../plugins/web-fetch-providers.runtime.js", () => ({
  resolvePluginWebFetchProviders: resolveRuntimeWebFetchProvidersMock,
  resolveRuntimeWebFetchProviders: resolveRuntimeWebFetchProvidersMock,
}));

function createProvider(params: {
  pluginId: string;
  id: string;
  credentialPath: string;
  autoDetectOrder?: number;
  requiresCredential?: boolean;
  getCredentialValue?: PluginWebFetchProviderEntry["getCredentialValue"];
  getConfiguredCredentialValue?: PluginWebFetchProviderEntry["getConfiguredCredentialValue"];
  createTool?: PluginWebFetchProviderEntry["createTool"];
}): PluginWebFetchProviderEntry {
  return {
    pluginId: params.pluginId,
    id: params.id,
    label: params.id,
    hint: `${params.id} runtime provider`,
    envVars: [`${params.id.toUpperCase()}_API_KEY`],
    placeholder: `${params.id}-...`,
    signupUrl: `https://example.com/${params.id}`,
    credentialPath: params.credentialPath,
    autoDetectOrder: params.autoDetectOrder,
    requiresCredential: params.requiresCredential,
    getCredentialValue: params.getCredentialValue ?? (() => undefined),
    setCredentialValue: () => {},
    getConfiguredCredentialValue: params.getConfiguredCredentialValue,
    createTool:
      params.createTool ??
      (() => ({
        description: params.id,
        parameters: {},
        execute: async (args) => ({ ...args, provider: params.id }),
      })),
  };
}

describe("web fetch runtime", () => {
  let resolveWebFetchDefinition: typeof import("./runtime.js").resolveWebFetchDefinition;
  let clearSecretsRuntimeSnapshot: typeof import("../secrets/runtime.js").clearSecretsRuntimeSnapshot;

  beforeAll(async () => {
    ({ resolveWebFetchDefinition } = await import("./runtime.js"));
    ({ clearSecretsRuntimeSnapshot } = await import("../secrets/runtime.js"));
  });

  beforeEach(() => {
    resolveBundledPluginWebFetchProvidersMock.mockReset();
    resolveRuntimeWebFetchProvidersMock.mockReset();
    resolveBundledPluginWebFetchProvidersMock.mockReturnValue([]);
    resolveRuntimeWebFetchProvidersMock.mockReturnValue([]);
  });

  afterEach(() => {
    clearSecretsRuntimeSnapshot();
  });

  it("auto-detects providers from plugin-owned env SecretRefs without runtime metadata", () => {
    const provider = createProvider({
      pluginId: "firecrawl",
      id: "firecrawl",
      credentialPath: "plugins.entries.firecrawl.config.webFetch.apiKey",
      autoDetectOrder: 1,
      getConfiguredCredentialValue: (config) => {
        const pluginConfig = config?.plugins?.entries?.firecrawl?.config as
          | TestPluginWebFetchConfig
          | undefined;
        return pluginConfig?.webFetch?.apiKey;
      },
    });
    resolveBundledPluginWebFetchProvidersMock.mockReturnValue([provider]);

    const config: OpenClawConfig = {
      plugins: {
        entries: {
          firecrawl: {
            enabled: true,
            config: {
              webFetch: {
                apiKey: {
                  source: "env",
                  provider: "default",
                  id: "AWS_SECRET_ACCESS_KEY",
                },
              },
            },
          },
        },
      },
    };

    const resolved = resolveWebFetchDefinition({ config });

    expect(resolved?.provider.id).toBe("firecrawl");
  });

  it("prefers the runtime-selected provider when metadata is available", async () => {
    const provider = createProvider({
      pluginId: "firecrawl",
      id: "firecrawl",
      credentialPath: "plugins.entries.firecrawl.config.webFetch.apiKey",
      autoDetectOrder: 1,
      createTool: ({ runtimeMetadata }) => ({
        description: "firecrawl",
        parameters: {},
        execute: async (args) => ({
          ...args,
          provider: runtimeMetadata?.selectedProvider ?? "firecrawl",
        }),
      }),
    });
    resolveBundledPluginWebFetchProvidersMock.mockReturnValue([provider]);
    resolveRuntimeWebFetchProvidersMock.mockReturnValue([provider]);

    const runtimeWebFetch: RuntimeWebFetchMetadata = {
      providerSource: "auto-detect",
      selectedProvider: "firecrawl",
      selectedProviderKeySource: "env",
      diagnostics: [],
    };

    const resolved = resolveWebFetchDefinition({
      config: {},
      runtimeWebFetch,
      preferRuntimeProviders: true,
    });

    expect(resolved?.provider.id).toBe("firecrawl");
    await expect(
      resolved?.definition.execute({
        url: "https://example.com",
        extractMode: "markdown",
        maxChars: 1000,
      }),
    ).resolves.toEqual({
      url: "https://example.com",
      extractMode: "markdown",
      maxChars: 1000,
      provider: "firecrawl",
    });
  });

  it("auto-detects providers from provider-declared env vars", () => {
    const provider = createProvider({
      pluginId: "firecrawl",
      id: "firecrawl",
      credentialPath: "plugins.entries.firecrawl.config.webFetch.apiKey",
      autoDetectOrder: 1,
    });
    resolveBundledPluginWebFetchProvidersMock.mockReturnValue([provider]);
    vi.stubEnv("FIRECRAWL_API_KEY", "firecrawl-env-key");

    const resolved = resolveWebFetchDefinition({
      config: {},
    });

    expect(resolved?.provider.id).toBe("firecrawl");
  });

  it("falls back to auto-detect when the configured provider is invalid", () => {
    const provider = createProvider({
      pluginId: "firecrawl",
      id: "firecrawl",
      credentialPath: "plugins.entries.firecrawl.config.webFetch.apiKey",
      autoDetectOrder: 1,
      getConfiguredCredentialValue: () => "firecrawl-key",
    });
    resolveBundledPluginWebFetchProvidersMock.mockReturnValue([provider]);

    const resolved = resolveWebFetchDefinition({
      config: {
        tools: {
          web: {
            fetch: {
              provider: "does-not-exist",
            },
          },
        },
      } as OpenClawConfig,
    });

    expect(resolved?.provider.id).toBe("firecrawl");
  });

  it("keeps sandboxed web fetch on bundled providers even when runtime providers are preferred", () => {
    const bundled = createProvider({
      pluginId: "firecrawl",
      id: "firecrawl",
      credentialPath: "plugins.entries.firecrawl.config.webFetch.apiKey",
      autoDetectOrder: 1,
      getConfiguredCredentialValue: () => "bundled-key",
    });
    const runtimeOnly = createProvider({
      pluginId: "third-party-fetch",
      id: "thirdparty",
      credentialPath: "plugins.entries.third-party-fetch.config.webFetch.apiKey",
      autoDetectOrder: 0,
      getConfiguredCredentialValue: () => "runtime-key",
    });
    resolveBundledPluginWebFetchProvidersMock.mockReturnValue([bundled]);
    resolveRuntimeWebFetchProvidersMock.mockReturnValue([runtimeOnly]);

    const resolved = resolveWebFetchDefinition({
      config: {},
      sandboxed: true,
      preferRuntimeProviders: true,
    });

    expect(resolved?.provider.id).toBe("firecrawl");
  });

  it("keeps non-sandboxed web fetch on bundled providers even when runtime providers are preferred", () => {
    const bundled = createProvider({
      pluginId: "firecrawl",
      id: "firecrawl",
      credentialPath: "plugins.entries.firecrawl.config.webFetch.apiKey",
      autoDetectOrder: 1,
      getConfiguredCredentialValue: () => "bundled-key",
    });
    const runtimeOnly = createProvider({
      pluginId: "third-party-fetch",
      id: "thirdparty",
      credentialPath: "plugins.entries.third-party-fetch.config.webFetch.apiKey",
      autoDetectOrder: 0,
      getConfiguredCredentialValue: () => "runtime-key",
    });
    resolveBundledPluginWebFetchProvidersMock.mockReturnValue([bundled]);
    resolveRuntimeWebFetchProvidersMock.mockReturnValue([runtimeOnly]);

    const resolved = resolveWebFetchDefinition({
      config: {},
      sandboxed: false,
      preferRuntimeProviders: true,
    });

    expect(resolved?.provider.id).toBe("firecrawl");
  });
});
