import { describe, expect, it, vi } from "vitest";
import type { AuthProfileStore } from "../../agents/auth-profiles/types.js";
import { createModelListAuthIndex } from "./list.auth-index.js";

vi.mock("../../plugins/installed-plugin-index-store.js", () => ({
  readPersistedInstalledPluginIndexSync: vi.fn(() => null),
}));

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
});
