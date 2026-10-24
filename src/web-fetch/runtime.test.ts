/** Tests web_fetch runtime provider selection, credential discovery, and sandbox filtering. */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.js";
import type { PluginWebFetchProviderEntry } from "../plugins/types.js";
import type { RuntimeWebFetchMetadata } from "../secrets/runtime-web-tools.types.js";
import { clearSecretsRuntimeSnapshot } from "../secrets/runtime.js";
import { withEnv } from "../test-utils/env.js";
import {
  createWebFetchTestProvider,
  type WebFetchTestProviderParams,
} from "../test-utils/web-provider-runtime.test-helpers.js";

type TestPluginWebFetchConfig = { webFetch?: { apiKey?: unknown } };
const firecrawlCredential = { getConfiguredCredentialValue: () => "firecrawl-key" };

const { registryVersion, pluginProviders, runtimeProviders } = vi.hoisted(() => ({
  registryVersion: vi.fn(() => 1),
  pluginProviders: vi.fn<() => PluginWebFetchProviderEntry[]>(() => []),
  runtimeProviders: vi.fn<() => PluginWebFetchProviderEntry[]>(() => []),
}));

vi.mock("../plugins/runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../plugins/runtime.js")>();
  return { ...actual, getActivePluginRegistryVersion: registryVersion };
});

vi.mock("../plugins/web-fetch-providers.runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/web-fetch-providers.runtime.js")>()),
  resolvePluginWebFetchProviders: pluginProviders,
  resolveRuntimeWebFetchProviders: runtimeProviders,
}));

function getFirecrawlApiKey(config?: OpenClawConfig): unknown {
  const pluginConfig = config?.plugins?.entries?.firecrawl?.config as
    | TestPluginWebFetchConfig
    | undefined;
  return pluginConfig?.webFetch?.apiKey;
}

function createFirecrawlProvider(
  overrides: Partial<WebFetchTestProviderParams> = {},
): PluginWebFetchProviderEntry {
  return createWebFetchTestProvider({
    pluginId: "firecrawl",
    id: "firecrawl",
    credentialPath: "plugins.entries.firecrawl.config.webFetch.apiKey",
    autoDetectOrder: 1,
    ...overrides,
  });
}

function createThirdPartyFetchProvider(
  overrides: Partial<WebFetchTestProviderParams> = {},
): PluginWebFetchProviderEntry {
  return createWebFetchTestProvider({
    pluginId: "third-party-fetch",
    id: "thirdparty",
    credentialPath: "plugins.entries.third-party-fetch.config.webFetch.apiKey",
    autoDetectOrder: 0,
    getConfiguredCredentialValue: () => "runtime-key",
    ...overrides,
  });
}

function createFirecrawlPluginConfig(apiKey: unknown): OpenClawConfig {
  return {
    plugins: { entries: { firecrawl: { enabled: true, config: { webFetch: { apiKey } } } } },
  };
}

function selectedProviderConfig(provider: string) {
  return { tools: { web: { fetch: { provider } } } };
}

function runtimeMetadata(
  overrides: Partial<RuntimeWebFetchMetadata> = {},
): RuntimeWebFetchMetadata {
  return {
    providerSource: "auto-detect",
    selectedProvider: "firecrawl",
    selectedProviderKeySource: "env",
    diagnostics: [],
    ...overrides,
  };
}

