// Status summary runtime tests cover model context-token resolution.
import { describe, expect, it } from "vitest";
import { migratePersistedImplicitMainRoster } from "../config/legacy.roster.js";
import { statusSummaryRuntime } from "../status/summary.runtime.js";

function resolveSessionRuntime(
  params: Parameters<typeof statusSummaryRuntime.resolveSessionRuntime>[0],
) {
  return statusSummaryRuntime.resolveSessionRuntime({
    ...params,
    cfg: migratePersistedImplicitMainRoster(params.cfg).config as never,
  });
}

describe("statusSummaryRuntime.resolveContextTokensForModel", () => {
  it("uses prepared static catalog metadata with a cold cache", () => {
    expect(
      statusSummaryRuntime.resolveContextTokensForModel({
        cfg: {},
        provider: "openai",
        model: "gpt-5.5",
        modelContextWindow: 1_000_000,
        modelContextTokens: 272_000,
        fallbackContextTokens: 200_000,
      }),
    ).toBe(272_000);
  });

  it("matches self-prefixed configured ids through provider ownership", () => {
    expect(
      statusSummaryRuntime.resolveContextTokensForModel({
        cfg: {
          models: {
            providers: {
              "google-gemini-cli": {
                models: [
                  {
                    id: "google-gemini-cli/gemini-3.1-pro-preview",
                    contextTokens: 1_000_000,
                  },
                ],
              },
            },
          },
        } as never,
        provider: "google-gemini-cli",
        model: "gemini-3.1-pro-preview",
      }),
    ).toBe(1_000_000);
  });
});

describe("statusSummaryRuntime.classifySessionKey", () => {
  it("classifies cron history sessions distinctly", () => {
    expect(statusSummaryRuntime.classifySessionKey("agent:main:cron:daily-digest")).toBe("cron");
    expect(
      statusSummaryRuntime.classifySessionKey("agent:avery:cron:daily-digest:run:abc123"),
    ).toBe("cron");
  });
});

describe("statusSummaryRuntime.resolveSessionRuntime", () => {
  it("uses the shared /status runtime label for the implicit OpenAI Codex route", () => {
    expect(
      resolveSessionRuntime({
        cfg: {} as never,
        entry: {
          sessionId: "session-1",
          updatedAt: 0,
        },
        provider: "openai",
        model: "gpt-5.5",
        sessionKey: "agent:main:main",
      }),
    ).toEqual({ id: "codex", label: "OpenAI Codex" });
  });

  it("preserves configured default model CLI runtimes", () => {
    expect(
      resolveSessionRuntime({
        cfg: {
          agents: {
            defaults: {
              models: {
                "anthropic/claude-sonnet-4-6": { agentRuntime: { id: "claude-cli" } },
              },
            },
          },
        } as never,
        entry: {
          sessionId: "session-1",
          updatedAt: 0,
        },
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        sessionKey: "agent:main:main",
      }),
    ).toEqual({ id: "claude-cli", label: "Claude CLI" });
  });

  it("preserves configured agent model runtimes before harness selection", () => {
    expect(
      resolveSessionRuntime({
        cfg: {
          agents: {
            defaults: {
              models: {
                "openai/gpt-5.5": { agentRuntime: { id: "openclaw" } },
              },
            },
            list: [
              {
                id: "research",
                models: {
                  "openai/gpt-5.5": { agentRuntime: { id: "codex" } },
                },
              },
            ],
          },
        } as never,
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
      resolveSessionRuntime({
        cfg: {
          agents: {
            defaults: {
              models: {
                "openai/gpt-5.5": { agentRuntime: { id: "codex" } },
              },
            },
          },
        } as never,
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
      resolveSessionRuntime({
        cfg: {
          agents: {
            defaults: {
              models: {
                "openai/gpt-5.5": { agentRuntime: { id: "openclaw" } },
              },
            },
          },
        } as never,
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
});

describe("statusSummaryRuntime.resolveSessionModelRef", () => {
  const configured = { provider: "anthropic", model: "claude-sonnet-4-6" };

  it("preserves explicit runtime providers for vendor-prefixed model ids", () => {
    expect(
      statusSummaryRuntime.resolveSessionModelRef(configured, {
        modelProvider: "openrouter",
        model: "anthropic/claude-haiku-4.5",
      }),
    ).toEqual({
      provider: "openrouter",
      model: "anthropic/claude-haiku-4.5",
    });
  });

  it("splits legacy combined overrides when provider is missing", () => {
    expect(
      statusSummaryRuntime.resolveSessionModelRef(configured, {
        modelOverride: "ollama-beelink2/qwen2.5-coder:7b",
      }),
    ).toEqual({
      provider: "ollama-beelink2",
      model: "qwen2.5-coder:7b",
    });
  });

  it("uses the configured default provider for providerless runtime models", () => {
    expect(
      statusSummaryRuntime.resolveSessionModelRef(
        { provider: "openai", model: "gpt-5.5" },
        {
          model: "gpt-5.5",
        },
      ),
    ).toEqual({
      provider: "openai",
      model: "gpt-5.5",
    });
  });

  it("prefers explicit overrides ahead of fallback runtime fields", () => {
    expect(
      statusSummaryRuntime.resolveSessionModelRef(configured, {
        providerOverride: "openai",
        modelOverride: "gpt-5.4",
        modelProvider: "amazon-bedrock",
        model: "minimax.minimax-m2.5",
      }),
    ).toEqual({
      provider: "openai",
      model: "gpt-5.4",
    });
  });

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
