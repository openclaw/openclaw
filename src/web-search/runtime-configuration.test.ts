import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveDefaultAgentDir } from "../agents/agent-scope-config.js";
import { noteCommittedSharedAuthStoreOwnership } from "../agents/auth-profiles/path-resolve.js";
import { authProfileRuntimeMode } from "../agents/auth-profiles/runtime-scope.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  setRuntimeAuthProfileStoreSnapshot,
} from "../agents/auth-profiles/runtime-snapshots.js";
import * as authProfileSource from "../agents/auth-profiles/source-check.js";
import { clearRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { clearActiveRuntimeWebToolsMetadata } from "../secrets/runtime-web-tools-state.js";
import {
  createOAuthAuthProfileStore,
  createWebSearchTestProvider,
  type WebSearchTestProviderParams,
} from "../test-utils/web-provider-runtime.test-helpers.js";
import { hasConfiguredWebSearchProvider, prepareWebSearchConfiguration } from "./runtime.js";

// mock-isolation: Use fixed discovery policy without opening machine state for provider fixtures.
vi.mock("../plugins/bundled-discovery-state.js", () => ({
  prepareBundledDiscoveryMode: async () => () => {},
  readBundledDiscoveryModeMemoized: () => undefined,
}));

const { resolveRuntimeWebSearchProvidersMock } = vi.hoisted(() => ({
  resolveRuntimeWebSearchProvidersMock: vi.fn<
    () => ReturnType<typeof createWebSearchTestProvider>[]
  >(() => []),
}));
// mock-isolation: Only local provider descriptors participate in this configuration-presence matrix.
vi.mock("../plugins/web-search-providers.runtime.js", () => ({
  resolvePluginWebSearchProviders: resolveRuntimeWebSearchProvidersMock,
  resolveRuntimeWebSearchProviders: resolveRuntimeWebSearchProvidersMock,
}));

function createCustomSearchProvider(overrides: Partial<WebSearchTestProviderParams> = {}) {
  return createWebSearchTestProvider({
    pluginId: "custom-search",
    id: "custom",
    autoDetectOrder: 1,
    credentialPath: "plugins.entries.custom-search.config.webSearch.apiKey",
    ...overrides,
  });
}

beforeEach(() => {
  noteCommittedSharedAuthStoreOwnership({ location: "legacy-main" });
  clearRuntimeConfigSnapshot();
  clearActiveRuntimeWebToolsMetadata();
  resolveRuntimeWebSearchProvidersMock.mockReset();
});
afterEach(() => {
  vi.restoreAllMocks();
  clearRuntimeAuthProfileStoreSnapshots();
  vi.unstubAllEnvs();
});

describe("web search configuration presence", () => {
  it("uses the supplied auth owner only when configuration needs source presence", async () => {
    const sourceProbe = vi
      .spyOn(authProfileSource, "hasAnyAuthProfileStoreSourceAsync")
      .mockRejectedValue(new Error("Unexpected standalone auth admission"));
    const prepareAuthSource = vi.fn(async () => ({ version: 1, profiles: {} }));
    resolveRuntimeWebSearchProvidersMock.mockReturnValue([
      createCustomSearchProvider({ authProviderId: "xai" }),
    ]);
    await expect(prepareWebSearchConfiguration({ config: {} }, prepareAuthSource)).resolves.toBe(
      false,
    );
    expect(prepareAuthSource).toHaveBeenCalledExactlyOnceWith(resolveDefaultAgentDir({}));
    expect(sourceProbe).not.toHaveBeenCalled();
    prepareAuthSource.mockClear();
    await expect(
      prepareWebSearchConfiguration(
        { config: { tools: { web: { search: { provider: "custom" } } } } },
        prepareAuthSource,
      ),
    ).resolves.toBe(true);
    setRuntimeAuthProfileStoreSnapshot({ version: 1, profiles: {} }, resolveDefaultAgentDir({}));
    await expect(prepareWebSearchConfiguration({ config: {} }, prepareAuthSource)).resolves.toBe(
      false,
    );
    expect(prepareAuthSource).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "uses published auth stores without cold admission (configured=%s)",
    async (configured) => {
      const sourceProbe = vi.spyOn(authProfileSource, "hasAnyAuthProfileStoreSourceAsync");
      const agentDir = resolveDefaultAgentDir({});
      resolveRuntimeWebSearchProvidersMock.mockReturnValue([
        createCustomSearchProvider({ authProviderId: "xai" }),
      ]);
      setRuntimeAuthProfileStoreSnapshot(
        configured
          ? createOAuthAuthProfileStore({
              provider: "xai",
              profileId: "xai:test",
              access: "test-access",
              refresh: "test-refresh",
            })
          : { version: 1, profiles: {} },
        agentDir,
      );
      await expect(prepareWebSearchConfiguration({ config: {} })).resolves.toBe(configured);
      expect(sourceProbe).not.toHaveBeenCalled();
      if (configured) {
        await expect(
          authProfileRuntimeMode.run({ kind: "env-only" }, () =>
            prepareWebSearchConfiguration({ config: {} }),
          ),
        ).resolves.toBe(false);
      }
      sourceProbe.mockClear();
      setRuntimeAuthProfileStoreSnapshot({ version: 1, profiles: {} }, agentDir);
      await expect(prepareWebSearchConfiguration({ config: {} })).resolves.toBe(false);
      expect(sourceProbe).not.toHaveBeenCalled();
    },
  );

  it.each([
    { name: "absent", value: undefined, configured: false },
    { name: "empty", value: "  ", configured: false },
    { name: "inline", value: "test-search-key", configured: true },
    {
      name: "unresolved env ref",
      value: { source: "env", provider: "default", id: "MISSING_SEARCH_TEST_KEY" },
      configured: true,
    },
    {
      name: "unresolved file ref",
      value: { source: "file", provider: "default", id: "/search/key" },
      configured: true,
    },
  ])("distinguishes $name configuration from provider health", ({ value, configured }) => {
    const createTool = vi.fn(() => {
      throw new Error("Configuration checks must not construct provider tools");
    });
    resolveRuntimeWebSearchProvidersMock.mockReturnValue([
      createCustomSearchProvider({ getConfiguredCredentialValue: () => value, createTool }),
    ]);
    expect(
      hasConfiguredWebSearchProvider({ config: {}, authStore: { version: 1, profiles: {} } }),
    ).toBe(configured);
    expect(createTool).not.toHaveBeenCalled();
  });

  it("detects provider-owned env, fallback, and agent OAuth without executing providers", async () => {
    vi.stubEnv("OPENCLAW_TEST_SEARCH_KEY", "test-search-key");
    try {
      resolveRuntimeWebSearchProvidersMock.mockReturnValue([
        { ...createCustomSearchProvider(), envVars: ["OPENCLAW_TEST_SEARCH_KEY"] },
      ]);
      expect(await prepareWebSearchConfiguration({ config: {} })).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
    resolveRuntimeWebSearchProvidersMock.mockReturnValue([
      createCustomSearchProvider({
        getConfiguredCredentialFallback: () => ({
          value: "test-fallback-key",
          path: "models.providers.custom.apiKey",
        }),
      }),
    ]);
    expect(await prepareWebSearchConfiguration({ config: {} })).toBe(true);
    resolveRuntimeWebSearchProvidersMock.mockReturnValue([
      createCustomSearchProvider({ authProviderId: "xai" }),
    ]);
    expect(
      await prepareWebSearchConfiguration({
        config: {},
        authStore: createOAuthAuthProfileStore({
          provider: "xai",
          profileId: "xai:test",
          access: "test-access",
          refresh: "test-refresh",
        }),
      }),
    ).toBe(true);
    expect(
      await prepareWebSearchConfiguration({ config: {}, authStore: { version: 1, profiles: {} } }),
    ).toBe(false);
  });

  it("does not auto-select key-free providers but preserves explicit selection and unavailable setup", () => {
    resolveRuntimeWebSearchProvidersMock.mockReturnValue([
      createCustomSearchProvider({ requiresCredential: false }),
    ]);
    expect(hasConfiguredWebSearchProvider({ config: {} })).toBe(false);
    for (const provider of [
      "duckduckgo",
      "parallel-free",
      "ollama",
      "codex",
      "uninstalled-provider",
    ]) {
      expect(
        hasConfiguredWebSearchProvider({ config: { tools: { web: { search: { provider } } } } }),
      ).toBe(true);
    }
    resolveRuntimeWebSearchProvidersMock.mockClear();
    expect(
      hasConfiguredWebSearchProvider({
        config: {},
        runtimeWebSearch: {
          providerSource: "none",
          diagnostics: [
            { code: "WEB_SEARCH_KEY_UNRESOLVED_NO_FALLBACK", message: "private diagnostic" },
          ],
        },
      }),
    ).toBe(true);
    expect(resolveRuntimeWebSearchProvidersMock).not.toHaveBeenCalled();
  });
});
