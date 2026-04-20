import { describe, expect, it } from "vitest";
import type { SessionEntry } from "../config/sessions.js";
import { applyModelOverrideToSessionEntry } from "./model-overrides.js";

function applyOpenAiSelection(entry: SessionEntry) {
  return applyModelOverrideToSessionEntry({
    entry,
    selection: {
      provider: "openai",
      model: "gpt-5.4",
    },
  });
}

function expectRuntimeModelFieldsCleared(entry: SessionEntry, before: number) {
  expect(entry.providerOverride).toBe("openai");
  expect(entry.modelOverride).toBe("gpt-5.4");
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
      contextTokens: 160_000,
      fallbackNoticeSelectedModel: "anthropic/claude-sonnet-4-6",
      fallbackNoticeActiveModel: "anthropic/claude-sonnet-4-6",
      fallbackNoticeReason: "provider temporary failure",
    };

    const result = applyOpenAiSelection(entry);

    expect(result.updated).toBe(true);
    expectRuntimeModelFieldsCleared(entry, before);
    expect(entry.contextTokens).toBeUndefined();
    expect(entry.fallbackNoticeSelectedModel).toBeUndefined();
    expect(entry.fallbackNoticeActiveModel).toBeUndefined();
    expect(entry.fallbackNoticeReason).toBeUndefined();
    expect(entry.modelOverrideSource).toBe("user");
  });

  it("clears stale runtime model fields even when override selection is unchanged", () => {
    const before = Date.now() - 5_000;
    const entry: SessionEntry = {
      sessionId: "sess-2",
      updatedAt: before,
      modelProvider: "anthropic",
      model: "claude-sonnet-4-6",
      providerOverride: "openai",
      modelOverride: "gpt-5.4",
      contextTokens: 160_000,
    };

    const result = applyOpenAiSelection(entry);

    expect(result.updated).toBe(true);
    expectRuntimeModelFieldsCleared(entry, before);
    expect(entry.contextTokens).toBeUndefined();
  });

  it("retains aligned runtime model fields when selection and runtime already match", () => {
    const before = Date.now() - 5_000;
    const entry: SessionEntry = {
      sessionId: "sess-3",
      updatedAt: before,
      modelProvider: "openai",
      model: "gpt-5.4",
      providerOverride: "openai",
      modelOverride: "gpt-5.4",
      contextTokens: 200_000,
    };

    const result = applyModelOverrideToSessionEntry({
      entry,
      selection: {
        provider: "openai",
        model: "gpt-5.4",
      },
    });

    expect(result.updated).toBe(true);
    expect(entry.modelProvider).toBe("openai");
    expect(entry.model).toBe("gpt-5.4");
    expect(entry.modelOverrideSource).toBe("user");
    expect(entry.contextTokens).toBe(200_000);
    expect((entry.updatedAt ?? 0) >= before).toBe(true);
  });

  it("clears stale contextTokens when switching back to the default model", () => {
    const before = Date.now() - 5_000;
    const entry: SessionEntry = {
      sessionId: "sess-4",
      updatedAt: before,
      providerOverride: "local",
      modelOverride: "sunapi386/llama-3-lexi-uncensored:8b",
      contextTokens: 4_096,
    };

    const result = applyModelOverrideToSessionEntry({
      entry,
      selection: {
        provider: "local",
        model: "llama3.1:8b",
        isDefault: true,
      },
    });

    expect(result.updated).toBe(true);
    expect(entry.providerOverride).toBeUndefined();
    expect(entry.modelOverride).toBeUndefined();
    expect(entry.modelOverrideSource).toBeUndefined();
    expect(entry.contextTokens).toBeUndefined();
    expect((entry.updatedAt ?? 0) > before).toBe(true);
  });

  it("marks non-default overrides with the provided source", () => {
    const entry: SessionEntry = {
      sessionId: "sess-5a",
      updatedAt: Date.now() - 5_000,
    };

    const result = applyModelOverrideToSessionEntry({
      entry,
      selection: {
        provider: "anthropic",
        model: "claude-sonnet-4-6",
      },
      selectionSource: "auto",
    });

    expect(result.updated).toBe(true);
    expect(entry.providerOverride).toBe("anthropic");
    expect(entry.modelOverride).toBe("claude-sonnet-4-6");
    expect(entry.modelOverrideSource).toBe("auto");
  });

  it("does not advance lastInteractionAt for automatic selection repairs", () => {
    const before = Date.now() - 5_000;
    const lastInteractionAt = before - 60_000;
    const entry: SessionEntry = {
      sessionId: "sess-auto",
      updatedAt: before,
      lastInteractionAt,
      providerOverride: "anthropic",
      modelOverride: "claude-sonnet-4-6",
    };

    const result = applyModelOverrideToSessionEntry({
      entry,
      selection: {
        provider: "openai",
        model: "gpt-5.4",
      },
      selectionSource: "auto",
    });

    expect(result.updated).toBe(true);
    expect(entry.updatedAt).toBeGreaterThan(before);
    expect(entry.lastInteractionAt).toBe(lastInteractionAt);
  });

  it("sets liveModelSwitchPending only when explicitly requested", () => {
    const entry: SessionEntry = {
      sessionId: "sess-5",
      updatedAt: Date.now() - 5_000,
      providerOverride: "anthropic",
      modelOverride: "claude-sonnet-4-6",
    };

    const withoutFlag = applyModelOverrideToSessionEntry({
      entry: { ...entry },
      selection: {
        provider: "openai",
        model: "gpt-5.4",
      },
    });
    expect(withoutFlag.updated).toBe(true);
    expect(entry.liveModelSwitchPending).toBeUndefined();

    const withFlagEntry: SessionEntry = { ...entry };
    const withFlag = applyModelOverrideToSessionEntry({
      entry: withFlagEntry,
      selection: {
        provider: "openai",
        model: "gpt-5.4",
      },
      markLiveSwitchPending: true,
    });
    expect(withFlag.updated).toBe(true);
    expect(withFlagEntry.liveModelSwitchPending).toBe(true);
  });
});
