// Control UI tests cover chat model select state behavior.
import { describe, expect, it } from "vitest";
import {
  resolveChatModelOverrideValue,
  resolveChatModelSelectState,
} from "./chat-model-select-state.ts";
import {
  createModelCatalog,
  createSessionsListResult,
  DEEPSEEK_CHAT_MODEL,
  DEFAULT_CHAT_MODEL_CATALOG,
} from "./chat-model.test-helpers.ts";

type ChatModelStateInput = Parameters<typeof resolveChatModelSelectState>[0];

function createChatModelState(
  params: Partial<Omit<ChatModelStateInput, "sessionKey">> = {},
): ChatModelStateInput {
  return {
    sessionKey: "main",
    chatModelOverrides: {},
    chatModelSwitchPromises: {},
    chatModelCatalog: [],
    sessionsResult: createSessionsListResult({ model: null, modelProvider: null }),
    ...params,
  };
}

describe("chat-model-select-state", () => {
  it("uses the server-qualified value when the active session provider is present", () => {
    const state = createChatModelState({
      chatModelCatalog: createModelCatalog(DEEPSEEK_CHAT_MODEL),
      sessionsResult: createSessionsListResult({
        model: "deepseek-chat",
        modelProvider: "deepseek",
      }),
    });

    expect(resolveChatModelOverrideValue(state)).toBe("deepseek/deepseek-chat");
  });

  it("falls back to the server-qualified value when catalog lookup fails", () => {
    const state = createChatModelState({
      sessionsResult: createSessionsListResult({
        model: "gpt-5-mini",
        modelProvider: "openai",
      }),
    });

    expect(resolveChatModelOverrideValue(state)).toBe("openai/gpt-5-mini");
  });

  it("normalizes cached bare overrides to the matching catalog option", () => {
    const state = createChatModelState({
      chatModelOverrides: { main: { kind: "raw", value: "gpt-5-mini" } },
      chatModelCatalog: createModelCatalog(...DEFAULT_CHAT_MODEL_CATALOG),
    });

    const resolved = resolveChatModelSelectState(state);
    expect(resolved.currentOverride).toBe("openai/gpt-5-mini");
    expect(resolved.options).toEqual([
      { value: "openai/gpt-5", label: "GPT-5" },
      { value: "openai/gpt-5-mini", label: "GPT-5 Mini" },
    ]);
  });

  it("prefers catalog provider matches over stale session providers", () => {
    const state = createChatModelState({
      chatModelCatalog: createModelCatalog(DEEPSEEK_CHAT_MODEL),
      sessionsResult: createSessionsListResult({
        model: "deepseek-chat",
        modelProvider: "zai",
      }),
    });

    expect(resolveChatModelSelectState(state).currentOverride).toBe("deepseek/deepseek-chat");
  });

  it("preserves already-qualified active-session models when the provider is stale and the catalog is empty", () => {
    const state = createChatModelState({
      sessionsResult: createSessionsListResult({
        model: "openai/gpt-5-mini",
        modelProvider: "zai",
      }),
    });

    const resolved = resolveChatModelSelectState(state);
    expect(resolved.currentOverride).toBe("openai/gpt-5-mini");
    expect(resolved.options).toEqual([
      { value: "openai/gpt-5-mini", label: "gpt-5-mini · openai" },
      { value: "openai/gpt-5", label: "gpt-5 · openai" },
    ]);
  });

  it("builds picker options without introducing a bare duplicate", () => {
    const state = createChatModelState({
      chatModelCatalog: createModelCatalog(...DEFAULT_CHAT_MODEL_CATALOG),
      sessionsResult: createSessionsListResult({
        model: "gpt-5-mini",
        modelProvider: "openai",
      }),
    });

    const resolved = resolveChatModelSelectState(state);
    expect(resolved.currentOverride).toBe("openai/gpt-5-mini");
    expect(resolved.options).toEqual([
      { value: "openai/gpt-5", label: "GPT-5" },
      { value: "openai/gpt-5-mini", label: "GPT-5 Mini" },
    ]);
  });

  it("uses catalog names for the default label and matching picker options", () => {
    const state = createChatModelState({
      chatModelCatalog: createModelCatalog({
        id: "moonshotai/kimi-k2.5",
        alias: "Kimi K2.5 (NVIDIA)",
        name: "Kimi K2.5 (NVIDIA)",
        provider: "nvidia",
      }),
      sessionsResult: createSessionsListResult({
        model: "moonshotai/kimi-k2.5",
        modelProvider: "nvidia",
        defaultsModel: "moonshotai/kimi-k2.5",
        defaultsProvider: "nvidia",
      }),
    });

    const resolved = resolveChatModelSelectState(state);
    expect(resolved.currentOverride).toBe("nvidia/moonshotai/kimi-k2.5");
    expect(resolved.defaultLabel).toBe("Default (Kimi K2.5 (NVIDIA))");
    expect(resolved.options).toEqual([
      {
        value: "nvidia/moonshotai/kimi-k2.5",
        label: "Kimi K2.5 (NVIDIA)",
      },
    ]);
  });

  it("disambiguates duplicate friendly names in picker options and default labels", () => {
    const state = createChatModelState({
      chatModelCatalog: createModelCatalog(
        {
          id: "claude-3-7-sonnet",
          name: "Claude Sonnet",
          provider: "anthropic",
        },
        {
          id: "claude-3-7-sonnet",
          name: "Claude Sonnet",
          provider: "openrouter",
        },
      ),
      sessionsResult: createSessionsListResult({
        model: "claude-3-7-sonnet",
        modelProvider: "anthropic",
        defaultsModel: "claude-3-7-sonnet",
        defaultsProvider: "openrouter",
      }),
    });

    const resolved = resolveChatModelSelectState(state);
    expect(resolved.currentOverride).toBe("anthropic/claude-3-7-sonnet");
    expect(resolved.defaultLabel).toBe("Default (Claude Sonnet · openrouter)");
    expect(resolved.options).toEqual([
      {
        value: "anthropic/claude-3-7-sonnet",
        label: "Claude Sonnet · anthropic",
      },
      {
        value: "openrouter/claude-3-7-sonnet",
        label: "Claude Sonnet · openrouter",
      },
    ]);
  });

  it("falls back to id and provider when duplicate names share the same provider", () => {
    const state = createChatModelState({
      chatModelCatalog: createModelCatalog(
        {
          id: "claude-3-7-sonnet",
          name: "Claude Sonnet",
          provider: "anthropic",
        },
        {
          id: "claude-3-7-sonnet-thinking",
          name: "Claude Sonnet",
          provider: "anthropic",
        },
      ),
      sessionsResult: createSessionsListResult({
        model: "claude-3-7-sonnet",
        modelProvider: "anthropic",
        defaultsModel: "claude-3-7-sonnet-thinking",
        defaultsProvider: "anthropic",
      }),
    });

    const resolved = resolveChatModelSelectState(state);
    expect(resolved.currentOverride).toBe("anthropic/claude-3-7-sonnet");
    expect(resolved.defaultLabel).toBe(
      "Default (Claude Sonnet · claude-3-7-sonnet-thinking · anthropic)",
    );
    expect(resolved.options).toEqual([
      {
        value: "anthropic/claude-3-7-sonnet",
        label: "Claude Sonnet · claude-3-7-sonnet · anthropic",
      },
      {
        value: "anthropic/claude-3-7-sonnet-thinking",
        label: "Claude Sonnet · claude-3-7-sonnet-thinking · anthropic",
      },
    ]);
  });

  it("shows effective server model when cache differs and no pending switch exists (fallback detection)", () => {
    // Scenario: user selected codex/gpt-5.5, runtime fell back to ollama/qwen3.5:9b
    // The session row now reflects the effective model after fallback cleared selectedModel.
    const state = createChatModelState({
      chatModelOverrides: { main: { kind: "qualified", value: "codex/gpt-5.5" } },
      chatModelSwitchPromises: {}, // No pending switch
      sessionsResult: createSessionsListResult({
        model: "ollama/qwen3.5:9b",
        modelProvider: "ollama",
      }),
    });

    // When cache differs from effective server model and no switch is pending,
    // the dropdown should show the effective runtime model.
    expect(resolveChatModelOverrideValue(state)).toBe("ollama/qwen3.5:9b");
  });

  it("preserves cached pending selection during model switch RPC round-trip", () => {
    // Scenario: user switches from codex/gpt-5.5 to anthropic/claude-sonnet-4-6
    // switchChatModel wrote cache = claude-sonnet-4-6 immediately, but sessions.patch
    // hasn't completed yet, so activeRow.model is still the old codex/gpt-5.5.
    const pendingPromise = Promise.resolve(true);
    const state = createChatModelState({
      chatModelOverrides: {
        main: { kind: "qualified", value: "anthropic/claude-sonnet-4-6" },
      },
      chatModelSwitchPromises: { main: pendingPromise }, // RPC in flight
      sessionsResult: createSessionsListResult({
        model: "codex/gpt-5.5", // stale — hasn't refreshed yet
        modelProvider: "codex",
      }),
    });

    // While sessions.patch is in flight, the dropdown must keep showing the
    // user's pending selection, not the stale session row model.
    expect(resolveChatModelOverrideValue(state)).toBe("anthropic/claude-sonnet-4-6");
  });

  it("returns cached value when cache and effective server model match", () => {
    // Normal case: user selected a model that matches the running session.
    const state = createChatModelState({
      chatModelOverrides: { main: { kind: "qualified", value: "anthropic/claude-sonnet-4-6" } },
      chatModelSwitchPromises: {},
      sessionsResult: createSessionsListResult({
        model: "anthropic/claude-sonnet-4-6",
        modelProvider: "anthropic",
      }),
    });

    expect(resolveChatModelOverrideValue(state)).toBe("anthropic/claude-sonnet-4-6");
  });
});
