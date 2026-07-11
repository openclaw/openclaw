// Verifies web-search credential presence checks for plugins.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginManifestRecord } from "./manifest-registry.js";
import type { PluginWebSearchProviderEntry } from "./web-provider-types.js";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

type ManifestSnapshot = {
  plugins: Array<
    Pick<PluginManifestRecord, "id" | "origin" | "contracts" | "setup" | "providerAuthEnvVars">
  >;
};

type PublicWebSearchProvider = Pick<
  PluginWebSearchProviderEntry,
  "id" | "pluginId" | "authProviderId" | "getConfiguredCredentialFallback" | "requiresCredential"
> & { envVars?: string[] };

const agentScopeMocks = vi.hoisted(() => ({
  resolveDefaultAgentDir: vi.fn<() => string>(() => "/agent/default"),
}));
const authProfileMocks = vi.hoisted(() => ({
  hasAuthProfileForProvider: vi.fn<() => boolean>(() => false),
}));
const manifestMocks = vi.hoisted(() => ({
  loadManifestMetadataSnapshot: vi.fn<() => ManifestSnapshot>(() => ({ plugins: [] })),
}));
const publicArtifactMocks = vi.hoisted(() => ({
  resolveBundledExplicitWebSearchProvidersFromPublicArtifacts: vi.fn<
    () => PublicWebSearchProvider[]
  >(() => []),
}));

vi.mock("../agents/agent-scope-config.js", () => ({
  resolveDefaultAgentDir: agentScopeMocks.resolveDefaultAgentDir,
}));
vi.mock("../agents/tools/model-config.helpers.js", () => ({
  hasAuthProfileForProvider: authProfileMocks.hasAuthProfileForProvider,
}));
vi.mock("./manifest-contract-eligibility.js", () => ({
  loadManifestMetadataSnapshot: manifestMocks.loadManifestMetadataSnapshot,
}));
vi.mock("./web-provider-public-artifacts.explicit.js", () => ({
  resolveBundledExplicitWebSearchProvidersFromPublicArtifacts:
    publicArtifactMocks.resolveBundledExplicitWebSearchProvidersFromPublicArtifacts,
}));

let hasConfiguredWebSearchCredential: typeof import("./web-search-credential-presence.js").hasConfiguredWebSearchCredential;

beforeAll(async () => {
  ({ hasConfiguredWebSearchCredential } = await import("./web-search-credential-presence.js"));
});

