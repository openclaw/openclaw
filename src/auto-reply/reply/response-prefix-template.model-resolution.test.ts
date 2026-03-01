/**
 * Tests for {model} template variable resolution in responsePrefix.
 * Covers: initial state, after model selection, after model change (fallback / /model switch).
 *
 * Fixes #30482 — responsePrefix {model} renders stale session state.
 */

import { describe, expect, it } from "vitest";
import {
  applyModelSelectionToResponsePrefixContext,
  createResponsePrefixContext,
  extractShortModelName,
  resolveResponsePrefixTemplate,
} from "./response-prefix-template.js";

describe("createResponsePrefixContext", () => {
  it("creates empty context when no identityName given", () => {
    const ctx = createResponsePrefixContext();
    expect(ctx).toEqual({});
  });

  it("creates context with identityName", () => {
    const ctx = createResponsePrefixContext("MyBot");
    expect(ctx.identityName).toBe("MyBot");
  });

  it("starts with model undefined (resolved after onModelSelected fires)", () => {
    const ctx = createResponsePrefixContext("Bot");
    expect(ctx.model).toBeUndefined();
    expect(ctx.provider).toBeUndefined();
  });
});

describe("applyModelSelectionToResponsePrefixContext", () => {
  it("populates model/provider/thinkingLevel from selection", () => {
    const ctx = createResponsePrefixContext();
    applyModelSelectionToResponsePrefixContext(ctx, {
      provider: "anthropic",
      model: "claude-opus-4-6",
      thinkLevel: "high",
    });
    expect(ctx.model).toBe("claude-opus-4-6");
    expect(ctx.provider).toBe("anthropic");
    expect(ctx.modelFull).toBe("anthropic/claude-opus-4-6");
    expect(ctx.thinkingLevel).toBe("high");
  });

  it("strips date suffix from model name", () => {
    const ctx = createResponsePrefixContext();
    applyModelSelectionToResponsePrefixContext(ctx, {
      provider: "anthropic",
      model: "claude-opus-4-6-20250601",
    });
    expect(ctx.model).toBe("claude-opus-4-6");
  });

  it("defaults thinkingLevel to 'off' when thinkLevel is absent", () => {
    const ctx = createResponsePrefixContext();
    applyModelSelectionToResponsePrefixContext(ctx, {
      provider: "openai",
      model: "gpt-4o",
    });
    expect(ctx.thinkingLevel).toBe("off");
  });

  it("overwrites previous model selection (model-switch scenario)", () => {
    const ctx = createResponsePrefixContext();
    // First model: kimi-k2.5
    applyModelSelectionToResponsePrefixContext(ctx, {
      provider: "moonshot",
      model: "kimi-k2.5",
    });
    expect(ctx.model).toBe("kimi-k2.5");

    // After /model switch to qwen
    applyModelSelectionToResponsePrefixContext(ctx, {
      provider: "alibaba",
      model: "qwen-max",
    });
    expect(ctx.model).toBe("qwen-max");
    expect(ctx.provider).toBe("alibaba");
    expect(ctx.modelFull).toBe("alibaba/qwen-max");
  });
});

describe("resolveResponsePrefixTemplate {model} resolution", () => {
  it("resolves {model} to the short model name", () => {
    const ctx = createResponsePrefixContext();
    applyModelSelectionToResponsePrefixContext(ctx, {
      provider: "anthropic",
      model: "claude-opus-4-6",
    });
    expect(resolveResponsePrefixTemplate("[{model}]", ctx)).toBe("[claude-opus-4-6]");
  });

  it("returns template literal when model is not set (initial state)", () => {
    const ctx = createResponsePrefixContext();
    // model is undefined — {model} should remain as literal placeholder
    expect(resolveResponsePrefixTemplate("[{model}]", ctx)).toBe("[{model}]");
  });

  it("resolves {model} after model change (new context reflects new model)", () => {
    const ctx = createResponsePrefixContext();

    // Simulate first message using kimi-k2.5
    applyModelSelectionToResponsePrefixContext(ctx, {
      provider: "moonshot",
      model: "kimi-k2.5",
    });
    expect(resolveResponsePrefixTemplate("[{model}]", ctx)).toBe("[kimi-k2.5]");

    // Simulate /model switch to claude-opus-4-6 (new context per message)
    const ctx2 = createResponsePrefixContext();
    applyModelSelectionToResponsePrefixContext(ctx2, {
      provider: "anthropic",
      model: "claude-opus-4-6",
    });
    expect(resolveResponsePrefixTemplate("[{model}]", ctx2)).toBe("[claude-opus-4-6]");
    // Old context unaffected
    expect(resolveResponsePrefixTemplate("[{model}]", ctx)).toBe("[kimi-k2.5]");
  });

  it("resolves {model} after fallback to a different model", () => {
    const ctx = createResponsePrefixContext();
    // Primary model failed; fallback to claude-opus-4-6
    applyModelSelectionToResponsePrefixContext(ctx, {
      provider: "anthropic",
      model: "claude-opus-4-6",
    });
    expect(resolveResponsePrefixTemplate("[{model}]", ctx)).toBe("[claude-opus-4-6]");
    // {model} should NOT be stale from session-init state
    expect(resolveResponsePrefixTemplate("[{model}]", ctx)).not.toBe("[{model}]");
  });

  it("resolves {modelFull} to provider/model", () => {
    const ctx = createResponsePrefixContext();
    applyModelSelectionToResponsePrefixContext(ctx, {
      provider: "anthropic",
      model: "claude-opus-4-6",
    });
    expect(resolveResponsePrefixTemplate("[{modelFull}]", ctx)).toBe("[anthropic/claude-opus-4-6]");
  });

  it("resolves {provider}", () => {
    const ctx = createResponsePrefixContext();
    applyModelSelectionToResponsePrefixContext(ctx, {
      provider: "openai",
      model: "gpt-4o",
    });
    expect(resolveResponsePrefixTemplate("{provider}", ctx)).toBe("openai");
  });

  it("resolves {thinkingLevel} and {think} alias", () => {
    const ctx = createResponsePrefixContext();
    applyModelSelectionToResponsePrefixContext(ctx, {
      provider: "anthropic",
      model: "claude-opus-4-6",
      thinkLevel: "high",
    });
    expect(resolveResponsePrefixTemplate("{thinkingLevel}", ctx)).toBe("high");
    expect(resolveResponsePrefixTemplate("{think}", ctx)).toBe("high");
  });
});

describe("extractShortModelName", () => {
  it("strips date suffix", () => {
    expect(extractShortModelName("claude-opus-4-6-20250601")).toBe("claude-opus-4-6");
  });

  it("strips -latest suffix", () => {
    expect(extractShortModelName("gpt-4o-latest")).toBe("gpt-4o");
  });

  it("strips provider prefix", () => {
    expect(extractShortModelName("anthropic/claude-opus-4-6")).toBe("claude-opus-4-6");
  });

  it("leaves clean names unchanged", () => {
    expect(extractShortModelName("gpt-4o")).toBe("gpt-4o");
    expect(extractShortModelName("kimi-k2.5")).toBe("kimi-k2.5");
  });
});
