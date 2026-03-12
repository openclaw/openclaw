import { describe, expect, it } from "vitest";
import {
  resolveActiveFallbackState,
  resolveFallbackTransition,
  type FallbackNoticeState,
} from "./fallback-state.js";

const baseAttempt = {
  provider: "fireworks",
  model: "fireworks/minimax-m2p5",
  error: "Provider fireworks is in cooldown (all profiles unavailable)",
  reason: "rate_limit" as const,
};

describe("fallback-state", () => {
  it("treats fallback as active only when state matches selected and active refs", () => {
    const state: FallbackNoticeState = {
      fallbackNoticeSelectedModel: "fireworks/minimax-m2p5",
      fallbackNoticeActiveModel: "deepinfra/moonshotai/Kimi-K2.5",
      fallbackNoticeReason: "rate limit",
    };

    const resolved = resolveActiveFallbackState({
      selectedModelRef: "fireworks/minimax-m2p5",
      activeModelRef: "deepinfra/moonshotai/Kimi-K2.5",
      state,
    });

    expect(resolved.active).toBe(true);
    expect(resolved.reason).toBe("rate limit");
  });

  it("does not treat runtime drift as fallback when persisted state does not match", () => {
    const state: FallbackNoticeState = {
      fallbackNoticeSelectedModel: "anthropic/claude",
      fallbackNoticeActiveModel: "deepinfra/moonshotai/Kimi-K2.5",
      fallbackNoticeReason: "rate limit",
    };

    const resolved = resolveActiveFallbackState({
      selectedModelRef: "fireworks/minimax-m2p5",
      activeModelRef: "deepinfra/moonshotai/Kimi-K2.5",
      state,
    });

    expect(resolved.active).toBe(false);
    expect(resolved.reason).toBeUndefined();
  });

  it("marks fallback transition when selected->active pair changes", () => {
    const resolved = resolveFallbackTransition({
      selectedProvider: "fireworks",
      selectedModel: "fireworks/minimax-m2p5",
      activeProvider: "deepinfra",
      activeModel: "moonshotai/Kimi-K2.5",
      attempts: [baseAttempt],
      state: {},
    });

    expect(resolved.fallbackActive).toBe(true);
    expect(resolved.fallbackTransitioned).toBe(true);
    expect(resolved.fallbackCleared).toBe(false);
    expect(resolved.stateChanged).toBe(true);
    expect(resolved.reasonSummary).toBe("rate limit");
    expect(resolved.nextState.selectedModel).toBe("fireworks/minimax-m2p5");
    expect(resolved.nextState.activeModel).toBe("deepinfra/moonshotai/Kimi-K2.5");
  });

  it("normalizes fallback reason whitespace for summaries", () => {
    const resolved = resolveFallbackTransition({
      selectedProvider: "fireworks",
      selectedModel: "fireworks/minimax-m2p5",
      activeProvider: "deepinfra",
      activeModel: "moonshotai/Kimi-K2.5",
      attempts: [{ ...baseAttempt, reason: "rate_limit\n\tburst" }],
      state: {},
    });

    expect(resolved.reasonSummary).toBe("rate limit burst");
  });

  it("refreshes reason when fallback remains active with same model pair", () => {
    const resolved = resolveFallbackTransition({
      selectedProvider: "fireworks",
      selectedModel: "fireworks/minimax-m2p5",
      activeProvider: "deepinfra",
      activeModel: "moonshotai/Kimi-K2.5",
      attempts: [{ ...baseAttempt, reason: "timeout" }],
      state: {
        fallbackNoticeSelectedModel: "fireworks/minimax-m2p5",
        fallbackNoticeActiveModel: "deepinfra/moonshotai/Kimi-K2.5",
        fallbackNoticeReason: "rate limit",
      },
    });

    expect(resolved.fallbackTransitioned).toBe(false);
    expect(resolved.stateChanged).toBe(true);
    expect(resolved.nextState.reason).toBe("timeout");
  });

  it("marks fallback as cleared when runtime returns to selected model", () => {
    const resolved = resolveFallbackTransition({
      selectedProvider: "fireworks",
      selectedModel: "fireworks/minimax-m2p5",
      activeProvider: "fireworks",
      activeModel: "fireworks/minimax-m2p5",
      attempts: [],
      state: {
        fallbackNoticeSelectedModel: "fireworks/minimax-m2p5",
        fallbackNoticeActiveModel: "deepinfra/moonshotai/Kimi-K2.5",
        fallbackNoticeReason: "rate limit",
      },
    });

    expect(resolved.fallbackActive).toBe(false);
    expect(resolved.fallbackCleared).toBe(true);
    expect(resolved.fallbackTransitioned).toBe(false);
    expect(resolved.stateChanged).toBe(true);
    expect(resolved.nextState.selectedModel).toBeUndefined();
    expect(resolved.nextState.activeModel).toBeUndefined();
    expect(resolved.nextState.reason).toBeUndefined();
  });
});
