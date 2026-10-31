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

function createProvider(
  id: "firecrawl" | "thirdparty" = "firecrawl",
  overrides: Partial<WebFetchTestProviderParams> = {},
): PluginWebFetchProviderEntry {
  const pluginId = id === "firecrawl" ? id : "third-party-fetch";
  return createWebFetchTestProvider({
    pluginId,
    id,
    credentialPath: `plugins.entries.${pluginId}.config.webFetch.apiKey`,
    autoDetectOrder: id === "firecrawl" ? 1 : 0,
    ...(id === "thirdparty" ? { getConfiguredCredentialValue: () => "runtime-key" } : {}),
    ...overrides,
  });
}

function selectedProviderConfig(provider: string) {
  return { tools: { web: { fetch: { provider } } } };
}

function runtimeOptions(config: OpenClawConfig = {}, selectedProvider = "firecrawl") {
  return {
    config,
    preferRuntimeProviders: true,
    runtimeWebFetch: {
      providerSource: "auto-detect",
      selectedProvider,
      selectedProviderKeySource: "env",
      diagnostics: [],
    } satisfies RuntimeWebFetchMetadata,
  };
}

describe("web fetch runtime", () => {
  let resolveWebFetchDefinition: typeof import("./runtime.js").resolveWebFetchDefinition;

  function expectProvider(
    options: Parameters<typeof resolveWebFetchDefinition>[0],
    id = "firecrawl",
  ) {
    expect(resolveWebFetchDefinition(options)?.provider.id).toBe(id);
  }

  function useFirecrawl(overrides: Partial<WebFetchTestProviderParams> = {}) {
    pluginProviders.mockReturnValue([createProvider("firecrawl", overrides)]);
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
    useFirecrawl({
      getConfiguredCredentialValue: () => ({
        source: "env",
        provider: "default",
        id: "AWS_SECRET_ACCESS_KEY",
      }),
    });

    withEnv({ FIRECRAWL_API_KEY: "" }, () => {
      expect(resolveWebFetchDefinition({ config: {} })).toBeNull();
    });
  });

  it.each([
    { selection: "runtime", config: {}, expected: "firecrawl" },
    {
      selection: "configured",
      config: selectedProviderConfig("thirdparty"),
      expected: "thirdparty",
    },
  ])("prefers $selection selection without probing credentials", ({ config, expected }) => {
    const unrelated = createProvider("thirdparty", {
      getConfiguredCredentialValue: () => {
        throw new Error("selected provider resolution probed unrelated credentials");
      },
    });
    const provider = createProvider();
    pluginProviders.mockReturnValue([unrelated, provider]);
    runtimeProviders.mockReturnValue([unrelated, provider]);

    expectProvider({ ...runtimeOptions(config), sandboxed: false }, expected);
  });

  it("auto-detects providers from provider-declared env vars", () => {
    useFirecrawl();
    withEnv({ FIRECRAWL_API_KEY: "firecrawl-env-key" }, () => {
      expectProvider({ config: {} });
    });
  });

  it("uses an explicitly configured keyless provider without an API key", () => {
    useFirecrawl({ requiresCredential: false });
    expectProvider({ config: selectedProviderConfig("firecrawl") });
  });

  it("does not auto-detect a keyless provider without a credential", () => {
    useFirecrawl({ requiresCredential: false });
    expect(resolveWebFetchDefinition({ config: {} })).toBeNull();
  });

  it("retries provider discovery after an empty plugin snapshot", () => {
    const provider = createProvider("firecrawl", firecrawlCredential);
    const config = {};
    pluginProviders.mockReturnValueOnce([]).mockReturnValueOnce([provider]);

    expect(resolveWebFetchDefinition({ config })).toBeNull();
    expectProvider({ config });
  });

  it.each(["detached", "published"])(
    "invalidates provider discovery when the same %s config object changes",
    (mode) => {
      const createTool = vi.fn(createProvider().createTool);
      const firecrawl = createProvider("firecrawl", { ...firecrawlCredential, createTool });
      const external = createProvider("thirdparty");
      pluginProviders.mockReturnValueOnce([firecrawl]).mockReturnValueOnce([external]);
      const config = selectedProviderConfig("firecrawl");
      const check = (id: string, discoveryCalls: number) => {
        expectProvider({ config }, id);
        expectProvider({ config }, id);
        expect(pluginProviders).toHaveBeenCalledTimes(discoveryCalls);
      };
      const publish = () => {
        if (mode === "published") {
          setRuntimeConfigSnapshot(config);
        }
      };

      publish();
      check("firecrawl", 1);
      expect(createTool).toHaveBeenCalledTimes(2);

      config.tools.web.fetch.provider = "thirdparty";
      publish();
      check("thirdparty", 2);
    },
  );

  it("evicts superseded provider discovery cache entries", () => {
    const firstFirecrawl = createProvider("firecrawl", firecrawlCredential);
    const external = createProvider("thirdparty");
    const secondFirecrawl = createProvider("firecrawl", firecrawlCredential);
    pluginProviders
      .mockReturnValueOnce([firstFirecrawl])
      .mockReturnValueOnce([external])
      .mockReturnValueOnce([secondFirecrawl]);
    registryVersion.mockReturnValueOnce(10).mockReturnValueOnce(11).mockReturnValueOnce(10);
    const config = {};

    expect(resolveWebFetchDefinition({ config })?.provider).toBe(firstFirecrawl);
    expectProvider({ config }, "thirdparty");
    expect(resolveWebFetchDefinition({ config })?.provider).toBe(secondFirecrawl);
  });

  it("reuses runtime provider discovery across runtime-selected providers", () => {
    runtimeProviders.mockReturnValue([
      createProvider("firecrawl", firecrawlCredential),
      createProvider("thirdparty"),
    ]);
    const config = {};
    expectProvider(runtimeOptions(config));
    expectProvider(runtimeOptions(config, "thirdparty"), "thirdparty");
    expect(runtimeProviders).toHaveBeenCalledTimes(1);
  });

  it("auto-detects fallback credentials when the primary fetch key is blank", () => {
    useFirecrawl({
      getConfiguredCredentialValue: () => "",
      getConfiguredCredentialFallback: () => ({
        path: "plugins.entries.firecrawl.config.webSearch.apiKey",
        value: "shared-firecrawl-key",
      }),
    });
    expectProvider({ config: {} });
  });

  it("falls back to auto-detect when the configured provider is invalid", () => {
    useFirecrawl(firecrawlCredential);
    expectProvider({ config: selectedProviderConfig("does-not-exist") });
  });

  it("keeps sandboxed web fetch on trusted providers even when runtime providers are preferred", () => {
    useFirecrawl({ getConfiguredCredentialValue: () => "bundled-key" });
    runtimeProviders.mockReturnValue([createProvider("thirdparty")]);

    expectProvider({ config: {}, sandboxed: true, preferRuntimeProviders: true });
    expect(pluginProviders).toHaveBeenCalledWith({
      config: {},
      sandboxed: true,
    });
    expect(runtimeProviders).not.toHaveBeenCalled();
  });
});
