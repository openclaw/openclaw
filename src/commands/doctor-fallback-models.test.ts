import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the model catalog before importing the module under test.
vi.mock("../agents/model-catalog.js", () => ({
  loadModelCatalog: vi.fn().mockResolvedValue([
    { id: "claude-opus-4-6", name: "Claude Opus 4.6", provider: "anthropic" },
    { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", provider: "anthropic" },
    { id: "gpt-5.3", name: "GPT-5.3", provider: "openai" },
    { id: "gemini-3-flash-preview", name: "Gemini 3 Flash", provider: "google" },
  ]),
}));

// Capture note() calls to verify output.
const noteCalls: Array<{ message: string; title: string }> = [];
vi.mock("../terminal/note.js", () => ({
  note: (message: string, title: string) => {
    noteCalls.push({ message, title });
  },
}));

import type { OpenClawConfig } from "../config/config.js";
import { noteFallbackModelHealth } from "./doctor-fallback-models.js";

describe("noteFallbackModelHealth", () => {
  beforeEach(() => {
    noteCalls.length = 0;
  });

  it("emits no note when there are no fallbacks configured", async () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-opus-4-6" },
        },
      },
    };
    await noteFallbackModelHealth(cfg);
    expect(noteCalls).toHaveLength(0);
  });

  it("emits no note when all fallback providers are in the catalog", async () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          model: {
            primary: "anthropic/claude-opus-4-6",
            fallbacks: ["openai/gpt-5.3", "google/gemini-3-flash-preview"],
          },
        },
      },
    };
    await noteFallbackModelHealth(cfg);
    expect(noteCalls).toHaveLength(0);
  });

  it("emits no note when fallback provider is in models.providers", async () => {
    const cfg: OpenClawConfig = {
      models: {
        providers: {
          "kimi-coding": {
            baseUrl: "https://api.kimi.example.com",
            apiKey: "test-key",
            models: [
              {
                id: "k2p5",
                name: "K2P5",
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 128000,
                maxTokens: 8192,
              },
            ],
          },
        },
      },
      agents: {
        defaults: {
          model: {
            primary: "anthropic/claude-opus-4-6",
            fallbacks: ["kimi-coding/k2p5"],
          },
        },
      },
    };
    await noteFallbackModelHealth(cfg);
    expect(noteCalls).toHaveLength(0);
  });

  it("emits a warning when fallback provider is undefined", async () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          model: {
            primary: "anthropic/claude-opus-4-6",
            fallbacks: ["kimi-coding/k2p5"],
          },
        },
      },
    };
    await noteFallbackModelHealth(cfg);
    expect(noteCalls).toHaveLength(1);
    expect(noteCalls[0].title).toBe("Fallback models");
    expect(noteCalls[0].message).toContain("kimi-coding");
    expect(noteCalls[0].message).toContain("agents.defaults.model.fallbacks");
  });

  it("reports multiple undefined providers", async () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          model: {
            primary: "anthropic/claude-opus-4-6",
            fallbacks: ["kimi-coding/k2p5", "deepseek/chat-v3"],
          },
        },
      },
    };
    await noteFallbackModelHealth(cfg);
    expect(noteCalls).toHaveLength(1);
    expect(noteCalls[0].message).toContain("kimi-coding");
    expect(noteCalls[0].message).toContain("deepseek");
  });

  it("checks imageModel fallbacks", async () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          imageModel: {
            primary: "openai/gpt-5.3",
            fallbacks: ["unknown-provider/some-model"],
          },
        },
      },
    };
    await noteFallbackModelHealth(cfg);
    expect(noteCalls).toHaveLength(1);
    expect(noteCalls[0].message).toContain("unknown-provider");
    expect(noteCalls[0].message).toContain("agents.defaults.imageModel.fallbacks");
  });

  it("checks per-agent fallbacks", async () => {
    const cfg: OpenClawConfig = {
      agents: {
        list: [
          {
            id: "my-agent",
            model: {
              primary: "anthropic/claude-opus-4-6",
              fallbacks: ["missing-provider/model-x"],
            },
          },
        ],
      },
    };
    await noteFallbackModelHealth(cfg);
    expect(noteCalls).toHaveLength(1);
    expect(noteCalls[0].message).toContain("missing-provider");
    expect(noteCalls[0].message).toContain("my-agent");
  });

  it("checks per-agent subagent fallbacks", async () => {
    const cfg: OpenClawConfig = {
      agents: {
        list: [
          {
            id: "worker",
            subagents: {
              model: {
                primary: "anthropic/claude-sonnet-4-5",
                fallbacks: ["no-such-provider/model-y"],
              },
            },
          },
        ],
      },
    };
    await noteFallbackModelHealth(cfg);
    expect(noteCalls).toHaveLength(1);
    expect(noteCalls[0].message).toContain("no-such-provider");
    expect(noteCalls[0].message).toContain("worker");
    expect(noteCalls[0].message).toContain("subagents.model.fallbacks");
  });

  it("deduplicates identical fallback refs", async () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          model: {
            primary: "anthropic/claude-opus-4-6",
            fallbacks: ["unknown/model-a"],
          },
          imageModel: {
            primary: "openai/gpt-5.3",
            fallbacks: ["unknown/model-a"],
          },
        },
      },
    };
    await noteFallbackModelHealth(cfg);
    expect(noteCalls).toHaveLength(1);
    // Should only report once despite appearing in two places
    const warningLines = noteCalls[0].message.split("\n").filter((l) => l.startsWith("- "));
    expect(warningLines).toHaveLength(1);
  });

  it("recognizes CLI backends as valid providers", async () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          cliBackends: {
            "my-cli": { command: "my-cli-agent" },
          },
          model: {
            primary: "anthropic/claude-opus-4-6",
            fallbacks: ["my-cli/default"],
          },
        },
      },
    };
    await noteFallbackModelHealth(cfg);
    expect(noteCalls).toHaveLength(0);
  });
});
