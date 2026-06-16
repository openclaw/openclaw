import { describe, it, expect } from "vitest";
import { buildUsageContract } from "./contract.js";
import type { PluginHookReplyUsageState } from "../../plugins/hook-types.js";

describe("buildUsageContract", () => {
  const baseState: PluginHookReplyUsageState = {
    model: "test-model",
    provider: "test",
    usage: {},
  } as unknown as PluginHookReplyUsageState;

  function getContext(result: Record<string, unknown>): { used_tokens?: number; pct_used?: number } {
    return result.context as { used_tokens?: number; pct_used?: number };
  }

  it("returns 0 used_tokens on a fresh session with no usage", () => {
    const result = buildUsageContract(baseState);
    expect(getContext(result).used_tokens).toBe(0);
  });

  it("returns 0 used_tokens when contextUsedTokens is undefined and promptTotal is 0", () => {
    const state = {
      ...baseState,
      contextUsedTokens: undefined,
      usage: { input: 0, cacheRead: 0, cacheWrite: 0 },
    } as unknown as PluginHookReplyUsageState;
    const result = buildUsageContract(state);
    expect(getContext(result).used_tokens).toBe(0);
  });

  it("accepts contextUsedTokens of 0 as valid", () => {
    const state = {
      ...baseState,
      contextUsedTokens: 0,
      contextTokenBudget: 1000000,
    } as unknown as PluginHookReplyUsageState;
    const result = buildUsageContract(state);
    expect(getContext(result).used_tokens).toBe(0);
    expect(getContext(result).pct_used).toBe(0);
  });

  it("uses contextUsedTokens when positive", () => {
    const state = {
      ...baseState,
      contextUsedTokens: 50000,
      contextTokenBudget: 1000000,
    } as unknown as PluginHookReplyUsageState;
    const result = buildUsageContract(state);
    expect(getContext(result).used_tokens).toBe(50000);
    expect(getContext(result).pct_used).toBe(5);
  });

  it("falls back to promptTotal when contextUsedTokens is undefined and promptTotal > 0", () => {
    const state = {
      ...baseState,
      contextUsedTokens: undefined,
      usage: { input: 1000, cacheRead: 500, cacheWrite: 200 },
    } as unknown as PluginHookReplyUsageState;
    const result = buildUsageContract(state);
    // promptTotal = cacheRead + cacheWrite + input = 500 + 200 + 1000 = 1700
    expect(getContext(result).used_tokens).toBe(1700);
  });
});
