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
  it("uses the built-in recovery hint without heartbeat model evidence", () => {
    const text = buildContextOverflowRecoveryText({
      cfg: {},
      primaryProvider: "openrouter",
      primaryModel: "qwen3.6-plus",
    });

    expect(text).toContain("fresh session or using a model with a larger context window");
    expect(text).not.toContain("reserveTokensFloor");
    expect(text).not.toContain("heartbeat model bleed");
  });

  it("warns about deletion before recommending mechanical compaction", () => {
    const text = buildContextOverflowRecoveryText({
      duringCompaction: true,
      preserveSessionMapping: true,
      cfg: {},
      agentId: "main",
      sessionKey: "agent:main:main",
      primaryProvider: "openrouter",
      primaryModel: "qwen3.6-plus",
    });

    expect(text).toContain("kept this conversation mapped to the current session");
    expect(text).not.toContain("reset our conversation");
    expect(text).not.toContain("use /compact");
    expect(text).not.toContain("use /new");
    expect(text).not.toContain("fresh session");
    expect(text).not.toContain("cannot help here");
    expect(text).toContain("permanently deletes older history and keeps no backup");
    expect(text).toContain("openclaw backup create");
    expect(text).toContain(
      "openclaw sessions compact 'agent:main:main' --agent 'main' --max-lines 200",
    );
    expect(text.indexOf("permanently deletes")).toBeLessThan(
      text.indexOf("openclaw sessions compact"),
    );
  });

  it("quotes Matrix thread keys so dollar segments survive shell expansion", () => {
    const key = "agent:main:matrix:channel:!ops:example.org:thread:$RootEvent:Example.Org";
    const text = buildContextOverflowRecoveryText({
      preserveSessionMapping: true,
      sessionKey: key,
      agentId: "main",
      cfg: {},
    });

    expect(text).toContain(`openclaw sessions compact '${key}' --agent 'main' --max-lines 200`);
    expect(text).not.toContain(`"${key}"`);
  });

  it("falls back to a placeholder compact command when the session key is unknown", () => {
    const text = buildContextOverflowRecoveryText({
      preserveSessionMapping: true,
      cfg: {},
      primaryProvider: "openrouter",
      primaryModel: "qwen3.6-plus",
    });

    expect(text).not.toContain("use /compact");
    expect(text).not.toContain("use /new");
    expect(text).not.toContain("fresh session");
    expect(text).not.toContain("cannot help here");
    expect(text).toContain("permanently deletes older history and keeps no backup");
    expect(text).toContain("openclaw backup create");
    expect(text).toContain("openclaw sessions compact '<session-key>' --max-lines 200");
    expect(text.indexOf("permanently deletes")).toBeLessThan(
      text.indexOf("openclaw sessions compact"),
    );
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

    expect(text).toContain("fresh session or using a model with a larger context window");
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
