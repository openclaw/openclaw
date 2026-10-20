import { describe, expect, it } from "vitest";
import { model as createModelFixture } from "../../agents/model-catalog-fixtures.test-support.js";
import { buildContextOverflowRecoveryText } from "./agent-runner-context-recovery.js";

function makeTestModel(id: string, contextTokens: number) {
  return createModelFixture(id, id, {
    contextWindow: contextTokens,
    contextTokens,
    maxTokens: 4096,
  });
}

const primary = { primaryProvider: "openrouter", primaryModel: "qwen3.6-plus" };
function heartbeatFixture(model = "qwen3.5-9b-32k:latest", cataloged = true) {
  return {
    ...primary,
    agentId: "agent",
    cfg: {
      models: {
        providers: {
          openrouter: {
            baseUrl: "https://openrouter.test",
            models: [makeTestModel(primary.primaryModel, 1_000_000)],
          },
          ...(cataloged && {
            ollama: { baseUrl: "http://ollama.test", models: [makeTestModel(model, 32_768)] },
          }),
        },
      },
      agents: { defaults: { heartbeat: { model: `ollama/${model}` } } },
    },
    activeSessionEntry: {
      sessionId: "session",
      updatedAt: 1,
      modelProvider: "ollama",
      model,
      contextTokens: 32_768,
    },
  };
}

describe("buildContextOverflowRecoveryText", () => {
  it("preserves the session with the built-in recovery hint without heartbeat model evidence", () => {
    const text = buildContextOverflowRecoveryText({
      cfg: {},
      ...primary,
    });

    expect(text).toContain("fresh session or using a model with a larger context window");
    expect(text).not.toContain("reserveTokensFloor");
    expect(text).not.toContain("heartbeat model bleed");
    expect(text).toContain("kept this conversation mapped to the current session");
    expect(text).not.toContain("reset our conversation");
  });

  it("does not use stale heartbeat hints for a different explicit runtime model", () => {
    const text = buildContextOverflowRecoveryText({
      ...heartbeatFixture(),
      cfg: { agents: { defaults: { heartbeat: { model: "ollama/qwen3.5-9b-32k:latest" } } } },
      runtimeProvider: "custom",
      runtimeModel: "uncataloged-32k",
    });

    expect(text).toContain("fresh session or using a model with a larger context window");
    expect(text).not.toContain("heartbeat model bleed");
  });

  it("points to heartbeat model bleed when the session model matches heartbeat.model", () => {
    const text = buildContextOverflowRecoveryText(heartbeatFixture());

    expect(text).toContain("ollama/qwen3.5-9b-32k:latest (32k context)");
    expect(text).toContain("openrouter/qwen3.6-plus");
    expect(text).toContain("heartbeat model bleed");
    expect(text).toContain("heartbeat.isolatedSession");
  });

  it("uses the stored context window for an uncataloged heartbeat model", () => {
    const text = buildContextOverflowRecoveryText(heartbeatFixture("custom-32k", false));

    expect(text).toContain("ollama/custom-32k (32k context)");
    expect(text).not.toContain("ollama/custom-32k (98k context)");
    expect(text).toContain("heartbeat model bleed");
  });
});
