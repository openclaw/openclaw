import { describe, expect, it } from "vitest";
import type { SessionEntry } from "../config/sessions.js";
import { applyModelOverrideToSessionEntry } from "./model-overrides.js";

function applyOpenAiSelection(entry: SessionEntry) {
  return applyModelOverrideToSessionEntry({
    entry,
    selection: {
      provider: "openai",
      model: "gpt-5.2",
    },
  });
}

function expectRuntimeModelFieldsCleared(entry: SessionEntry, before: number) {
  expect(entry.providerOverride).toBe("openai");
  expect(entry.modelOverride).toBe("gpt-5.2");
  expect(entry.modelProvider).toBeUndefined();
  expect(entry.model).toBeUndefined();
  expect((entry.updatedAt ?? 0) > before).toBe(true);
}

describe("applyModelOverrideToSessionEntry", () => {
  it("clears stale runtime model fields when switching overrides", () => {
    const before = Date.now() - 5_000;
    const entry: SessionEntry = {
      sessionId: "sess-1",
      updatedAt: before,
      modelProvider: "anthropic",
      model: "claude-sonnet-4-6",
      providerOverride: "anthropic",
      modelOverride: "claude-sonnet-4-6",
      fallbackNoticeSelectedModel: "anthropic/claude-sonnet-4-6",
      fallbackNoticeActiveModel: "anthropic/claude-sonnet-4-6",
      fallbackNoticeReason: "provider temporary failure",
    };

    const result = applyOpenAiSelection(entry);

    expect(result.updated).toBe(true);
    expectRuntimeModelFieldsCleared(entry, before);
    expect(entry.fallbackNoticeSelectedModel).toBeUndefined();
    expect(entry.fallbackNoticeActiveModel).toBeUndefined();
    expect(entry.fallbackNoticeReason).toBeUndefined();
  });

  it("clears stale runtime model fields even when override selection is unchanged", () => {
    const before = Date.now() - 5_000;
    const entry: SessionEntry = {
      sessionId: "sess-2",
      updatedAt: before,
      modelProvider: "anthropic",
      model: "claude-sonnet-4-6",
      providerOverride: "openai",
      modelOverride: "gpt-5.2",
    };

    const result = applyOpenAiSelection(entry);

    expect(result.updated).toBe(true);
    expectRuntimeModelFieldsCleared(entry, before);
  });

  it("retains aligned runtime model fields when selection and runtime already match", () => {
    const before = Date.now() - 5_000;
    const entry: SessionEntry = {
      sessionId: "sess-3",
      updatedAt: before,
      modelProvider: "openai",
      model: "gpt-5.2",
      providerOverride: "openai",
      modelOverride: "gpt-5.2",
    };

    const result = applyModelOverrideToSessionEntry({
      entry,
      selection: {
        provider: "openai",
        model: "gpt-5.2",
      },
    });

    expect(result.updated).toBe(false);
    expect(entry.modelProvider).toBe("openai");
    expect(entry.model).toBe("gpt-5.2");
    expect(entry.updatedAt).toBe(before);
  });

  it("clears stale contextTokens when model selection changes (fixes #35372)", () => {
    const before = Date.now() - 5_000;
    const entry: SessionEntry = {
      sessionId: "sess-4",
      updatedAt: before,
      modelProvider: "anthropic",
      model: "claude-haiku-4-5",
      providerOverride: "anthropic",
      modelOverride: "claude-haiku-4-5",
      contextTokens: 160000, // Stuck at haiku's limit
    };

    const result = applyModelOverrideToSessionEntry({
      entry,
      selection: {
        provider: "anthropic",
        model: "claude-sonnet-4-6",
      },
    });

    expect(result.updated).toBe(true);
    expect(entry.providerOverride).toBe("anthropic");
    expect(entry.modelOverride).toBe("claude-sonnet-4-6");
    expect(entry.contextTokens).toBeUndefined();
    expect((entry.updatedAt ?? 0) > before).toBe(true);
  });

  it("does not clear contextTokens when model selection is unchanged", () => {
    const before = Date.now() - 5_000;
    const entry: SessionEntry = {
      sessionId: "sess-5",
      updatedAt: before,
      modelProvider: "anthropic",
      model: "claude-sonnet-4-6",
      providerOverride: "anthropic",
      modelOverride: "claude-sonnet-4-6",
      contextTokens: 200000,
    };

    const result = applyModelOverrideToSessionEntry({
      entry,
      selection: {
        provider: "anthropic",
        model: "claude-sonnet-4-6",
      },
    });

    expect(result.updated).toBe(false);
    expect(entry.contextTokens).toBe(200000);
    expect(entry.updatedAt).toBe(before);
  });
});
