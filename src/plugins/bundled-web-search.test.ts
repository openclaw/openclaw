import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { loadBundledCapabilityRuntimeRegistry } from "./bundled-capability-runtime.js";
import { BUNDLED_WEB_SEARCH_PLUGIN_IDS } from "./bundled-web-search-ids.js";
import { hasBundledWebSearchCredential } from "./bundled-web-search-registry.js";
import {
  listBundledWebSearchPluginIds,
  listBundledWebSearchProviders,
  resolveBundledWebSearchPluginId,
  resolveBundledWebSearchPluginIds,
} from "./bundled-web-search.js";
import { loadPluginManifestRegistry } from "./manifest-registry.js";

vi.mock("./manifest-registry.js", () => ({
  loadPluginManifestRegistry: vi.fn(),
}));

vi.mock("./bundled-capability-runtime.js", () => ({
  loadBundledCapabilityRuntimeRegistry: vi.fn(),
}));

const resolveBundledPluginWebSearchProvidersMock = vi.hoisted(() => vi.fn());

vi.mock("./web-search-providers.js", () => ({
  resolveBundledPluginWebSearchProviders: resolveBundledPluginWebSearchProvidersMock,
}));

function createMockedBundledWebSearchProvider(params: {
  pluginId: string;
  providerId: string;
  configuredCredential?: unknown;
  scopedCredential?: unknown;
  envVars?: string[];
}) {
  return {
    pluginId: params.pluginId,
    id: params.providerId,
    label: params.providerId,
    hint: `${params.providerId} provider`,
    envVars: params.envVars ?? [],
    placeholder: `${params.providerId}-key`,
    signupUrl: `https://example.com/${params.providerId}`,
    autoDetectOrder: 10,
    credentialPath: `plugins.entries.${params.pluginId}.config.webSearch.apiKey`,
    getCredentialValue: () => params.scopedCredential,
    getConfiguredCredentialValue: () => params.configuredCredential,
    setCredentialValue: () => {},
    createTool: () => ({
      description: params.providerId,
      parameters: {},
      execute: async () => ({}),
    }),
  };
}

describe("bundled web search helpers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(loadPluginManifestRegistry).mockReturnValue({
      plugins: [
        { id: "xai", origin: "bundled" },
        { id: "google", origin: "bundled" },
        { id: "noise", origin: "bundled" },
        { id: "external-google", origin: "workspace" },
      ] as never[],
      diagnostics: [],
    });
    vi.mocked(loadBundledCapabilityRuntimeRegistry).mockReturnValue({
      webSearchProviders: [
        {
          pluginId: "minimax",
          provider: createMockedBundledWebSearchProvider({
            pluginId: "minimax",
            providerId: "minimax",
          }),
        },
        {
          pluginId: "xai",
          provider: createMockedBundledWebSearchProvider({
            pluginId: "xai",
            providerId: "grok",
          }),
        },
        {
          pluginId: "google",
          provider: createMockedBundledWebSearchProvider({
            pluginId: "google",
            providerId: "gemini",
          }),
        },
      ],
    } as never);
  });

  it("filters bundled manifest entries down to known bundled web search plugins", () => {
    expect(
      resolveBundledWebSearchPluginIds({
        config: {
          plugins: {
            allow: ["google", "xai"],
          },
        },
        workspaceDir: "/tmp/workspace",
        env: { OPENCLAW_HOME: "/tmp/openclaw-home" },
      }),
    ).toEqual(["google", "xai"]);
    expect(loadPluginManifestRegistry).toHaveBeenCalledWith({
      config: {
        plugins: {
          allow: ["google", "xai"],
        },
      },
      workspaceDir: "/tmp/workspace",
      env: { OPENCLAW_HOME: "/tmp/openclaw-home" },
    });
  });

  it("returns a copy of the bundled plugin id fast-path list", () => {
    const listed = listBundledWebSearchPluginIds();
    expect(listed).toEqual([...BUNDLED_WEB_SEARCH_PLUGIN_IDS]);
    expect(listed).not.toBe(BUNDLED_WEB_SEARCH_PLUGIN_IDS);
  });

  it("maps bundled provider ids back to their owning plugins", () => {
    expect(resolveBundledWebSearchPluginId(" gemini ")).toBe("google");
    expect(resolveBundledWebSearchPluginId(" minimax ")).toBe("minimax");
    expect(resolveBundledWebSearchPluginId("missing")).toBeUndefined();
  });

  it("loads bundled provider entries through the capability runtime registry once", () => {
    expect(listBundledWebSearchProviders()).toEqual([
      expect.objectContaining({ pluginId: "minimax", id: "minimax" }),
      expect.objectContaining({ pluginId: "xai", id: "grok" }),
      expect.objectContaining({ pluginId: "google", id: "gemini" }),
    ]);
    expect(listBundledWebSearchProviders()).toEqual([
      expect.objectContaining({ pluginId: "minimax", id: "minimax" }),
      expect.objectContaining({ pluginId: "xai", id: "grok" }),
      expect.objectContaining({ pluginId: "google", id: "gemini" }),
    ]);
    expect(loadBundledCapabilityRuntimeRegistry).toHaveBeenCalledTimes(1);
    expect(loadBundledCapabilityRuntimeRegistry).toHaveBeenCalledWith({
      pluginIds: BUNDLED_WEB_SEARCH_PLUGIN_IDS,
      pluginSdkResolution: "dist",
    });
  });
});

describe("hasBundledWebSearchCredential", () => {
  const baseCfg = {
    agents: { defaults: { model: { primary: "ollama/mistral-8b" } } },
    browser: { enabled: false },
    tools: { web: { fetch: { enabled: false } } },
  } satisfies OpenClawConfig;

  beforeEach(() => {
    resolveBundledPluginWebSearchProvidersMock.mockReset();
  });

  it.each([
    {
      name: "detects configured plugin credentials",
      providers: [
        createMockedBundledWebSearchProvider({
          pluginId: "google",
          providerId: "gemini",
          configuredCredential: "AIza-test",
        }),
      ],
      config: baseCfg,
      env: {},
    },
    {
      name: "detects scoped tool credentials",
      providers: [
        createMockedBundledWebSearchProvider({
          pluginId: "google",
          providerId: "gemini",
          scopedCredential: "AIza-test",
        }),
      ],
      config: baseCfg,
      env: {},
      searchConfig: { provider: "gemini" },
    },
    {
      name: "detects env credentials",
      providers: [
        createMockedBundledWebSearchProvider({
          pluginId: "xai",
          providerId: "grok",
          envVars: ["XAI_API_KEY"],
        }),
      ],
      config: baseCfg,
      env: { XAI_API_KEY: "xai-test" },
    },
  ] as const)("$name", ({ providers, config, env, searchConfig }) => {
    resolveBundledPluginWebSearchProvidersMock.mockReturnValue(providers);

    expect(hasBundledWebSearchCredential({ config, env, searchConfig })).toBe(true);
    expect(resolveBundledPluginWebSearchProvidersMock).toHaveBeenCalledWith({
      config,
      env,
      bundledAllowlistCompat: true,
    });
  });

  it("returns false when no bundled provider exposes a configured credential", () => {
    resolveBundledPluginWebSearchProvidersMock.mockReturnValue([
      createMockedBundledWebSearchProvider({
        pluginId: "google",
        providerId: "gemini",
        envVars: ["GEMINI_API_KEY"],
      }),
    ]);

    expect(hasBundledWebSearchCredential({ config: baseCfg, env: {} })).toBe(false);
  });
});
