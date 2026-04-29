import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthProfileStore } from "../../agents/auth-profiles/types.js";
import { createModelListAuthIndex } from "./list.auth-index.js";

type PluginSnapshotResult = {
  source: "persisted" | "provided" | "derived";
  snapshot: {
    plugins: Array<{ enabled?: boolean; syntheticAuthRefs?: string[] }>;
  };
  diagnostics: [];
};

const pluginRegistryMocks = vi.hoisted(() => ({
  loadPluginRegistrySnapshotWithMetadata: vi.fn(
    (): PluginSnapshotResult => ({
      source: "persisted",
      snapshot: { plugins: [] },
      diagnostics: [],
    }),
  ),
}));

const envCandidateMocks = vi.hoisted(() => ({
  resolveProviderEnvApiKeyCandidates: vi.fn(),
}));

vi.mock("../../agents/model-auth-env-vars.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../agents/model-auth-env-vars.js")>();
  envCandidateMocks.resolveProviderEnvApiKeyCandidates.mockImplementation(
    actual.resolveProviderEnvApiKeyCandidates,
  );
  return {
    ...actual,
    resolveProviderEnvApiKeyCandidates: envCandidateMocks.resolveProviderEnvApiKeyCandidates,
  };
});

vi.mock("../../plugins/plugin-registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../plugins/plugin-registry.js")>();
  return {
    ...actual,
    loadPluginRegistrySnapshotWithMetadata:
      pluginRegistryMocks.loadPluginRegistrySnapshotWithMetadata,
  };
});

const emptyStore: AuthProfileStore = {
  version: 1,
  profiles: {},
};

function modelConfig(id: string) {
  return {
    id,
    name: id,
    reasoning: false,
    input: ["text" as const],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8192,
    maxTokens: 4096,
  };
}

describe("createModelListAuthIndex", () => {
  beforeEach(() => {
    envCandidateMocks.resolveProviderEnvApiKeyCandidates.mockClear();
    pluginRegistryMocks.loadPluginRegistrySnapshotWithMetadata.mockClear();
  });

  it("normalizes auth aliases from profiles", () => {
    const index = createModelListAuthIndex({
      cfg: {},
      authStore: {
        version: 1,
        profiles: {
          "byteplus:default": {
            type: "api_key",
            provider: "byteplus",
            key: "sk-test",
          },
        },
      },
      env: {},
    });

    expect(index.hasProviderAuth("byteplus")).toBe(true);
    expect(index.hasProviderAuth("byteplus-plan")).toBe(true);
  });

  it("records env-backed providers without resolving env candidates per row", () => {
    const index = createModelListAuthIndex({
      cfg: {},
      authStore: emptyStore,
      env: {
        MOONSHOT_API_KEY: "sk-test",
      },
    });

    expect(index.hasProviderAuth("moonshot")).toBe(true);
    expect(index.hasProviderAuth("openai")).toBe(false);
  });

  it("checks resolver-only env auth on demand", () => {
    envCandidateMocks.resolveProviderEnvApiKeyCandidates.mockReturnValueOnce({});
    const index = createModelListAuthIndex({
      cfg: {},
      authStore: emptyStore,
      env: {
        GOOGLE_CLOUD_API_KEY: "gcp-test",
      },
    });

    expect(index.hasProviderAuth("google-vertex")).toBe(true);
  });

  it("records configured provider API keys", () => {
    const index = createModelListAuthIndex({
      cfg: {
        models: {
          providers: {
            "custom-openai": {
              api: "openai-completions",
              apiKey: "sk-configured",
              baseUrl: "https://custom.example/v1",
              models: [modelConfig("local-model")],
            },
          },
        },
      },
      authStore: emptyStore,
      env: {},
    });

    expect(index.hasProviderAuth("custom-openai")).toBe(true);
  });

  it("records configured local custom provider markers", () => {
    const index = createModelListAuthIndex({
      cfg: {
        models: {
          providers: {
            "local-openai": {
              api: "openai-completions",
              baseUrl: "http://127.0.0.1:8080/v1",
              models: [modelConfig("local-model")],
            },
          },
        },
      },
      authStore: emptyStore,
      env: {},
    });

    expect(index.hasProviderAuth("local-openai")).toBe(true);
  });

  it("uses injected synthetic auth refs without loading provider runtime", () => {
    const index = createModelListAuthIndex({
      cfg: {},
      authStore: emptyStore,
      env: {},
      syntheticAuthProviderRefs: ["codex"],
    });

    expect(index.hasProviderAuth("codex")).toBe(true);
  });

  it("keeps synthetic auth refs exact instead of applying auth-choice aliases", () => {
    const index = createModelListAuthIndex({
      cfg: {},
      authStore: emptyStore,
      env: {},
      syntheticAuthProviderRefs: ["claude-cli"],
    });

    expect(index.hasProviderAuth("claude-cli")).toBe(true);
    expect(index.hasProviderAuth("anthropic")).toBe(false);
  });

  it("ignores derived synthetic auth snapshots", () => {
    pluginRegistryMocks.loadPluginRegistrySnapshotWithMetadata.mockReturnValueOnce({
      source: "derived",
      snapshot: {
        plugins: [{ enabled: true, syntheticAuthRefs: ["codex"] }],
      },
      diagnostics: [],
    });
    const index = createModelListAuthIndex({
      cfg: {},
      authStore: emptyStore,
      env: {},
    });

    expect(index.hasProviderAuth("codex")).toBe(false);
  });

  it("ignores disabled synthetic auth snapshot entries", () => {
    pluginRegistryMocks.loadPluginRegistrySnapshotWithMetadata.mockReturnValueOnce({
      source: "persisted",
      snapshot: {
        plugins: [{ enabled: false, syntheticAuthRefs: ["codex"] }],
      },
      diagnostics: [],
    });
    const index = createModelListAuthIndex({
      cfg: {},
      authStore: emptyStore,
      env: {},
    });

    expect(index.hasProviderAuth("codex")).toBe(false);
  });
});