describe("web fetch runtime", () => {
  let resolveWebFetchDefinition: typeof import("./runtime.js").resolveWebFetchDefinition;

  function resolveProvider(options: Parameters<typeof resolveWebFetchDefinition>[0]) {
    const resolved = resolveWebFetchDefinition(options);
    if (!resolved) {
      throw new Error("expected resolved web fetch definition");
    }
    return resolved.provider;
  }

  function useFirecrawl(overrides: Partial<WebFetchTestProviderParams> = {}) {
    pluginProviders.mockReturnValue([createFirecrawlProvider(overrides)]);
  }

  beforeAll(async () => {
    ({ resolveWebFetchDefinition } = await import("./runtime.js"));
  });

  beforeEach(() => {
    registryVersion.mockReset().mockReturnValue(1);
    pluginProviders.mockReset().mockReturnValue([]);
    runtimeProviders.mockReset().mockReturnValue([]);
  });

  afterEach(clearSecretsRuntimeSnapshot);

  it("does not auto-detect providers from plugin-owned env SecretRefs without runtime metadata", () => {
    useFirecrawl({ getConfiguredCredentialValue: getFirecrawlApiKey });
    const config = createFirecrawlPluginConfig({
      source: "env",
      provider: "default",
      id: "AWS_SECRET_ACCESS_KEY",
    });

    withEnv({ FIRECRAWL_API_KEY: "" }, () => {
      expect(resolveWebFetchDefinition({ config })).toBeNull();
    });
  });

  it("prefers the runtime-selected provider when metadata is available", () => {
    const unrelated = createThirdPartyFetchProvider({
      getConfiguredCredentialValue: () => {
        throw new Error("selected provider resolution probed unrelated credentials");
      },
    });
    const provider = createFirecrawlProvider();
    pluginProviders.mockReturnValue([unrelated, provider]);
    runtimeProviders.mockReturnValue([unrelated, provider]);

    expect(
      resolveProvider({
        config: {},
        runtimeWebFetch: runtimeMetadata(),
        preferRuntimeProviders: true,
      }).id,
    ).toBe("firecrawl");
  });

  it("auto-detects providers from provider-declared env vars", () => {
    useFirecrawl();
    withEnv({ FIRECRAWL_API_KEY: "firecrawl-env-key" }, () => {
      expect(resolveProvider({ config: {} }).id).toBe("firecrawl");
    });
  });

  it("uses an explicitly configured keyless provider without an API key", () => {
    useFirecrawl({ requiresCredential: false });
    expect(resolveProvider({ config: selectedProviderConfig("firecrawl") }).id).toBe("firecrawl");
  });

  it("does not auto-detect a keyless provider without a credential", () => {
    useFirecrawl({ requiresCredential: false });
    expect(resolveWebFetchDefinition({ config: {} })).toBeNull();
  });

  it("retries provider discovery after an empty plugin snapshot", () => {
    const provider = createFirecrawlProvider(firecrawlCredential);
    const config = createFirecrawlPluginConfig("firecrawl-key");
    pluginProviders.mockReturnValueOnce([]).mockReturnValueOnce([provider]);

    expect(resolveWebFetchDefinition({ config })).toBeNull();
    expect(resolveProvider({ config }).id).toBe("firecrawl");
    expect(pluginProviders).toHaveBeenCalledTimes(2);
  });

  it.each(["detached", "published"])(
    "invalidates provider discovery when the same %s config object changes",
    (mode) => {
      const createTool = vi.fn(createFirecrawlProvider().createTool);
      const firecrawl = createFirecrawlProvider({ ...firecrawlCredential, createTool });
      const external = createThirdPartyFetchProvider();
      pluginProviders.mockReturnValueOnce([firecrawl]).mockReturnValueOnce([external]);
      const config = selectedProviderConfig("firecrawl");
      const resolveId = () => resolveProvider({ config }).id;

      if (mode === "published") {
        setRuntimeConfigSnapshot(config);
      }
      expect(resolveId()).toBe("firecrawl");
      expect(resolveId()).toBe("firecrawl");
      expect(pluginProviders).toHaveBeenCalledTimes(1);
      expect(createTool).toHaveBeenCalledTimes(2);

      config.tools.web.fetch.provider = "thirdparty";
      if (mode === "published") {
        setRuntimeConfigSnapshot(config);
      }
      expect(resolveId()).toBe("thirdparty");
      expect(resolveId()).toBe("thirdparty");
      expect(pluginProviders).toHaveBeenCalledTimes(2);
    },
  );

  it("evicts superseded provider discovery cache entries", () => {
    const firstFirecrawl = createFirecrawlProvider(firecrawlCredential);
    const external = createThirdPartyFetchProvider();
    const secondFirecrawl = createFirecrawlProvider(firecrawlCredential);
    pluginProviders
      .mockReturnValueOnce([firstFirecrawl])
      .mockReturnValueOnce([external])
      .mockReturnValueOnce([secondFirecrawl]);
    registryVersion.mockReturnValueOnce(10).mockReturnValueOnce(11).mockReturnValueOnce(10);
    const config = createFirecrawlPluginConfig("firecrawl-key");

    const first = resolveProvider({ config });
    const second = resolveProvider({ config });
    const third = resolveProvider({ config });

    expect(first).toBe(firstFirecrawl);
    expect(second.id).toBe("thirdparty");
    expect(third).toBe(secondFirecrawl);
    expect(pluginProviders).toHaveBeenCalledTimes(3);
  });

  it("reuses runtime provider discovery across runtime-selected providers", () => {
    const firecrawl = createFirecrawlProvider(firecrawlCredential);
    const external = createThirdPartyFetchProvider();
    runtimeProviders.mockReturnValue([firecrawl, external]);
    const config = {};
    const options = { config, preferRuntimeProviders: true };
    const first = resolveProvider({ ...options, runtimeWebFetch: runtimeMetadata() });
    const second = resolveProvider({
      ...options,
      runtimeWebFetch: runtimeMetadata({
        providerSource: "configured",
        selectedProvider: "thirdparty",
        selectedProviderKeySource: "config",
      }),
    });

    expect(first.id).toBe("firecrawl");
    expect(second.id).toBe("thirdparty");
    expect(runtimeProviders).toHaveBeenCalledTimes(1);
  });

  it("auto-detects fallback credentials when the primary fetch key is blank", () => {
    const pluginConfig = {
      webFetch: { apiKey: "" },
      webSearch: { apiKey: "shared-firecrawl-key" },
    };
    useFirecrawl({
      getConfiguredCredentialValue: getFirecrawlApiKey,
      getConfiguredCredentialFallback: (config) => {
        const configured = config?.plugins?.entries?.firecrawl?.config as
          | { webSearch?: { apiKey?: unknown } }
          | undefined;
        return configured?.webSearch?.apiKey === undefined
          ? undefined
          : {
              path: "plugins.entries.firecrawl.config.webSearch.apiKey",
              value: configured.webSearch.apiKey,
            };
      },
    });
    const config = { plugins: { entries: { firecrawl: { config: pluginConfig } } } };
    const resolved = resolveProvider({ config });

    expect(resolved.id).toBe("firecrawl");
  });

  it("falls back to auto-detect when the configured provider is invalid", () => {
    useFirecrawl(firecrawlCredential);
    expect(resolveProvider({ config: selectedProviderConfig("does-not-exist") }).id).toBe(
      "firecrawl",
    );
  });

  it("keeps sandboxed web fetch on trusted providers even when runtime providers are preferred", () => {
    useFirecrawl({ getConfiguredCredentialValue: () => "bundled-key" });
    const runtimeOnly = createThirdPartyFetchProvider();
    runtimeProviders.mockReturnValue([runtimeOnly]);

    const resolved = resolveProvider({
      config: {},
      sandboxed: true,
      preferRuntimeProviders: true,
    });

    expect(resolved.id).toBe("firecrawl");
    expect(pluginProviders).toHaveBeenCalledWith({
      config: {},
      sandboxed: true,
    });
    expect(runtimeProviders).not.toHaveBeenCalled();
  });

  it("prefers an explicitly configured non-bundled provider over runtime metadata", () => {
    const bundled = createFirecrawlProvider({
      getConfiguredCredentialValue: () => "bundled-key",
    });
    const external = createThirdPartyFetchProvider();
    runtimeProviders.mockReturnValue([bundled, external]);

    const resolved = resolveProvider({
      config: selectedProviderConfig("thirdparty"),
      runtimeWebFetch: runtimeMetadata(),
      sandboxed: false,
      preferRuntimeProviders: true,
    });

    expect(resolved.id).toBe("thirdparty");
  });
});
