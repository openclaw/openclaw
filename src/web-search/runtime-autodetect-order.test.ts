import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  replaceRuntimeAuthProfileStoreSnapshots,
} from "../agents/auth-profiles/runtime-snapshots.js";
import * as authSource from "../agents/auth-profiles/source-check.js";
import type { PluginWebSearchProviderEntry } from "../plugins/web-provider-types.js";
import {
  createOAuthAuthProfileStore,
  createWebSearchTestProvider,
} from "../test-utils/web-provider-runtime.test-helpers.js";
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
    { name: "OAuth fallback", oauth: true, pin: undefined, order: ["grok", "tavily"] },
    { name: "environment only", oauth: false, pin: undefined, order: ["tavily"] },
    { name: "explicit environment provider", oauth: true, pin: "tavily", order: ["tavily"] },
  ])("preserves $name", async ({ oauth, pin, order }) => {
    vi.stubEnv("TAVILY_API_KEY", "tavily-synthetic-key");
    const agentDir = tempDirs.make("openclaw-web-search-order-");
    const store = oauth
      ? createOAuthAuthProfileStore({
          provider: "xai",
          profileId: "xai:default",
          access: "synthetic-access",
          refresh: "synthetic-refresh",
        })
      : { version: 1, profiles: {} };
    replaceRuntimeAuthProfileStoreSnapshots([{ agentDir, store }]);
    const attempts: string[] = [];
    resolveProviders.mockReturnValue(
      [
        { pluginId: "xai", id: "grok", authProviderId: "xai", autoDetectOrder: 30 },
        { pluginId: "tavily", id: "tavily", autoDetectOrder: 70 },
      ].map((entry) =>
        createWebSearchTestProvider({
          ...entry,
          credentialPath: `plugins.entries.${entry.pluginId}.config.webSearch.apiKey`,
          createTool: () => ({
            description: entry.id,
            parameters: {},
            execute: async () => {
              attempts.push(entry.id);
              if (entry.id === "grok") {
                throw new Error("grok search failed");
              }
              return { answer: "environment result" };
            },
          }),
        }),
      ),
    );
    await expect(
      runWebSearch({
        agentDir,
        config: pin ? { tools: { web: { search: { provider: pin } } } } : {},
        runtimeWebSearch: {
          providerSource: pin ? "configured" : "auto-detect",
          selectedProvider: "tavily",
          selectedProviderKeySource: "env",
          diagnostics: [],
        },
        args: { query: "OAuth and environment ordering" },
      }),
    ).resolves.toMatchObject({ provider: order.at(-1) });
    expect(attempts).toEqual(order);
  });
});
