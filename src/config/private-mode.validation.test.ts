import { describe, expect, it } from "vitest";
import { validateConfigObject, validateConfigObjectRaw } from "./validation.js";

describe("privateMode validation", () => {
  it("accepts the privateMode schema in raw validation", () => {
    const result = validateConfigObjectRaw({
      privateMode: {
        enabled: true,
        localOnly: {
          allowedProviders: ["ollama"],
        },
        embeddings: {
          provider: "local",
          allowFtsFallback: true,
        },
        filesystem: {
          allowedRoots: ["/data/proprietary"],
          workspaceAccessDefault: "none",
          blockAbsolutePaths: true,
        },
        execution: {
          disableElevatedExec: true,
          sandboxMode: "all",
          blockHostExec: true,
        },
        skills: {
          disableAll: false,
          allowlist: ["core:memory"],
          blockEnvInjection: true,
        },
        audit: {
          enabled: true,
          logPath: "~/.openclaw/audit",
          logPromptSources: true,
          logFileReads: true,
          logModelCalls: true,
          redactContent: true,
        },
      },
      agents: {
        defaults: {
          model: "ollama/qwen3:8b",
          memorySearch: {
            provider: "local",
            fallback: "none",
          },
        },
      },
      models: {
        providers: {
          ollama: {
            baseUrl: "http://127.0.0.1:11434/v1",
            models: [
              {
                id: "qwen3:8b",
                name: "qwen3:8b",
                reasoning: true,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 131072,
                maxTokens: 8192,
              },
            ],
          },
        },
      },
    });

    expect(result.ok).toBe(true);
  });

  it("fails closed on the default remote model when privateMode is enabled", () => {
    const result = validateConfigObject({
      privateMode: {
        enabled: true,
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "agents.defaults.model",
        }),
      ]),
    );
    expect(result.issues[0]?.message).toContain("disallowed provider");
    expect(result.issues[0]?.message).toContain("anthropic");
  });

  it("accepts explicit local-only model and embeddings config", () => {
    const result = validateConfigObject({
      privateMode: {
        enabled: true,
        localOnly: {
          allowedProviders: ["ollama"],
        },
        embeddings: {
          provider: "local",
        },
      },
      agents: {
        defaults: {
          model: "ollama/qwen3:8b",
          memorySearch: {
            provider: "local",
            fallback: "none",
          },
        },
      },
      models: {
        providers: {
          ollama: {
            baseUrl: "http://127.0.0.1:11434/v1",
            models: [
              {
                id: "qwen3:8b",
                name: "qwen3:8b",
                reasoning: true,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 131072,
                maxTokens: 8192,
              },
            ],
          },
        },
      },
    });

    expect(result.ok).toBe(true);
  });

  it("rejects explicitly configured remote model providers in privateMode", () => {
    const result = validateConfigObject({
      privateMode: {
        enabled: true,
        localOnly: {
          allowedProviders: ["ollama"],
        },
      },
      agents: {
        defaults: {
          model: "ollama/qwen3:8b",
        },
      },
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            models: [
              {
                id: "gpt-5.4",
                name: "gpt-5.4",
                reasoning: true,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 128000,
                maxTokens: 8192,
              },
            ],
          },
        },
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "models.providers.openai",
        }),
      ]),
    );
  });

  it("rejects remote memorySearch providers in privateMode", () => {
    const result = validateConfigObject({
      privateMode: {
        enabled: true,
      },
      agents: {
        defaults: {
          model: "ollama/qwen3:8b",
          memorySearch: {
            provider: "openai",
            fallback: "openai",
          },
        },
      },
      models: {
        providers: {
          ollama: {
            baseUrl: "http://127.0.0.1:11434/v1",
            models: [
              {
                id: "qwen3:8b",
                name: "qwen3:8b",
                reasoning: true,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 131072,
                maxTokens: 8192,
              },
            ],
          },
        },
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "agents.defaults.memorySearch.provider" }),
        expect.objectContaining({ path: "agents.defaults.memorySearch.fallback" }),
      ]),
    );
  });
});
