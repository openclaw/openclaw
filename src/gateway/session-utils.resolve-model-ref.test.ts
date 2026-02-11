import { describe, expect, test } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { SessionEntry } from "../config/sessions.js";
import { resolveSessionModelRef } from "./session-utils.js";

/**
 * Tests for resolveSessionModelRef — verifies that sessions_list reports
 * the correct model for cron sessions that override the agent default.
 *
 * Regression test for: https://github.com/openclaw/openclaw/issues/13429
 */
describe("resolveSessionModelRef", () => {
  const baseCfg: OpenClawConfig = {
    llm: {
      provider: "anthropic",
      model: "claude-opus-4-6",
    },
  };

  function makeEntry(overrides: Partial<SessionEntry> = {}): SessionEntry {
    return {
      sessionId: "test-session",
      updatedAt: Date.now(),
      ...overrides,
    };
  }

  test("returns agent/config default when session has no model fields", () => {
    const entry = makeEntry();
    const result = resolveSessionModelRef(baseCfg, entry);
    expect(result.model).toBe("claude-opus-4-6");
    expect(result.provider).toBe("anthropic");
  });

  test("returns modelOverride when set (user-initiated override)", () => {
    const entry = makeEntry({
      modelOverride: "claude-sonnet-4-20250514",
      providerOverride: "anthropic",
    });
    const result = resolveSessionModelRef(baseCfg, entry);
    expect(result.model).toBe("claude-sonnet-4-20250514");
    expect(result.provider).toBe("anthropic");
  });

  test("returns entry.model when set by cron run (no modelOverride)", () => {
    const entry = makeEntry({
      model: "gemini-3-pro-preview",
      modelProvider: "google-gemini-cli",
    });
    const result = resolveSessionModelRef(baseCfg, entry);
    expect(result.model).toBe("gemini-3-pro-preview");
    expect(result.provider).toBe("google-gemini-cli");
  });

  test("modelOverride takes priority over entry.model", () => {
    const entry = makeEntry({
      modelOverride: "claude-sonnet-4-20250514",
      providerOverride: "anthropic",
      model: "gemini-3-pro-preview",
      modelProvider: "google-gemini-cli",
    });
    const result = resolveSessionModelRef(baseCfg, entry);
    expect(result.model).toBe("claude-sonnet-4-20250514");
    expect(result.provider).toBe("anthropic");
  });

  test("entry.model with no modelProvider uses config default provider", () => {
    const entry = makeEntry({
      model: "claude-sonnet-4-20250514",
    });
    const result = resolveSessionModelRef(baseCfg, entry);
    expect(result.model).toBe("claude-sonnet-4-20250514");
    expect(result.provider).toBe("anthropic");
  });

  test("returns config default when entry is undefined", () => {
    const result = resolveSessionModelRef(baseCfg, undefined);
    expect(result.model).toBe("claude-opus-4-6");
    expect(result.provider).toBe("anthropic");
  });

  test("ignores empty/whitespace model strings", () => {
    const entry = makeEntry({
      model: "  ",
      modelProvider: "google-gemini-cli",
    });
    const result = resolveSessionModelRef(baseCfg, entry);
    expect(result.model).toBe("claude-opus-4-6");
    expect(result.provider).toBe("anthropic");
  });
});
