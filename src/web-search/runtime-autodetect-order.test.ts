import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  replaceRuntimeAuthProfileStoreSnapshots,
} from "../agents/auth-profiles/runtime-snapshots.js";
import * as authSource from "../agents/auth-profiles/source-check.js";
import type { PluginWebSearchProviderEntry } from "../plugins/web-provider-types.js";
import type { RuntimeWebSearchMetadata } from "../secrets/runtime-web-tools.types.js";
import { createWebSearchTestProvider } from "../test-utils/web-provider-runtime.test-helpers.js";
import { runWebSearch } from "./runtime.js";

// mock-isolation: Use fixed discovery policy without opening machine state for provider fixtures.
vi.mock("../plugins/bundled-discovery-state.js", () => ({
  prepareBundledDiscoveryMode: async () => () => {},
  readBundledDiscoveryModeMemoized: () => undefined,
}));

const { resolveProviders } = vi.hoisted(() => ({
  resolveProviders: vi.fn<() => PluginWebSearchProviderEntry[]>(() => []),
}));
vi.mock("../plugins/plugin-registry-contributions.js", () => ({
  resolveManifestContractOwnerPluginId: () => undefined,
}));
vi.mock("../plugins/web-search-providers.runtime.js", () => ({
  resolvePluginWebSearchProviders: resolveProviders,
  resolveRuntimeWebSearchProviders: resolveProviders,
}));

describe("web search OAuth and environment auto-detection", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  afterEach(() => {
    vi.unstubAllEnvs();
    resolveProviders.mockReset();
    clearRuntimeAuthProfileStoreSnapshots();
  });

  it("executes explicitly selected plugins without opening their auth sources", async () => {
    using sourceProbe = vi
      .spyOn(authSource, "hasAnyAuthProfileStoreSourceAsync")
      .mockRejectedValue(new Error("auth source unavailable"));
    resolveProviders.mockReturnValue([
      createWebSearchTestProvider({
        pluginId: "custom-search",
        id: "custom",
        credentialPath: "tools.web.search.custom.apiKey",
        authProviderId: "custom-auth",
      }),
    ]);

    await expect(
      runWebSearch({
        config: { tools: { web: { search: { provider: "custom" } } } },
        args: { query: "hello" },
      }),
    ).resolves.toEqual({
      provider: "custom",
      result: { query: "hello", provider: "custom" },
    });
    expect(sourceProbe).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "environment fallback after OAuth failure",
      oauth: true,
      pin: undefined,
      order: ["grok", "tavily"],
    },
    {
      name: "environment only",
      oauth: false,
      pin: undefined,
      order: ["tavily"],
    },
    {
      name: "explicit environment provider",
      oauth: true,
      pin: "tavily",
      order: ["tavily"],
    },
  ])("preserves $name", async ({ oauth, pin, order }) => {
    vi.stubEnv("TAVILY_API_KEY", "tavily-synthetic-key");
    const agentDir = tempDirs.make("openclaw-web-search-order-");
    replaceRuntimeAuthProfileStoreSnapshots([
      {
        agentDir,
        store: {
          version: 1,
          profiles: oauth
            ? {
                "xai:default": {
                  type: "oauth",
                  provider: "xai",
                  access: "synthetic-access",
                  refresh: "synthetic-refresh",
                  expires: Date.now() + 3_600_000,
                },
              }
            : {},
        },
      },
    ]);
    const attempts: string[] = [];
    resolveProviders.mockReturnValue([
      createWebSearchTestProvider({
        pluginId: "xai",
        id: "grok",
        authProviderId: "xai",
        credentialPath: "plugins.entries.xai.config.webSearch.apiKey",
        autoDetectOrder: 30,
        createTool: () => ({
          description: "grok",
          parameters: {},
          execute: async () => {
            attempts.push("grok");
            throw new Error("grok search failed");
          },
        }),
      }),
      createWebSearchTestProvider({
        pluginId: "tavily",
        id: "tavily",
        credentialPath: "plugins.entries.tavily.config.webSearch.apiKey",
        autoDetectOrder: 70,
        createTool: () => ({
          description: "tavily",
          parameters: {},
          execute: async () => {
            attempts.push("tavily");
            return { answer: "environment result" };
          },
        }),
      }),
    ]);
    const runtimeWebSearch: RuntimeWebSearchMetadata = {
      providerSource: pin ? "configured" : "auto-detect",
      selectedProvider: "tavily",
      selectedProviderKeySource: "env",
      diagnostics: [],
    };
    await expect(
      runWebSearch({
        agentDir,
        config: pin ? { tools: { web: { search: { provider: pin } } } } : {},
        runtimeWebSearch,
        args: { query: "OAuth and environment ordering" },
      }),
    ).resolves.toMatchObject({ provider: order.at(-1) });
    expect(attempts).toEqual(order);
  });
});
