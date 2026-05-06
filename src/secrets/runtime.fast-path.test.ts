import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthProfileStore } from "../agents/auth-profiles.js";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../config/config.js";
import { createEmptyPluginRegistry } from "../plugins/registry.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { clearSecretsRuntimeSnapshot } from "./runtime.js";
import { asConfig } from "./runtime.test-support.js";

const { resolveRuntimeWebToolsMock, runtimePrepareImportMock } = vi.hoisted(() => ({
  resolveRuntimeWebToolsMock: vi.fn(
    async (): Promise<import("./runtime-web-tools.js").RuntimeWebToolsMetadata> => ({
      search: { providerSource: "none", diagnostics: [] },
      fetch: { providerSource: "none", diagnostics: [] },
      diagnostics: [],
    }),
  ),
  runtimePrepareImportMock: vi.fn(),
}));

vi.mock("./runtime-prepare.runtime.js", () => {
  runtimePrepareImportMock();
  return {
    createResolverContext: ({ sourceConfig, env }: { sourceConfig: unknown; env: unknown }) => ({
      sourceConfig,
      env,
      cache: {},
      warnings: [],
      warningKeys: new Set<string>(),
      assignments: [],
    }),
    collectConfigAssignments: () => undefined,
    collectAuthStoreAssignments: () => undefined,
    resolveSecretRefValues: async () => new Map(),
    applyResolvedAssignments: () => undefined,
    resolveRuntimeWebTools: resolveRuntimeWebToolsMock,
  };
});

function emptyAuthStore(): AuthProfileStore {
  return { version: 1, profiles: {} };
}

