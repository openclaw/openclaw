import { describe, expect, it } from "vitest";
import { resolveAgentHarnessPolicy } from "../../agents/harness/policy.js";
import { resolveDefaultModelForAgent } from "../../agents/model-selection.js";
import { normalizeSessionStore } from "./store-load.js";
import type { SessionEntry } from "./types.js";

function normalizeOne(sessionKey: string, entry: Partial<SessionEntry>): SessionEntry | undefined {
  const store = {
    [sessionKey]: {
      sessionId: entry.sessionId ?? "session-1",
      updatedAt: entry.updatedAt ?? 1,
      ...entry,
    } as SessionEntry,
  };
  normalizeSessionStore(store);
  return store[sessionKey];
}

describe("session execution-state persistence scope", () => {
  it("strips lifecycle and reply-turn fields from Telegram topic sessions", () => {
    const entry = normalizeOne("agent:openclaw:telegram:group:-1001:thread:2", {
      status: "running",
      startedAt: 10,
      endedAt: 20,
      runtimeMs: 10,
      abortedLastRun: true,
      replyTurnState: "running",
      replyTurnStartedAt: 11,
      replyTurnUpdatedAt: 12,
      replyTurnRunId: "run-1",
      replyTurnLastError: "timeout",
      chatType: "group",
      channel: "telegram",
    });

    expect(entry?.status).toBeUndefined();
    expect(entry?.startedAt).toBeUndefined();
    expect(entry?.endedAt).toBeUndefined();
    expect(entry?.runtimeMs).toBeUndefined();
    expect(entry?.abortedLastRun).toBeUndefined();
    expect(entry?.replyTurnState).toBeUndefined();
    expect(entry?.replyTurnStartedAt).toBeUndefined();
    expect(entry?.replyTurnUpdatedAt).toBeUndefined();
    expect(entry?.replyTurnRunId).toBeUndefined();
    expect(entry?.replyTurnLastError).toBeUndefined();
  });

  it("strips auto fallback pins and cached runtime model fields from Telegram topic sessions", () => {
    const entry = normalizeOne("agent:founder:telegram:group:-1001:thread:55", {
      providerOverride: "openai-codex",
      modelOverride: "gpt-5.4",
      modelOverrideSource: "auto",
      modelOverrideFallbackOriginProvider: "openai",
      modelOverrideFallbackOriginModel: "gpt-5.5",
      modelProvider: "openai-codex",
      model: "gpt-5.4",
      fallbackNoticeSelectedModel: "openai/gpt-5.5",
      fallbackNoticeActiveModel: "openai-codex/gpt-5.4",
      fallbackNoticeReason: "auth",
      authProfileOverride: "openai-codex:default",
      authProfileOverrideSource: "auto",
      authProfileOverrideCompactionCount: 2,
    });

    expect(entry?.providerOverride).toBeUndefined();
    expect(entry?.modelOverride).toBeUndefined();
    expect(entry?.modelOverrideSource).toBeUndefined();
    expect(entry?.modelOverrideFallbackOriginProvider).toBeUndefined();
    expect(entry?.modelOverrideFallbackOriginModel).toBeUndefined();
    expect(entry?.modelProvider).toBeUndefined();
    expect(entry?.model).toBeUndefined();
    expect(entry?.fallbackNoticeSelectedModel).toBeUndefined();
    expect(entry?.fallbackNoticeActiveModel).toBeUndefined();
    expect(entry?.fallbackNoticeReason).toBeUndefined();
    expect(entry?.authProfileOverride).toBeUndefined();
    expect(entry?.authProfileOverrideSource).toBeUndefined();
    expect(entry?.authProfileOverrideCompactionCount).toBeUndefined();
  });

  it("lets recovered Telegram topics fall back to the configured OpenAI default with Codex runtime", () => {
    const sessionKey = "agent:openclaw:telegram:group:-1001:thread:2";
    const entry = normalizeOne(sessionKey, {
      providerOverride: "openai-codex",
      modelOverride: "gpt-5.4",
      modelOverrideSource: "auto",
      modelProvider: "openai-codex",
      model: "gpt-5.4",
    });
    const cfg = {
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.5" },
        },
      },
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            models: [],
          },
        },
      },
    };

    const selected = entry?.modelOverride
      ? { provider: entry.providerOverride ?? "openai", model: entry.modelOverride }
      : resolveDefaultModelForAgent({ cfg, agentId: "openclaw" });
    const runtime = resolveAgentHarnessPolicy({
      provider: selected.provider,
      modelId: selected.model,
      config: cfg,
      agentId: "openclaw",
      sessionKey,
    });

    expect(selected).toEqual({ provider: "openai", model: "gpt-5.5" });
    expect(runtime.runtime).toBe("codex");
  });

  it("preserves explicit user model overrides on Telegram topic sessions", () => {
    const entry = normalizeOne("agent:medic:telegram:group:-1001:thread:7", {
      providerOverride: "anthropic",
      modelOverride: "claude-sonnet-4-6",
      modelOverrideSource: "user",
    });

    expect(entry?.providerOverride).toBe("anthropic");
    expect(entry?.modelOverride).toBe("claude-sonnet-4-6");
    expect(entry?.modelOverrideSource).toBe("user");
  });

  it.each([
    "agent:openclaw:subagent:abc",
    "agent:openclaw:acp:codex:project",
    "agent:openclaw:cron:health:run:20260518",
  ])("preserves lifecycle and fallback state for internal execution session %s", (sessionKey) => {
    const entry = normalizeOne(sessionKey, {
      status: "running",
      startedAt: 10,
      runtimeMs: 5,
      abortedLastRun: true,
      replyTurnState: "running",
      providerOverride: "openai-codex",
      modelOverride: "gpt-5.4",
      modelOverrideSource: "auto",
      modelProvider: "openai-codex",
      model: "gpt-5.4",
      fallbackNoticeActiveModel: "openai-codex/gpt-5.4",
      fallbackNoticeReason: "rate-limit",
    });

    expect(entry?.status).toBe("running");
    expect(entry?.startedAt).toBe(10);
    expect(entry?.runtimeMs).toBe(5);
    expect(entry?.abortedLastRun).toBe(true);
    expect(entry?.replyTurnState).toBe("running");
    expect(entry?.providerOverride).toBe("openai-codex");
    expect(entry?.modelOverride).toBe("gpt-5.4");
    expect(entry?.modelOverrideSource).toBe("auto");
    expect(entry?.modelProvider).toBe("openai-codex");
    expect(entry?.model).toBe("gpt-5.4");
    expect(entry?.fallbackNoticeActiveModel).toBe("openai-codex/gpt-5.4");
    expect(entry?.fallbackNoticeReason).toBe("rate-limit");
  });
});