describe("hasConfiguredWebSearchCredential", () => {
  beforeEach(() => {
    agentScopeMocks.resolveDefaultAgentDir.mockReturnValue("/agent/default");
    authProfileMocks.hasAuthProfileForProvider.mockReturnValue(false);
    manifestMocks.loadManifestMetadataSnapshot.mockReturnValue({ plugins: [] });
    publicArtifactMocks.resolveBundledExplicitWebSearchProvidersFromPublicArtifacts.mockReturnValue(
      [],
    );
  });

  it("does not statically import web-search runtime providers", () => {
    const source = fs.readFileSync(
      path.join(repoRoot, "src/plugins/web-search-credential-presence.ts"),
      "utf8",
    );

    expect(source).not.toMatch(/\bfrom\s+["'][^"']*web-search-providers\.runtime\.js["']/);
    expect(source).not.toMatch(/\bfrom\s+["'][^"']*loader\.js["']/);
  });

  it("keeps empty config and env on the manifest-only path", () => {
    expect(
      hasConfiguredWebSearchCredential({
        config: {} as OpenClawConfig,
        env: {},
        origin: "bundled",
      }),
    ).toBe(false);
  });

  it("detects configured web search credential candidates without runtime loading", () => {
    expect(
      hasConfiguredWebSearchCredential({
        config: {
          tools: { web: { search: { apiKey: "brave-key" } } },
        } as OpenClawConfig,
        env: {},
        origin: "bundled",
      }),
    ).toBe(true);
  });

  it("ignores provider selection and non-credential search options", () => {
    expect(
      hasConfiguredWebSearchCredential({
        config: {
          tools: {
            web: {
              search: {
                provider: "google",
                maxResults: 5,
                openaiCodex: { enabled: true },
                google: {
                  baseUrl: "https://search.example.test",
                  mode: "serp",
                },
              },
            },
          },
        } as OpenClawConfig,
        env: {},
        origin: "bundled",
      }),
    ).toBe(false);
  });

  it("requires env SecretRefs to resolve before reporting a configured credential", () => {
    const config = {
      tools: {
        web: {
          search: {
            apiKey: { source: "env", provider: "default", id: "BRAVE_API_KEY" },
          },
        },
      },
    } as OpenClawConfig;

    expect(
      hasConfiguredWebSearchCredential({
        config,
        env: {},
        origin: "bundled",
      }),
    ).toBe(false);

    expect(
      hasConfiguredWebSearchCredential({
        config,
        env: { BRAVE_API_KEY: "brave-key" },
        origin: "bundled",
      }),
    ).toBe(true);
  });

  it("requires legacy env SecretRef strings to resolve before reporting a credential", () => {
    expect(
      hasConfiguredWebSearchCredential({
        config: {
          tools: { web: { search: { apiKey: "${GOOGLE_SEARCH_API_KEY}" } } },
        } as OpenClawConfig,
        env: {},
        origin: "bundled",
      }),
    ).toBe(false);

    expect(
      hasConfiguredWebSearchCredential({
        config: {
          tools: { web: { search: { apiKey: "secretref-env:GOOGLE_SEARCH_API_KEY" } } },
        } as OpenClawConfig,
        env: { GOOGLE_SEARCH_API_KEY: "google-key" },
        origin: "bundled",
      }),
    ).toBe(true);
  });

  it("treats non-env SecretRefs and nested provider apiKeys as configured credentials", () => {
    manifestMocks.loadManifestMetadataSnapshot.mockReturnValue({
      plugins: [
        {
          id: "google",
          origin: "bundled",
          contracts: { webSearchProviders: ["google"] },
        },
      ],
    });

    expect(
      hasConfiguredWebSearchCredential({
        config: {
          tools: {
            web: {
              search: {
                google: {
                  apiKey: {
                    source: "file",
                    provider: "default",
                    id: "/run/secrets/google-search-key",
                  },
                },
              },
            },
          },
        } as OpenClawConfig,
        env: {},
        origin: "bundled",
      }),
    ).toBe(true);
  });

  it("checks plugin webSearch apiKey with the same SecretRef semantics", () => {
    const config = {
      plugins: {
        entries: {
          custom: {
            config: {
              webSearch: {
                apiKey: { source: "env", id: "CUSTOM_SEARCH_API_KEY" },
              },
            },
          },
        },
      },
    } as OpenClawConfig;

    expect(
      hasConfiguredWebSearchCredential({
        config,
        env: {},
        origin: "bundled",
      }),
    ).toBe(false);

    expect(
      hasConfiguredWebSearchCredential({
        config,
        env: { CUSTOM_SEARCH_API_KEY: "custom-key" },
        origin: "bundled",
      }),
    ).toBe(true);
  });

  it("checks plugin webSearch baseUrl credentials without treating top-level search baseUrl as a key", () => {
    expect(
      hasConfiguredWebSearchCredential({
        config: {
          tools: { web: { search: { baseUrl: "https://search.example.test" } } },
          plugins: {
            entries: {
              searxng: {
                config: {
                  webSearch: {
                    baseUrl: "https://searxng.example.test",
                  },
                },
              },
            },
          },
        } as OpenClawConfig,
        env: {},
        origin: "bundled",
      }),
    ).toBe(true);
  });

  it("keeps non-bundled plugin entry credentials when bundled manifest records exist", () => {
    manifestMocks.loadManifestMetadataSnapshot.mockReturnValue({
      plugins: [
        {
          id: "brave",
          origin: "bundled",
          contracts: { webSearchProviders: ["brave"] },
        },
        {
          id: "custom-search",
          origin: "global",
          contracts: { webSearchProviders: ["custom-search"] },
        },
      ],
    });

    expect(
      hasConfiguredWebSearchCredential({
        config: {
          plugins: {
            entries: {
              "custom-search": {
                config: {
                  webSearch: {
                    apiKey: "custom-search-key",
                  },
                },
              },
            },
          },
        } as OpenClawConfig,
        env: {},
        origin: "bundled",
      }),
    ).toBe(true);
  });

  it("keeps selected non-bundled provider plugin credentials under bundled audit scope", () => {
    manifestMocks.loadManifestMetadataSnapshot.mockReturnValue({
      plugins: [
        {
          id: "brave",
          origin: "bundled",
          contracts: { webSearchProviders: ["brave"] },
        },
        {
          id: "custom-search",
          origin: "global",
          contracts: { webSearchProviders: ["custom-search"] },
        },
        {
          id: "other-search",
          origin: "global",
          contracts: { webSearchProviders: ["other-search"] },
        },
      ],
    });

    expect(
      hasConfiguredWebSearchCredential({
        config: {
          tools: { web: { search: { provider: "custom-search" } } },
          plugins: {
            entries: {
              "other-search": {
                config: {
                  webSearch: {
                    apiKey: "other-search-key",
                  },
                },
              },
            },
          },
        } as OpenClawConfig,
        env: {},
        origin: "bundled",
      }),
    ).toBe(false);

    expect(
      hasConfiguredWebSearchCredential({
        config: {
          tools: { web: { search: { provider: "custom-search" } } },
          plugins: {
            entries: {
              "custom-search": {
                config: {
                  webSearch: {
                    apiKey: "custom-search-key",
                  },
                },
              },
            },
          },
        } as OpenClawConfig,
        env: {},
        origin: "bundled",
      }),
    ).toBe(true);
  });

  it("limits explicit provider checks to the selected provider", () => {
    manifestMocks.loadManifestMetadataSnapshot.mockReturnValue({
      plugins: [
        {
          id: "brave",
          origin: "bundled",
          contracts: { webSearchProviders: ["brave"] },
        },
        {
          id: "searxng",
          origin: "bundled",
          contracts: { webSearchProviders: ["searxng"] },
        },
        {
          id: "duckduckgo",
          origin: "bundled",
          contracts: { webSearchProviders: ["duckduckgo"] },
        },
      ],
    });
    publicArtifactMocks.resolveBundledExplicitWebSearchProvidersFromPublicArtifacts.mockReturnValue(
      [
        {
          id: "duckduckgo",
          pluginId: "duckduckgo",
          requiresCredential: false,
        },
      ],
    );
    const unrelatedSearxngConfig = {
      plugins: {
        entries: {
          searxng: {
            config: {
              webSearch: {
                baseUrl: "https://searxng.example.test",
              },
            },
          },
        },
      },
    } as OpenClawConfig;

    expect(
      hasConfiguredWebSearchCredential({
        config: {
          ...unrelatedSearxngConfig,
          tools: { web: { search: { provider: "brave" } } },
        } as OpenClawConfig,
        env: {},
        origin: "bundled",
      }),
    ).toBe(false);

    expect(
      hasConfiguredWebSearchCredential({
        config: {
          tools: {
            web: {
              search: {
                provider: "brave",
                searxng: {
                  apiKey: "searxng-key",
                },
              },
            },
          },
        } as OpenClawConfig,
        env: {},
        origin: "bundled",
      }),
    ).toBe(false);

    expect(
      hasConfiguredWebSearchCredential({
        config: unrelatedSearxngConfig,
        env: {},
        origin: "bundled",
      }),
    ).toBe(true);

    expect(
      hasConfiguredWebSearchCredential({
        config: {
          ...unrelatedSearxngConfig,
          tools: { web: { search: { provider: "duckduckgo" } } },
        } as OpenClawConfig,
        env: {},
        origin: "bundled",
      }),
    ).toBe(true);

    expect(
      hasConfiguredWebSearchCredential({
        config: {
          tools: { web: { search: { provider: "brave" } } },
          plugins: {
            entries: {
              brave: {
                config: {
                  webSearch: {
                    apiKey: "brave-key",
                  },
                },
              },
            },
          },
        } as OpenClawConfig,
        env: {},
        origin: "bundled",
      }),
    ).toBe(true);
  });

  it("treats explicit keyless web search providers as configured", () => {
    manifestMocks.loadManifestMetadataSnapshot.mockReturnValue({
      plugins: [
        {
          id: "duckduckgo",
          origin: "bundled",
          contracts: { webSearchProviders: ["duckduckgo"] },
        },
      ],
    });
    publicArtifactMocks.resolveBundledExplicitWebSearchProvidersFromPublicArtifacts.mockReturnValue(
      [
        {
          id: "duckduckgo",
          pluginId: "duckduckgo",
          requiresCredential: false,
        },
      ],
    );
    publicArtifactMocks.resolveBundledExplicitWebSearchProvidersFromPublicArtifacts.mockClear();

    expect(
      hasConfiguredWebSearchCredential({
        config: {
          tools: { web: { search: { provider: "duckduckgo" } } },
        } as OpenClawConfig,
        env: {},
        origin: "bundled",
      }),
    ).toBe(true);
    expect(
      publicArtifactMocks.resolveBundledExplicitWebSearchProvidersFromPublicArtifacts,
    ).toHaveBeenCalledWith({ onlyPluginIds: ["duckduckgo"] });
  });

  it("does not treat explicit keyless providers blocked by plugins.allow as configured", () => {
    manifestMocks.loadManifestMetadataSnapshot.mockReturnValue({
      plugins: [
        {
          id: "brave",
          origin: "bundled",
          contracts: { webSearchProviders: ["brave"] },
        },
        {
          id: "duckduckgo",
          origin: "bundled",
          contracts: { webSearchProviders: ["duckduckgo"] },
        },
      ],
    });
    publicArtifactMocks.resolveBundledExplicitWebSearchProvidersFromPublicArtifacts.mockReturnValue(
      [
        {
          id: "duckduckgo",
          pluginId: "duckduckgo",
          requiresCredential: false,
        },
      ],
    );
    publicArtifactMocks.resolveBundledExplicitWebSearchProvidersFromPublicArtifacts.mockClear();

    expect(
      hasConfiguredWebSearchCredential({
        config: {
          plugins: { allow: ["brave"] },
          tools: { web: { search: { provider: "duckduckgo" } } },
        } as OpenClawConfig,
        env: {},
        origin: "bundled",
      }),
    ).toBe(false);
    expect(
      publicArtifactMocks.resolveBundledExplicitWebSearchProvidersFromPublicArtifacts,
    ).not.toHaveBeenCalled();
  });

  it("honors bundled-discovery compat for allowlisted-out bundled providers", () => {
    manifestMocks.loadManifestMetadataSnapshot.mockReturnValue({
      plugins: [
        {
          id: "brave",
          origin: "bundled",
          contracts: { webSearchProviders: ["brave"] },
        },
        {
          id: "duckduckgo",
          origin: "bundled",
          contracts: { webSearchProviders: ["duckduckgo"] },
        },
      ],
    });
    publicArtifactMocks.resolveBundledExplicitWebSearchProvidersFromPublicArtifacts.mockReturnValue(
      [
        {
          id: "duckduckgo",
          pluginId: "duckduckgo",
          requiresCredential: false,
        },
      ],
    );
    publicArtifactMocks.resolveBundledExplicitWebSearchProvidersFromPublicArtifacts.mockClear();

    const restrictiveCompatPlugins = {
      allow: ["some-other-plugin"],
      bundledDiscovery: "compat",
    } satisfies NonNullable<OpenClawConfig["plugins"]>;

    expect(
      hasConfiguredWebSearchCredential({
        config: {
          plugins: restrictiveCompatPlugins,
          tools: { web: { search: { provider: "duckduckgo" } } },
        } as OpenClawConfig,
        env: {},
        origin: "bundled",
      }),
    ).toBe(true);
    expect(
      publicArtifactMocks.resolveBundledExplicitWebSearchProvidersFromPublicArtifacts,
    ).toHaveBeenCalledWith({ onlyPluginIds: ["duckduckgo"] });

    expect(
      hasConfiguredWebSearchCredential({
        config: {
          plugins: {
            ...restrictiveCompatPlugins,
            entries: {
              brave: {
                config: {
                  webSearch: {
                    apiKey: "brave-key",
                  },
                },
              },
            },
          },
        } as OpenClawConfig,
        env: {},
        origin: "bundled",
      }),
    ).toBe(true);
  });

  it("does not count ambient search apiKey when every known provider is blocked", () => {
    manifestMocks.loadManifestMetadataSnapshot.mockReturnValue({
      plugins: [
        {
          id: "brave",
          origin: "bundled",
          contracts: { webSearchProviders: ["brave"] },
        },
      ],
    });

    expect(
      hasConfiguredWebSearchCredential({
        config: {
          plugins: { allow: ["telegram"] },
          tools: { web: { search: { apiKey: "search-key" } } },
        } as OpenClawConfig,
        env: {},
        origin: "bundled",
      }),
    ).toBe(false);

    expect(
      hasConfiguredWebSearchCredential({
        config: {
          tools: {
            web: {
              search: {
                "missing-search": {
                  apiKey: "search-key",
                },
              },
            },
          },
        } as OpenClawConfig,
        env: {},
        origin: "bundled",
      }),
    ).toBe(false);
  });

  it("does not count manifest env credentials for denied web-search plugins", () => {
    manifestMocks.loadManifestMetadataSnapshot.mockReturnValue({
      plugins: [
        {
          id: "brave",
          origin: "bundled",
          contracts: { webSearchProviders: ["brave"] },
          setup: { providers: [{ id: "brave", envVars: ["BRAVE_API_KEY"] }] },
          providerAuthEnvVars: {},
        },
      ],
    });

    expect(
      hasConfiguredWebSearchCredential({
        config: { plugins: { deny: ["brave"] } } as OpenClawConfig,
        env: { BRAVE_API_KEY: "brave-key" },
        origin: "bundled",
      }),
    ).toBe(false);
  });

  it("keeps provider credentials when an allowed plugin still serves a shared provider", () => {
    manifestMocks.loadManifestMetadataSnapshot.mockReturnValue({
      plugins: [
        {
          id: "primary-search",
          origin: "bundled",
          contracts: { webSearchProviders: ["shared-search"] },
        },
        {
          id: "fallback-search",
          origin: "bundled",
          contracts: { webSearchProviders: ["shared-search"] },
        },
      ],
    });

    expect(
      hasConfiguredWebSearchCredential({
        config: {
          plugins: { deny: ["primary-search"] },
          tools: {
            web: {
              search: {
                provider: "shared-search",
                apiKey: "shared-key",
              },
            },
          },
        } as OpenClawConfig,
        env: {},
        origin: "bundled",
      }),
    ).toBe(true);
  });

  it("does not treat explicit credentialed provider selection as configured without a key", () => {
    manifestMocks.loadManifestMetadataSnapshot.mockReturnValue({
      plugins: [
        {
          id: "brave",
          origin: "bundled",
          contracts: { webSearchProviders: ["brave"] },
        },
      ],
    });
    publicArtifactMocks.resolveBundledExplicitWebSearchProvidersFromPublicArtifacts.mockReturnValue(
      [
        {
          id: "brave",
          pluginId: "brave",
          requiresCredential: true,
        },
      ],
    );

    expect(
      hasConfiguredWebSearchCredential({
        config: {
          tools: { web: { search: { provider: "brave" } } },
        } as OpenClawConfig,
        env: {},
        origin: "bundled",
      }),
    ).toBe(false);
  });

  it("treats selected auth-backed web search providers as configured", () => {
    manifestMocks.loadManifestMetadataSnapshot.mockReturnValue({
      plugins: [
        {
          id: "xai",
          origin: "bundled",
          contracts: { webSearchProviders: ["grok"] },
        },
      ],
    });
    publicArtifactMocks.resolveBundledExplicitWebSearchProvidersFromPublicArtifacts.mockReturnValue(
      [
        {
          id: "grok",
          pluginId: "xai",
          authProviderId: "xai",
          requiresCredential: true,
        },
      ],
    );
    const config = {
      tools: { web: { search: { provider: "grok" } } },
    } as OpenClawConfig;

    expect(
      hasConfiguredWebSearchCredential({
        config,
        env: {},
        origin: "bundled",
      }),
    ).toBe(false);

    authProfileMocks.hasAuthProfileForProvider.mockReturnValue(true);

    expect(
      hasConfiguredWebSearchCredential({
        config,
        env: {},
        origin: "bundled",
      }),
    ).toBe(true);
    expect(authProfileMocks.hasAuthProfileForProvider).toHaveBeenLastCalledWith({
      provider: "xai",
      agentDir: "/agent/default",
    });
  });

  it("treats auth-backed provider profiles as auto-detect credentials", () => {
    manifestMocks.loadManifestMetadataSnapshot.mockReturnValue({
      plugins: [
        {
          id: "xai",
          origin: "bundled",
          contracts: { webSearchProviders: ["grok"] },
        },
      ],
    });
    publicArtifactMocks.resolveBundledExplicitWebSearchProvidersFromPublicArtifacts.mockReturnValue(
      [
        {
          id: "grok",
          pluginId: "xai",
          authProviderId: "xai",
          requiresCredential: true,
        },
      ],
    );
    authProfileMocks.hasAuthProfileForProvider.mockReturnValue(true);

    expect(
      hasConfiguredWebSearchCredential({
        config: {} as OpenClawConfig,
        env: {},
        origin: "bundled",
      }),
    ).toBe(true);
  });

  it("treats provider configured credential fallbacks as configured", () => {
    manifestMocks.loadManifestMetadataSnapshot.mockReturnValue({
      plugins: [
        {
          id: "firecrawl",
          origin: "bundled",
          contracts: { webSearchProviders: ["firecrawl"] },
        },
      ],
    });
    publicArtifactMocks.resolveBundledExplicitWebSearchProvidersFromPublicArtifacts.mockReturnValue(
      [
        {
          id: "firecrawl",
          pluginId: "firecrawl",
          requiresCredential: true,
          getConfiguredCredentialFallback: (config) => {
            const firecrawlConfig = config?.plugins?.entries?.firecrawl?.config as
              | { webFetch?: { apiKey?: unknown } }
              | undefined;
            const apiKey = firecrawlConfig?.webFetch?.apiKey;
            return apiKey === undefined
              ? undefined
              : {
                  path: "plugins.entries.firecrawl.config.webFetch.apiKey",
                  value: apiKey,
                };
          },
        },
      ],
    );

    expect(
      hasConfiguredWebSearchCredential({
        config: {
          plugins: {
            entries: {
              firecrawl: {
                config: {
                  webFetch: {
                    apiKey: "firecrawl-key",
                  },
                },
              },
            },
          },
        } as OpenClawConfig,
        env: {},
        origin: "bundled",
      }),
    ).toBe(true);
  });

  it("does not treat unknown explicit provider selection or credentials as configured", () => {
    manifestMocks.loadManifestMetadataSnapshot.mockReturnValue({
      plugins: [
        {
          id: "duckduckgo",
          origin: "bundled",
          contracts: { webSearchProviders: ["duckduckgo"] },
        },
      ],
    });
    publicArtifactMocks.resolveBundledExplicitWebSearchProvidersFromPublicArtifacts.mockReturnValue(
      [
        {
          id: "duckduckgo",
          pluginId: "duckduckgo",
          requiresCredential: false,
        },
      ],
    );

    expect(
      hasConfiguredWebSearchCredential({
        config: {
          tools: { web: { search: { provider: "missing-search" } } },
        } as OpenClawConfig,
        env: {},
        origin: "bundled",
      }),
    ).toBe(false);

    expect(
      hasConfiguredWebSearchCredential({
        config: {
          tools: {
            web: {
              search: {
                provider: "missing-search",
                apiKey: "search-key",
              },
            },
          },
        } as OpenClawConfig,
        env: {},
        origin: "bundled",
      }),
    ).toBe(false);

    expect(
      hasConfiguredWebSearchCredential({
        config: {
          tools: {
            web: {
              search: {
                provider: "missing-search",
                "missing-search": {
                  apiKey: "search-key",
                },
              },
            },
          },
        } as OpenClawConfig,
        env: {},
        origin: "bundled",
      }),
    ).toBe(false);
  });

  it("does not count credentials on explicitly disabled web-search plugins", () => {
    manifestMocks.loadManifestMetadataSnapshot.mockReturnValue({
      plugins: [
        {
          id: "searxng",
          origin: "bundled",
          contracts: { webSearchProviders: ["searxng"] },
        },
      ],
    });

    expect(
      hasConfiguredWebSearchCredential({
        config: {
          plugins: {
            entries: {
              searxng: {
                enabled: false,
                config: {
                  webSearch: {
                    baseUrl: "https://searxng.example.test",
                  },
                },
              },
            },
          },
        } as OpenClawConfig,
        env: {},
        origin: "bundled",
      }),
    ).toBe(false);
  });

  it("applies disabled plugin entries through canonical plugin ids", () => {
    manifestMocks.loadManifestMetadataSnapshot.mockReturnValue({
      plugins: [
        {
          id: "google",
          origin: "bundled",
          contracts: { webSearchProviders: ["google"] },
        },
      ],
    });

    expect(
      hasConfiguredWebSearchCredential({
        config: {
          plugins: {
            entries: {
              "google-gemini-cli": {
                enabled: false,
                config: {
                  webSearch: {
                    apiKey: "google-key",
                  },
                },
              },
            },
          },
        } as OpenClawConfig,
        env: {},
        origin: "bundled",
      }),
    ).toBe(false);
  });

  it("does not throw when explicit provider public artifact loading fails", () => {
    manifestMocks.loadManifestMetadataSnapshot.mockReturnValue({
      plugins: [
        {
          id: "duckduckgo",
          origin: "bundled",
          contracts: { webSearchProviders: ["duckduckgo"] },
        },
      ],
    });
    publicArtifactMocks.resolveBundledExplicitWebSearchProvidersFromPublicArtifacts.mockImplementation(
      () => {
        throw new Error("artifact unavailable");
      },
    );

    expect(
      hasConfiguredWebSearchCredential({
        config: {
          tools: { web: { search: { provider: "duckduckgo" } } },
        } as OpenClawConfig,
        env: {},
        origin: "bundled",
      }),
    ).toBe(false);
  });

  it("treats manifest env var values as resolved literal credentials", () => {
    manifestMocks.loadManifestMetadataSnapshot.mockReturnValue({
      plugins: [
        {
          id: "brave",
          origin: "bundled",
          contracts: { webSearchProviders: ["brave"] },
          setup: { providers: [{ id: "brave", envVars: ["BRAVE_API_KEY"] }] },
          providerAuthEnvVars: {},
        },
      ],
    });

    expect(
      hasConfiguredWebSearchCredential({
        config: {} as OpenClawConfig,
        env: { BRAVE_API_KEY: "$BRAVE_API_KEY" },
        origin: "bundled",
      }),
    ).toBe(true);
  });

  it("scopes manifest env credentials to the selected web-search provider contract", () => {
    manifestMocks.loadManifestMetadataSnapshot.mockReturnValue({
      plugins: [
        {
          id: "google",
          origin: "bundled",
          contracts: { webSearchProviders: ["gemini"] },
          setup: {
            providers: [
              { id: "google-vertex", envVars: ["GOOGLE_CLOUD_API_KEY"] },
              { id: "google", envVars: ["GEMINI_API_KEY", "GOOGLE_API_KEY"] },
            ],
          },
          providerAuthEnvVars: {},
        },
      ],
    });
    publicArtifactMocks.resolveBundledExplicitWebSearchProvidersFromPublicArtifacts.mockReturnValue(
      [
        {
          id: "gemini",
          pluginId: "google",
          requiresCredential: true,
          envVars: ["GEMINI_API_KEY"],
        },
      ],
    );

    const config = {
      tools: { web: { search: { provider: "gemini" } } },
    } as OpenClawConfig;

    expect(
      hasConfiguredWebSearchCredential({
        config,
        env: { GOOGLE_CLOUD_API_KEY: "vertex-key" },
        origin: "bundled",
      }),
    ).toBe(false);

    expect(
      hasConfiguredWebSearchCredential({
        config,
        env: { GEMINI_API_KEY: "gemini-key" },
        origin: "bundled",
      }),
    ).toBe(true);
  });

  it("does not count manifest env credentials when plugins are globally disabled", () => {
    manifestMocks.loadManifestMetadataSnapshot.mockReturnValue({
      plugins: [
        {
          id: "brave",
          origin: "bundled",
          contracts: { webSearchProviders: ["brave"] },
          setup: { providers: [{ id: "brave", envVars: ["BRAVE_API_KEY"] }] },
          providerAuthEnvVars: {},
        },
      ],
    });

    expect(
      hasConfiguredWebSearchCredential({
        config: { plugins: { enabled: false } } as OpenClawConfig,
        env: { BRAVE_API_KEY: "brave-key" },
        origin: "bundled",
      }),
    ).toBe(false);
  });

  it("does not count non-bundled manifest env credentials when plugins are globally disabled", () => {
    manifestMocks.loadManifestMetadataSnapshot.mockReturnValue({
      plugins: [
        {
          id: "custom-search",
          origin: "global",
          contracts: { webSearchProviders: ["custom-search"] },
          setup: { providers: [{ id: "custom-search", envVars: ["CUSTOM_SEARCH_API_KEY"] }] },
          providerAuthEnvVars: {},
        },
      ],
    });

    expect(
      hasConfiguredWebSearchCredential({
        config: { plugins: { enabled: false } } as OpenClawConfig,
        env: { CUSTOM_SEARCH_API_KEY: "custom-key" },
        origin: "global",
      }),
    ).toBe(false);
  });

  it("keeps literal search credentials when non-bundled manifest scope is empty", () => {
    expect(
      hasConfiguredWebSearchCredential({
        config: { tools: { web: { search: { apiKey: "search-key" } } } } as OpenClawConfig,
        env: {},
        origin: "global",
      }),
    ).toBe(true);
  });
});
