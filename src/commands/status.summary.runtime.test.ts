import { describe, expect, it } from "vitest";
import { statusSummaryRuntime } from "../status/summary.runtime.js";

function runtimeConfig(id: "codex" | "openclaw") {
  return { agents: { defaults: { models: { "openai/gpt-5.5": { agentRuntime: { id } } } } } };
}

describe("statusSummaryRuntime", () => {
  it("classifies cron history sessions distinctly", () => {
    expect(statusSummaryRuntime.classifySessionKey("agent:main:cron:daily-digest")).toBe("cron");
    expect(
      statusSummaryRuntime.classifySessionKey("agent:avery:cron:daily-digest:run:abc123"),
    ).toBe("cron");
  });

  it("preserves configured agent model runtimes before harness selection", () => {
    expect(
      statusSummaryRuntime.resolveSessionRuntime({
        cfg: {
          agents: {
            ...runtimeConfig("openclaw").agents,
            entries: {
              research: {
                models: {
                  "openai/gpt-5.5": { agentRuntime: { id: "codex" } },
                },
              },
            },
          },
        },
        entry: {
          sessionId: "session-1",
          updatedAt: 0,
        },
        provider: "openai",
        model: "gpt-5.5",
        agentId: "research",
        sessionKey: "agent:research:main",
      }),
    ).toEqual({ id: "codex", label: "OpenAI Codex" });
  });

  it("does not treat an unlocked producing harness as the current runtime", () => {
    expect(
      statusSummaryRuntime.resolveSessionRuntime({
        cfg: runtimeConfig("codex"),
        entry: {
          sessionId: "openclaw-produced-session",
          updatedAt: 0,
          agentHarnessId: "openclaw",
        },
        provider: "openai",
        model: "gpt-5.5",
        sessionKey: "agent:main:main",
      }),
    ).toEqual({ id: "codex", label: "OpenAI Codex (previous runtime: OpenClaw Default)" });
  });

  it("reports the owning Codex harness for a locked session with stale OpenClaw metadata", () => {
    expect(
      statusSummaryRuntime.resolveSessionRuntime({
        cfg: runtimeConfig("openclaw"),
        entry: {
          sessionId: "locked-codex-session",
          updatedAt: 0,
          agentHarnessId: "codex",
          agentRuntimeOverride: "openclaw",
          modelSelectionLocked: true,
        },
        provider: "openai",
        model: "gpt-5.5",
        sessionKey: "agent:main:main",
      }),
    ).toEqual({ id: "codex", label: "OpenAI Codex" });
  });

  const configured = { provider: "anthropic", model: "claude-sonnet-4-6" };

  it("falls back to configured defaults when persisted session model fields are malformed", () => {
    expect(
      statusSummaryRuntime.resolveSessionModelRef(configured, {
        modelProvider: { provider: "openai" },
        model: false,
        providerOverride: ["anthropic"],
        modelOverride: 123,
      } as never),
    ).toEqual({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
    });
  });
});
