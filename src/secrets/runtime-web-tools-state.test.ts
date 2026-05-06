import { beforeAll, describe, expect, it } from "vitest";
import { asConfig, setupSecretsRuntimeSnapshotTestHooks } from "./runtime.test-support.ts";

let activateSecretsRuntimeSnapshot: typeof import("./runtime.js").activateSecretsRuntimeSnapshot;
let getActiveRuntimeWebToolsMetadata: typeof import("./runtime.js").getActiveRuntimeWebToolsMetadata;
const { prepareSecretsRuntimeSnapshot } = setupSecretsRuntimeSnapshotTestHooks();

describe("runtime web tools state", () => {
  beforeAll(async () => {
    ({ activateSecretsRuntimeSnapshot, getActiveRuntimeWebToolsMetadata } =
      await import("./runtime.js"));
  });

  it("exposes active runtime web tool metadata as a defensive clone", async () => {
    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        tools: {
          web: {
            search: {
              provider: "gemini",
            },
          },
        },
        plugins: {
          entries: {
            google: {
              config: {
                webSearch: {
                  apiKey: {
                    source: "env",
                    provider: "default",
                    id: "WEB_SEARCH_GEMINI_API_KEY",
                  },
                },
              },
            },
          },
        },
      }),
      env: {
        WEB_SEARCH_GEMINI_API_KEY: "web-search-gemini-ref",
      },
      agentDirs: ["/tmp/openclaw-agent-main"],
      loadablePluginOrigins: new Map([["google", "bundled"]]),
      loadAuthStore: () => ({ version: 1, profiles: {} }),
    });

    activateSecretsRuntimeSnapshot(snapshot);

    const first = getActiveRuntimeWebToolsMetadata();
    expect(first?.search.providerConfigured).toBe("gemini");
    expect(first?.search.selectedProvider).toBe("gemini");
    expect(first?.search.selectedProviderKeySource).toBe("secretRef");
    if (!first) {
      throw new Error("missing runtime web tools metadata");
    }
    first.search.providerConfigured = "brave";
    first.search.selectedProvider = "brave";

    const second = getActiveRuntimeWebToolsMetadata();
    expect(second?.search.providerConfigured).toBe("gemini");
    expect(second?.search.selectedProvider).toBe("gemini");
  });

  it("preserves active web tools metadata when a fast-path refresh fires for a snapshot whose prior source config had a web surface", async () => {
    // Activate an initial snapshot with a configured web surface.
    const initial = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        tools: {
          web: {
            search: { provider: "gemini" },
          },
        },
        plugins: {
          entries: {
            google: {
              config: {
                webSearch: {
                  apiKey: { source: "env", provider: "default", id: "WEB_SEARCH_GEMINI_API_KEY" },
                },
              },
            },
          },
        },
      }),
      env: { WEB_SEARCH_GEMINI_API_KEY: "gemini-key" },
      agentDirs: ["/tmp/openclaw-agent-main"],
      loadablePluginOrigins: new Map([["google", "bundled"]]),
      loadAuthStore: () => ({ version: 1, profiles: {} }),
    });
    activateSecretsRuntimeSnapshot(initial);

    const before = getActiveRuntimeWebToolsMetadata();
    expect(before?.search.providerConfigured).toBe("gemini");

    // Simulate a stripped-config refresh that has no web surface and no SecretRefs
    // (fast path fires, returns empty webTools).
    const stripped = await prepareSecretsRuntimeSnapshot({
      config: asConfig({ gateway: { port: 18789 } }),
      env: {},
      agentDirs: ["/tmp/openclaw-agent-main"],
      loadablePluginOrigins: new Map(),
      loadAuthStore: () => ({ version: 1, profiles: {} }),
    });
    expect(stripped.webToolsFromFastPath).toBe(true);
    activateSecretsRuntimeSnapshot(stripped);

    // Active webTools must be preserved — the fast-path result must not clobber.
    const after = getActiveRuntimeWebToolsMetadata();
    expect(after?.search.providerConfigured).toBe("gemini");
  });

  it("clears active web tools metadata when the full resolver runs and finds no web surface", async () => {
    const initial = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        tools: { web: { search: { provider: "gemini" } } },
        plugins: {
          entries: {
            google: {
              config: {
                webSearch: {
                  apiKey: { source: "env", provider: "default", id: "WEB_SEARCH_GEMINI_API_KEY" },
                },
              },
            },
          },
        },
      }),
      env: { WEB_SEARCH_GEMINI_API_KEY: "gemini-key" },
      agentDirs: ["/tmp/openclaw-agent-main"],
      loadablePluginOrigins: new Map([["google", "bundled"]]),
      loadAuthStore: () => ({ version: 1, profiles: {} }),
    });
    activateSecretsRuntimeSnapshot(initial);

    // Config with a SecretRef but no web surface: full resolver runs.
    const noWeb = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        models: {
          providers: {
            openai: {
              baseUrl: "https://api.openai.com/v1",
              apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
              models: [],
            },
          },
        },
      }),
      env: { OPENAI_API_KEY: "sk-test" },
      agentDirs: ["/tmp/openclaw-agent-main"],
      loadablePluginOrigins: new Map(),
      loadAuthStore: () => ({ version: 1, profiles: {} }),
    });
    expect(noWeb.webToolsFromFastPath).toBe(false);
    activateSecretsRuntimeSnapshot(noWeb);

    // Full resolver ran with no web config → webTools must be cleared.
    const after = getActiveRuntimeWebToolsMetadata();
    expect(after?.search.providerSource).toBe("none");
  });

  it("preserves active web tools metadata across two successive fast-path refreshes", async () => {
    // Establish an initial full-resolver snapshot with a configured web surface.
    const initial = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        tools: { web: { search: { provider: "gemini" } } },
        plugins: {
          entries: {
            google: {
              config: {
                webSearch: {
                  apiKey: { source: "env", provider: "default", id: "WEB_SEARCH_GEMINI_API_KEY" },
                },
              },
            },
          },
        },
      }),
      env: { WEB_SEARCH_GEMINI_API_KEY: "gemini-key" },
      agentDirs: ["/tmp/openclaw-agent-main"],
      loadablePluginOrigins: new Map([["google", "bundled"]]),
      loadAuthStore: () => ({ version: 1, profiles: {} }),
    });
    activateSecretsRuntimeSnapshot(initial);
    expect(getActiveRuntimeWebToolsMetadata()?.search.providerConfigured).toBe("gemini");

    // First fast-path refresh with a stripped config (no web surface, no SecretRefs).
    const stripped1 = await prepareSecretsRuntimeSnapshot({
      config: asConfig({ gateway: { port: 18789 } }),
      env: {},
      agentDirs: ["/tmp/openclaw-agent-main"],
      loadablePluginOrigins: new Map(),
      loadAuthStore: () => ({ version: 1, profiles: {} }),
    });
    expect(stripped1.webToolsFromFastPath).toBe(true);
    activateSecretsRuntimeSnapshot(stripped1);
    expect(getActiveRuntimeWebToolsMetadata()?.search.providerConfigured).toBe("gemini");

    // Second fast-path refresh — must still preserve; the first stripped activation
    // must not have poisoned the durability signal.
    const stripped2 = await prepareSecretsRuntimeSnapshot({
      config: asConfig({ gateway: { port: 18790 } }),
      env: {},
      agentDirs: ["/tmp/openclaw-agent-main"],
      loadablePluginOrigins: new Map(),
      loadAuthStore: () => ({ version: 1, profiles: {} }),
    });
    expect(stripped2.webToolsFromFastPath).toBe(true);
    activateSecretsRuntimeSnapshot(stripped2);

    // Metadata must still reflect the original full-resolver result.
    const after = getActiveRuntimeWebToolsMetadata();
    expect(after?.search.providerConfigured).toBe("gemini");
    expect(after?.search.providerSource).toBe("configured");
  });
});
