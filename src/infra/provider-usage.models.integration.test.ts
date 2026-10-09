import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";

const auth = vi.hoisted(() => ({
  ambient: vi.fn(() => {
    throw new Error("route preparation resolved ambient credentials");
  }),
  store: vi.fn(() => {
    throw new Error("route preparation read the auth store");
  }),
}));
vi.mock("../agents/agent-auth-discovery.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/agent-auth-discovery.js")>()),
  prepareAmbientAgentCredentialsForDiscovery: auth.ambient,
}));
vi.mock("../plugins/loader-runtime-load.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../plugins/loader-runtime-load.js")>();
  return {
    ...actual,
    nativePluginBindings: {
      ...actual.nativePluginBindings,
      authStore: {
        ...actual.nativePluginBindings.authStore,
        prepareAuthProfileStoreForModelRuntime: auth.store,
      },
    },
  };
});

import { createUsageModelBaseUrlResolver } from "./provider-usage.models.js";

describe("credential-free usage route preparation", () => {
  it.each(["none", "alias", "provider", "model"] as const)(
    "uses the real cold owner with a non-Kimi primary (proxy override: %s)",
    async (override) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        auth.ambient.mockClear();
        auth.store.mockClear();
        const agentDir = state.agentDir();
        const testModel = {
          id: "test-model",
          name: "Test",
          reasoning: false,
          input: ["text" as const],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 1000,
          maxTokens: 100,
        };
        const config: OpenClawConfig = {
          agents: { defaults: { model: "test-provider/test-model" }, entries: { main: {} } },
          plugins: { allow: ["kimi"], slots: { memory: "none" } },
          models: {
            providers: {
              "test-provider": {
                baseUrl: "https://other.example.test/v1",
                api: "openai-completions",
                models: [testModel],
              },
            },
          },
        };
        if (override === "provider" || override === "model") {
          config.models = {
            providers: {
              ...config.models?.providers,
              kimi: {
                baseUrl: "https://api.kimi.com/coding/",
                api: "anthropic-messages",
                models: [
                  {
                    ...testModel,
                    id: "kimi-for-coding",
                    ...(override === "model"
                      ? { baseUrl: "https://proxy.example.test/coding/" }
                      : {}),
                  },
                ],
              },
            },
          };
        }
        if (override === "alias" || override === "provider") {
          await fs.mkdir(agentDir, { recursive: true });
          await fs.writeFile(
            path.join(agentDir, "models.json"),
            JSON.stringify({
              providers: {
                [override === "alias" ? "kimi-coding" : "kimi"]: {
                  baseUrl: "https://proxy.example.test/coding/",
                  api: "anthropic-messages",
                  models: [
                    {
                      id: override === "alias" ? "test-proxy-model" : "kimi-for-coding",
                      name: "Test proxy",
                    },
                  ],
                },
              },
            }),
          );
        }
        const resolve = createUsageModelBaseUrlResolver({
          config,
          agentDir,
          env: { ...state.env, KIMI_API_KEY: "test-route-only-key" },
          providerIds: ["kimi-coding"],
        });
        const routes = await resolve(["kimi", "kimi-code", "kimi-coding"]);
        if (override !== "none") {
          expect(routes).toContain("https://proxy.example.test/coding/");
        } else {
          expect(routes).toEqual(["https://api.kimi.com/coding/"]);
        }
        expect(auth.ambient).not.toHaveBeenCalled();
        expect(auth.store).not.toHaveBeenCalled();
      });
    },
  );
});
