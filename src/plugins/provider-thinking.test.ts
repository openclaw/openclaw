import { beforeEach, describe, expect, it, vi } from "vitest";

const bundledMetadataMocks = vi.hoisted(() => ({
  listBundledPluginMetadata: vi.fn(),
}));

const PLUGIN_REGISTRY_STATE = Symbol.for("openclaw.pluginRegistryState");

function setActiveProviders(providers: unknown[]) {
  (globalThis as typeof globalThis & { [PLUGIN_REGISTRY_STATE]?: unknown })[
    PLUGIN_REGISTRY_STATE
  ] = {
    activeRegistry: {
      providers: providers.map((provider) => ({ provider })),
    },
  };
}

async function loadProviderThinkingModuleForTest() {
  vi.resetModules();
  vi.doMock("./bundled-plugin-metadata.js", () => ({
    listBundledPluginMetadata: bundledMetadataMocks.listBundledPluginMetadata,
  }));
  return await import("./provider-thinking.js");
}

describe("provider thinking policy lookup", () => {
  beforeEach(() => {
    bundledMetadataMocks.listBundledPluginMetadata.mockReset();
    bundledMetadataMocks.listBundledPluginMetadata.mockReturnValue([]);
    setActiveProviders([]);
  });

  it("falls back to bundled manifest compat for startup-inactive providers", async () => {
    bundledMetadataMocks.listBundledPluginMetadata.mockReturnValue([
      {
        manifest: {
          modelCatalog: {
            providers: {
              "openai-codex": {
                models: [
                  {
                    id: "gpt-5.5",
                    compat: { supportedReasoningEfforts: ["low", "medium", "high", "xhigh"] },
                  },
                ],
              },
            },
          },
        },
      },
    ]);
    const { resolveProviderXHighThinking } = await loadProviderThinkingModuleForTest();

    expect(
      resolveProviderXHighThinking({
        provider: "openai-codex",
        context: { provider: "openai-codex", modelId: "gpt-5.5" },
      }),
    ).toBe(true);
  });

  it("prefers active provider hooks when they are already registered", async () => {
    bundledMetadataMocks.listBundledPluginMetadata.mockReturnValue([
      {
        manifest: {
          modelCatalog: {
            providers: {
              "openai-codex": {
                models: [
                  {
                    id: "gpt-5.5",
                    compat: { supportedReasoningEfforts: ["low", "medium", "high"] },
                  },
                ],
              },
            },
          },
        },
      },
    ]);
    setActiveProviders([
      {
        id: "openai-codex",
        supportsXHighThinking: () => true,
      },
    ]);
    const { resolveProviderXHighThinking } = await loadProviderThinkingModuleForTest();

    expect(
      resolveProviderXHighThinking({
        provider: "openai-codex",
        context: { provider: "openai-codex", modelId: "gpt-5.5" },
      }),
    ).toBe(true);
  });

  it("does not infer xhigh when bundled compat omits it", async () => {
    bundledMetadataMocks.listBundledPluginMetadata.mockReturnValue([
      {
        manifest: {
          modelCatalog: {
            providers: {
              "openai-codex": {
                models: [
                  {
                    id: "gpt-5.5-pro",
                    compat: { supportedReasoningEfforts: ["medium", "high"] },
                  },
                ],
              },
            },
          },
        },
      },
    ]);
    const { resolveProviderXHighThinking } = await loadProviderThinkingModuleForTest();

    expect(
      resolveProviderXHighThinking({
        provider: "openai-codex",
        context: { provider: "openai-codex", modelId: "gpt-5.5-pro" },
      }),
    ).toBeUndefined();
  });
});
