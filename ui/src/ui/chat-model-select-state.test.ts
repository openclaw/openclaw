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

describe("chat-model-select-state", () => {
  it("prefers the catalog provider when the active session provider is stale", () => {
    const state = {
      sessionKey: "main",
      chatModelOverrides: {},
      chatModelCatalog: createModelCatalog(DEEPSEEK_CHAT_MODEL),
      sessionsResult: createSessionsListResult({
        model: "deepseek-chat",
        modelProvider: "zai",
      }),
    };

    expect(resolveChatModelOverrideValue(state)).toBe("deepseek/deepseek-chat");
  });

  it("falls back to the server-qualified value when catalog lookup fails", () => {
    const state = {
      sessionKey: "main",
      chatModelOverrides: {},
      chatModelCatalog: [],
      sessionsResult: createSessionsListResult({
        model: "gpt-5-mini",
        modelProvider: "openai",
      }),
    };

    expect(resolveChatModelOverrideValue(state)).toBe("openai/gpt-5-mini");
  });

  it("builds picker options without introducing a bare duplicate", () => {
    const state = {
      sessionKey: "main",
      chatModelOverrides: {},
      chatModelCatalog: createModelCatalog(...DEFAULT_CHAT_MODEL_CATALOG),
      sessionsResult: createSessionsListResult({
        model: "gpt-5-mini",
        modelProvider: "openai",
      }),
    };

    const resolved = resolveChatModelSelectState(state);
    expect(resolved.currentOverride).toBe("openai/gpt-5-mini");
    expect(resolved.options.map((option) => option.value)).toContain("openai/gpt-5-mini");
    expect(resolved.options.map((option) => option.value)).not.toContain("gpt-5-mini");
  });
});
