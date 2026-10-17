import { describe, expect, it } from "vitest";
import type { ModelDefinitionConfig } from "../../config/types.models.js";
import { buildContextOverflowRecoveryText } from "./agent-runner-context-recovery.js";

function makeTestModel(id: string, contextTokens: number): ModelDefinitionConfig {
  return {
    id,
    name: id,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: contextTokens,
    contextTokens,
    maxTokens: 4096,
  };
}

describe("buildContextOverflowRecoveryText", () => {
  it("replaces the failed /compact advice with a warned, session-specific trim command", () => {
    const text = buildContextOverflowRecoveryText({
      cfg: {},
      agentId: "main",
      sessionKey: "agent:main:main",
      primaryProvider: "openrouter",
      primaryModel: "qwen3.6-plus",
    });

    expect(text).toContain("kept this conversation mapped to the current session");
    expect(text).not.toContain("/compact");
    const warningAt = text.indexOf("permanently deletes older history and keeps no backup");
    const backupAt = text.indexOf("`openclaw backup create`");
    const commandAt = text.indexOf(
      "`openclaw sessions compact agent:main:main --agent main --max-lines 200`",
    );
    expect(warningAt).toBeGreaterThan(-1);
    expect(backupAt).toBeGreaterThan(warningAt);
    expect(commandAt).toBeGreaterThan(backupAt);
  });

  it("labels shell-specific forms for keys that need quoting", () => {
    const key = "agent:main:matrix:channel:!ops:example.org:thread:$RootEvent:Example.Org";
    const text = buildContextOverflowRecoveryText({ cfg: {}, agentId: "main", sessionKey: key });

    expect(text).toContain(
      `then \`openclaw sessions compact '${key}' --agent main --max-lines 200\` (macOS, Linux, or PowerShell)` +
        ` or \`openclaw sessions compact "${key}" --agent main --max-lines 200\` (Windows Command Prompt).`,
    );
  });

  it("shows a key placeholder when the session key is unknown", () => {
    const text = buildContextOverflowRecoveryText({ cfg: {} });

    expect(text).toContain("`openclaw sessions compact <session-key> --max-lines 200`");
  });

  it("does not use stale heartbeat hints for a different explicit runtime model", () => {
    const text = buildContextOverflowRecoveryText({
      cfg: {
        agents: {
          defaults: {
            heartbeat: { model: "ollama/qwen3.5-9b-32k:latest" },
          },
        },
      },
      primaryProvider: "openrouter",
      primaryModel: "qwen3.6-plus",
      runtimeProvider: "custom",
      runtimeModel: "uncataloged-32k",
      activeSessionEntry: {
        sessionId: "session",
        updatedAt: 1,
        modelProvider: "ollama",
        model: "qwen3.5-9b-32k:latest",
        contextTokens: 32_768,
      },
    });

    expect(text).toContain("Try a model with a larger context window.");
    expect(text).not.toContain("heartbeat model bleed");
  });

  it("points to heartbeat model bleed when the session model matches heartbeat.model", () => {
    const text = buildContextOverflowRecoveryText({
      cfg: {
        models: {
          providers: {
            openrouter: {
              baseUrl: "https://openrouter.test",
              models: [makeTestModel("qwen3.6-plus", 1_000_000)],
            },
            ollama: {
              baseUrl: "http://ollama.test",
              models: [makeTestModel("qwen3.5-9b-32k:latest", 32_768)],
            },
          },
        },
        agents: {
          defaults: {
            heartbeat: { model: "ollama/qwen3.5-9b-32k:latest" },
          },
        },
      },
      agentId: "agent",
      primaryProvider: "openrouter",
      primaryModel: "qwen3.6-plus",
      activeSessionEntry: {
        sessionId: "session",
        updatedAt: 1,
        modelProvider: "ollama",
        model: "qwen3.5-9b-32k:latest",
        contextTokens: 32_768,
      },
    });

    expect(text).toContain("ollama/qwen3.5-9b-32k:latest (32k context)");
    expect(text).toContain("openrouter/qwen3.6-plus");
    expect(text).toContain("heartbeat model bleed");
    expect(text).toContain("heartbeat.isolatedSession");
    expect(text).toContain(
      "`openclaw sessions compact <session-key> --agent agent --max-lines 200`",
    );
  });

  it("uses the stored context window for an uncataloged heartbeat model", () => {
    const text = buildContextOverflowRecoveryText({
      cfg: {
        models: {
          providers: {
            openrouter: {
              baseUrl: "https://openrouter.test",
              models: [makeTestModel("qwen3.6-plus", 1_000_000)],
            },
          },
        },
        agents: {
          defaults: {
            heartbeat: { model: "ollama/custom-32k" },
          },
        },
      },
      agentId: "agent",
      primaryProvider: "openrouter",
      primaryModel: "qwen3.6-plus",
      activeSessionEntry: {
        sessionId: "session",
        updatedAt: 1,
        modelProvider: "ollama",
        model: "custom-32k",
        contextTokens: 32_768,
      },
    });

    expect(text).toContain("ollama/custom-32k (32k context)");
    expect(text).not.toContain("ollama/custom-32k (98k context)");
    expect(text).toContain("heartbeat model bleed");
  });
});
