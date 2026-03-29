import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderPlugin, WebSearchProviderPlugin } from "../types.js";

type MockPluginRecord = {
  id: string;
  status: "loaded" | "error";
  error?: string;
  providerIds: string[];
  webSearchProviderIds: string[];
};

type MockRuntimeRegistry = {
  plugins: MockPluginRecord[];
  diagnostics: Array<{ pluginId?: string; message: string }>;
  providers: Array<{ pluginId: string; provider: ProviderPlugin }>;
  webSearchProviders: Array<{ pluginId: string; provider: WebSearchProviderPlugin }>;
};

function createMockRuntimeRegistry(params: {
  plugin: MockPluginRecord;
  providers?: Array<{ pluginId: string; provider: ProviderPlugin }>;
  webSearchProviders?: Array<{ pluginId: string; provider: WebSearchProviderPlugin }>;
  diagnostics?: Array<{ pluginId?: string; message: string }>;
}): MockRuntimeRegistry {
  return {
    plugins: [params.plugin],
    diagnostics: params.diagnostics ?? [],
    providers: params.providers ?? [],
    webSearchProviders: params.webSearchProviders ?? [],
  };
}

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
});

describe("plugin contract registry scoped retries", () => {
  it("retries provider loads after a transient plugin-scoped runtime error", async () => {
    const loadBundledCapabilityRuntimeRegistry = vi
      .fn()
      .mockReturnValueOnce(
        createMockRuntimeRegistry({
          plugin: {
            id: "xai",
            status: "error",
            error: "transient xai load failure",
            providerIds: [],
            webSearchProviderIds: [],
          },
          diagnostics: [{ pluginId: "xai", message: "transient xai load failure" }],
        }),
      )
      .mockReturnValueOnce(
        createMockRuntimeRegistry({
          plugin: {
            id: "xai",
            status: "loaded",
            providerIds: ["xai"],
            webSearchProviderIds: ["grok"],
          },
          providers: [
            {
              pluginId: "xai",
              provider: {
                id: "xai",
                label: "xAI",
                docsPath: "/providers/xai",
                auth: [],
              } as ProviderPlugin,
            },
          ],
        }),
      );

    vi.doMock("../bundled-capability-runtime.js", () => ({
      loadBundledCapabilityRuntimeRegistry,
    }));

    const { resolveProviderContractProvidersForPluginIds } = await import("./registry.js");

    expect(
      resolveProviderContractProvidersForPluginIds(["xai"]).map((provider) => provider.id),
    ).toEqual(["xai"]);
    expect(loadBundledCapabilityRuntimeRegistry).toHaveBeenCalledTimes(2);
  });

  it("retries web search provider loads after a transient plugin-scoped runtime error", async () => {
    const loadBundledCapabilityRuntimeRegistry = vi
      .fn()
      .mockReturnValueOnce(
        createMockRuntimeRegistry({
          plugin: {
            id: "xai",
            status: "error",
            error: "transient grok load failure",
            providerIds: [],
            webSearchProviderIds: [],
          },
          diagnostics: [{ pluginId: "xai", message: "transient grok load failure" }],
        }),
      )
      .mockReturnValueOnce(
        createMockRuntimeRegistry({
          plugin: {
            id: "xai",
            status: "loaded",
            providerIds: ["xai"],
            webSearchProviderIds: ["grok"],
          },
          webSearchProviders: [
            {
              pluginId: "xai",
              provider: {
                id: "grok",
                label: "Grok Search",
                hint: "Search the web with Grok",
                envVars: ["XAI_API_KEY"],
                placeholder: "XAI_API_KEY",
                signupUrl: "https://x.ai",
                credentialPath: "plugins.entries.xai.config.webSearch.apiKey",
                requiresCredential: true,
                getCredentialValue: () => undefined,
                setCredentialValue() {},
                createTool: () => ({
                  description: "search",
                  parameters: {},
                  execute: async () => ({}),
                }),
              } as WebSearchProviderPlugin,
            },
          ],
        }),
      );

    vi.doMock("../bundled-capability-runtime.js", () => ({
      loadBundledCapabilityRuntimeRegistry,
    }));

    const { resolveWebSearchProviderContractEntriesForPluginId } = await import("./registry.js");

    expect(
      resolveWebSearchProviderContractEntriesForPluginId("xai").map((entry) => entry.provider.id),
    ).toEqual(["grok"]);
    expect(loadBundledCapabilityRuntimeRegistry).toHaveBeenCalledTimes(2);
  });

  it("reuses the single registered provider contract for paired manifest alias ids", async () => {
    const loadBundledCapabilityRuntimeRegistry = vi.fn().mockReturnValue(
      createMockRuntimeRegistry({
        plugin: {
          id: "byteplus",
          status: "loaded",
          providerIds: ["byteplus"],
          webSearchProviderIds: [],
        },
        providers: [
          {
            pluginId: "byteplus",
            provider: {
              id: "byteplus",
              label: "BytePlus",
              docsPath: "/providers/byteplus",
              auth: [],
            } as ProviderPlugin,
          },
        ],
      }),
    );

    vi.doMock("../bundled-capability-runtime.js", () => ({
      loadBundledCapabilityRuntimeRegistry,
    }));

    const { requireProviderContractProvider } = await import("./registry.js");

    expect(requireProviderContractProvider("byteplus-plan").id).toBe("byteplus");
    expect(loadBundledCapabilityRuntimeRegistry).toHaveBeenCalledTimes(1);
  });
});
