import { describe, expect, it } from "vitest";
import {
  resolveActiveFallbackState,
  resolveFallbackTransition,
  type FallbackNoticeState,
} from "./fallback-state.js";

const baseAttempt = {
  provider: "demo-primary",
  model: "demo-primary/model-a",
  error: "Provider demo-primary is in cooldown (all profiles unavailable)",
  reason: "rate_limit" as const,
};

describe("fallback-state", () => {
  it("treats fallback as active only when state matches selected and active refs", () => {
    const state: FallbackNoticeState = {
      fallbackNoticeSelectedModel: "demo-primary/model-a",
      fallbackNoticeActiveModel: "demo-fallback/model-b",
      fallbackNoticeReason: "rate limit",
    };

    const resolved = resolveActiveFallbackState({
      selectedModelRef: "demo-primary/model-a",
      activeModelRef: "demo-fallback/model-b",
      state,
    });

    expect(resolved.active).toBe(true);
    expect(resolved.reason).toBe("rate limit");
  });

  it("does not treat runtime drift as fallback when persisted state does not match", () => {
    const state: FallbackNoticeState = {
      fallbackNoticeSelectedModel: "other-provider/other-model",
      fallbackNoticeActiveModel: "demo-fallback/model-b",
      fallbackNoticeReason: "rate limit",
    };

    const resolved = resolveActiveFallbackState({
      selectedModelRef: "demo-primary/model-a",
      activeModelRef: "demo-fallback/model-b",
      state,
    });

    expect(resolved.active).toBe(false);
    expect(resolved.reason).toBeUndefined();
  });

  it("marks fallback transition when selected->active pair changes", () => {
    const resolved = resolveFallbackTransition({
      selectedProvider: "demo-primary",
      selectedModel: "model-a",
      activeProvider: "demo-fallback",
      activeModel: "model-b",
      attempts: [baseAttempt],
      state: {},
    });

    expect(resolved.fallbackActive).toBe(true);
    expect(resolved.fallbackTransitioned).toBe(true);
    expect(resolved.fallbackCleared).toBe(false);
    expect(resolved.stateChanged).toBe(true);
    expect(resolved.reasonSummary).toBe("rate limit");
    expect(resolved.nextState.selectedModel).toBe("demo-primary/model-a");
    expect(resolved.nextState.activeModel).toBe("demo-fallback/model-b");
  });

  it("normalizes fallback reason whitespace for summaries", () => {
    const resolved = resolveFallbackTransition({
      selectedProvider: "demo-primary",
      selectedModel: "model-a",
      activeProvider: "demo-fallback",
      activeModel: "model-b",
      attempts: [{ ...baseAttempt, reason: "rate_limit\n\tburst" }],
      state: {},
    });

    expect(resolved.reasonSummary).toBe("rate limit burst");
  });

  it("refreshes reason when fallback remains active with same model pair", () => {
    const resolved = resolveFallbackTransition({
      selectedProvider: "demo-primary",
      selectedModel: "model-a",
      activeProvider: "demo-fallback",
      activeModel: "model-b",
      attempts: [{ ...baseAttempt, reason: "timeout" }],
      state: {
        fallbackNoticeSelectedModel: "demo-primary/model-a",
        fallbackNoticeActiveModel: "demo-fallback/model-b",
        fallbackNoticeReason: "rate limit",
      },
    });

    expect(resolved.fallbackTransitioned).toBe(false);
    expect(resolved.stateChanged).toBe(true);
    expect(resolved.nextState.reason).toBe("timeout");
  });

  it("marks fallback as cleared when runtime returns to selected model", () => {
    const resolved = resolveFallbackTransition({
      selectedProvider: "demo-primary",
      selectedModel: "model-a",
      activeProvider: "demo-primary",
      activeModel: "model-a",
      attempts: [],
      state: {
        fallbackNoticeSelectedModel: "demo-primary/model-a",
        fallbackNoticeActiveModel: "demo-fallback/model-b",
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