describe("secrets runtime fast path", () => {
  afterEach(() => {
    runtimePrepareImportMock.mockClear();
    resolveRuntimeWebToolsMock.mockClear();
    setActivePluginRegistry(createEmptyPluginRegistry());
    clearSecretsRuntimeSnapshot();
    clearRuntimeConfigSnapshot();
    clearConfigCache();
    vi.resetModules();
  });

  it("skips heavy resolver loading when config and auth stores have no SecretRefs", async () => {
    const { prepareSecretsRuntimeSnapshot } = await import("./runtime.js");

    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        gateway: {
          auth: {
            mode: "token",
            token: "plain-startup-token",
          },
        },
      }),
      env: {},
      agentDirs: ["/tmp/openclaw-agent-main"],
      loadAuthStore: emptyAuthStore,
    });

    expect(runtimePrepareImportMock).not.toHaveBeenCalled();
    expect(snapshot.config.gateway?.auth?.token).toBe("plain-startup-token");
    expect(snapshot.authStores).toEqual([
      {
        agentDir: "/tmp/openclaw-agent-main",
        store: emptyAuthStore(),
      },
    ]);
  });

  it("uses the fast path when web fetch only configures runtime limits", async () => {
    const { prepareSecretsRuntimeSnapshot } = await import("./runtime.js");

    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        tools: {
          web: {
            fetch: {
              enabled: true,
              maxChars: 200_000,
              maxCharsCap: 2_000_000,
            },
          },
        },
        plugins: {
          enabled: true,
          allow: [],
          entries: {},
        },
      }),
      env: {},
      agentDirs: ["/tmp/openclaw-agent-main"],
      loadAuthStore: emptyAuthStore,
    });

    expect(runtimePrepareImportMock).not.toHaveBeenCalled();
    expect(snapshot.webTools.fetch.providerSource).toBe("none");
  });

  it("uses the fast path when web fetch is explicitly disabled", async () => {
    const { prepareSecretsRuntimeSnapshot } = await import("./runtime.js");

    await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        tools: {
          web: {
            fetch: {
              enabled: false,
              maxChars: 200_000,
            },
          },
        },
      }),
      env: {},
      agentDirs: ["/tmp/openclaw-agent-main"],
      loadAuthStore: emptyAuthStore,
    });

    expect(runtimePrepareImportMock).not.toHaveBeenCalled();
  });

  it("uses the resolver path when an auth profile store contains a SecretRef", async () => {
    const { prepareSecretsRuntimeSnapshot } = await import("./runtime.js");

    await prepareSecretsRuntimeSnapshot({
      config: asConfig({}),
      env: {},
      agentDirs: ["/tmp/openclaw-agent-main"],
      loadAuthStore: () => ({
        version: 1,
        profiles: {
          "openai:default": {
            type: "api_key",
            provider: "openai",
            keyRef: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
          },
        },
      }),
    });

    expect(resolveRuntimeWebToolsMock).toHaveBeenCalledTimes(1);
  });

  it("keeps explicit web fetch provider config on the resolver path", async () => {
    const { prepareSecretsRuntimeSnapshot } = await import("./runtime.js");

    await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        tools: {
          web: {
            fetch: {
              provider: "firecrawl",
            },
          },
        },
      }),
      env: {},
      agentDirs: ["/tmp/openclaw-agent-main"],
      loadAuthStore: emptyAuthStore,
    });

    expect(resolveRuntimeWebToolsMock).toHaveBeenCalledTimes(1);
  });

  it("preserves resolved web tools when an active refresh receives a stripped config view", async () => {
    resolveRuntimeWebToolsMock.mockResolvedValueOnce({
      search: {
        providerConfigured: "brave",
        providerSource: "configured",
        selectedProvider: "brave",
        selectedProviderKeySource: "env",
        diagnostics: [],
      },
      fetch: { providerSource: "none", diagnostics: [] },
      diagnostics: [],
    });
    const {
      activateSecretsRuntimeSnapshot,
      getActiveRuntimeWebToolsMetadata,
      prepareSecretsRuntimeSnapshot,
    } = await import("./runtime.js");
    const { getRuntimeConfigSnapshotRefreshHandler } =
      await import("../config/runtime-snapshot.js");

    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        tools: {
          web: {
            search: {
              provider: "brave",
            },
          },
        },
      }),
      env: {
        BRAVE_API_KEY: "test-brave-key",
      },
      agentDirs: ["/tmp/openclaw-agent-main"],
      loadAuthStore: emptyAuthStore,
    });
    activateSecretsRuntimeSnapshot(snapshot);

    await getRuntimeConfigSnapshotRefreshHandler()?.refresh({
      sourceConfig: asConfig({
        gateway: {
          auth: {
            mode: "token",
            token: "plain-refreshed-token",
          },
        },
      }),
    });

    expect(resolveRuntimeWebToolsMock).toHaveBeenCalledTimes(1);
    expect(getActiveRuntimeWebToolsMetadata()?.search).toMatchObject({
      providerConfigured: "brave",
      providerSource: "configured",
      selectedProvider: "brave",
    });
  });

  it("does not preserve web tools when refresh explicitly includes an empty web config", async () => {
    resolveRuntimeWebToolsMock.mockResolvedValueOnce({
      search: {
        providerConfigured: "brave",
        providerSource: "configured",
        selectedProvider: "brave",
        selectedProviderKeySource: "env",
        diagnostics: [],
      },
      fetch: { providerSource: "none", diagnostics: [] },
      diagnostics: [],
    });
    const {
      activateSecretsRuntimeSnapshot,
      getActiveRuntimeWebToolsMetadata,
      prepareSecretsRuntimeSnapshot,
    } = await import("./runtime.js");
    const { getRuntimeConfigSnapshotRefreshHandler } =
      await import("../config/runtime-snapshot.js");

    const snapshot = await prepareSecretsRuntimeSnapshot({
      config: asConfig({
        tools: {
          web: {
            search: {
              provider: "brave",
            },
          },
        },
      }),
      env: {
        BRAVE_API_KEY: "test-brave-key",
      },
      agentDirs: ["/tmp/openclaw-agent-main"],
      loadAuthStore: emptyAuthStore,
    });
    activateSecretsRuntimeSnapshot(snapshot);

    await getRuntimeConfigSnapshotRefreshHandler()?.refresh({
      sourceConfig: asConfig({
        tools: {
          web: {},
        },
      }),
    });

    expect(resolveRuntimeWebToolsMock).toHaveBeenCalledTimes(1);
    expect(getActiveRuntimeWebToolsMetadata()?.search.providerSource).toBe("none");
  });
});
