// Status message tests cover status message formatting and persistence.
import { afterEach, describe, expect, it } from "vitest";
import { testing as cliBackendsTesting } from "../agents/cli-backends.js";
import type { ModelDefinitionConfig } from "../config/types.models.js";
import { buildStatusMessage } from "./status-message.js";

function statusTestModel(id: string, name: string, contextWindow: number): ModelDefinitionConfig {
  return {
    id,
    name,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens: 8_192,
  };
}

afterEach(() => {
  cliBackendsTesting.resetDepsForTest();
});

describe("buildStatusMessage context window", () => {
  it("ignores stale runtime context after a manual session model switch", () => {
    const text = buildStatusMessage({
      config: {
        models: {
          providers: {
            "ollama-cloud": {
              baseUrl: "https://ollama.com",
              models: [
                statusTestModel("deepseek-v4-pro", "DeepSeek V4 Pro", 1_000_000),
                statusTestModel("glm-5.1", "GLM 5.1", 200_000),
              ],
            },
          },
        },
      },
      agent: {
        model: "ollama-cloud/deepseek-v4-pro",
        contextTokens: 1_000_000,
      },
      configuredDefaultModelLabel: "ollama-cloud/deepseek-v4-pro",
      explicitConfiguredContextTokens: 1_000_000,
      runtimeContextTokens: 1_000_000,
      sessionEntry: {
        sessionId: "manual-switch-stale-runtime",
        updatedAt: 0,
        providerOverride: "ollama-cloud",
        modelOverride: "glm-5.1",
        modelOverrideSource: "user",
        modelProvider: "ollama-cloud",
        model: "deepseek-v4-pro",
        totalTokens: 128_393,
        totalTokensFresh: true,
      },
      sessionKey: "agent:main:telegram:direct:584667058",
      sessionScope: "per-sender",
      queue: { mode: "steer", depth: 0 },
      modelAuth: "api-key",
    });

    expect(text).toContain("Model: ollama-cloud/glm-5.1");
    expect(text).toContain("pinned session; config primary ollama-cloud/deepseek-v4-pro");
    expect(text).toContain("Context: 128k/200k");
    expect(text).not.toContain("Context: 128k/1.0m");
  });

  it("keeps trusted runtime context for config-backed runtime aliases", () => {
    cliBackendsTesting.setDepsForTest({
      resolvePluginSetupCliBackend: ({ backend }) =>
        backend === "claude-cli"
          ? {
              pluginId: "anthropic",
              backend: {
                id: "claude-cli",
                modelProvider: "anthropic",
                config: { command: "claude" },
                bundleMcp: false,
              },
            }
          : undefined,
      resolvePluginSetupRegistry: () => {
        throw new Error("setup registry should not load for a targeted runtime alias");
      },
      resolveRuntimeCliBackends: () => [],
    });

    const text = buildStatusMessage({
      config: {
        agents: {
          defaults: {
            cliBackends: {
              "claude-cli": { command: "claude" },
            },
          },
        },
        models: {
          providers: {
            anthropic: {
              baseUrl: "https://api.anthropic.com",
              models: [statusTestModel("claude-haiku-4-5", "Claude Haiku 4.5", 200_000)],
            },
          },
        },
      },
      agent: {
        model: "anthropic/claude-haiku-4-5",
        contextTokens: 200_000,
      },
      runtimeContextTokens: 1_000_000,
      sessionEntry: {
        sessionId: "runtime-alias-context",
        updatedAt: 0,
        modelProvider: "claude-cli",
        model: "claude-haiku-4-5",
        totalTokens: 36_000,
        totalTokensFresh: true,
      },
      sessionKey: "agent:main:main",
      sessionScope: "per-sender",
      queue: { mode: "collect", depth: 0 },
      modelAuth: "oauth",
      activeModelAuth: "oauth",
    });

    expect(text).toContain("Model: anthropic/claude-haiku-4-5");
    expect(text).toContain("Context: 36k/1.0m");
    expect(text).not.toContain("Context: 36k/200k");
  });
});
