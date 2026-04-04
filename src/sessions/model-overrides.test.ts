import { describe, expect, it } from "vitest";
import type { SessionEntry } from "../config/sessions.js";
import {
  applyModelOverrideToSessionEntry,
  shouldResetLegacyMainSessionModelOverride,
} from "./model-overrides.js";

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
  expect(entry.modelOverrideSource).toBe("user");
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
      model: "gpt-5.2",
      providerOverride: "openai",
      modelOverride: "gpt-5.2",
      contextTokens: 200_000,
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
    expect(entry.contextTokens).toBe(200_000);
    expect(entry.updatedAt).toBe(before);
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

  it("does not treat explicit user-tagged main-session overrides as legacy drift", () => {
    const entry: SessionEntry = {
      sessionId: "sess-5",
      updatedAt: Date.now(),
      providerOverride: "openai-codex",
      modelOverride: "gpt-5.4",
      modelOverrideSource: "user",
      modelProvider: "openai-codex",
      model: "gpt-5.4",
    };

    expect(
      shouldResetLegacyMainSessionModelOverride({
        entry,
        sessionKey: "agent:main:main",
        mainKey: "main",
        defaultProvider: "miaomiaocode-codex",
        defaultModel: "gpt-5.4",
      }),
    ).toBe(false);
  });
});
