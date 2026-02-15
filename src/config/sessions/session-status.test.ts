import { describe, expect, it } from "vitest";
import {
  SESSION_STATUS_FIELD_NAMES,
  applySessionStatusFields,
  pickSessionStatus,
} from "./session-status.js";
import type { SessionEntry } from "./types.js";

const makeEntry = (overrides: Partial<SessionEntry> = {}): SessionEntry => ({
  sessionId: "test-id",
  updatedAt: Date.now(),
  ...overrides,
});

describe("SESSION_STATUS_FIELD_NAMES", () => {
  it("contains the expected fields", () => {
    expect(SESSION_STATUS_FIELD_NAMES).toContain("systemSent");
    expect(SESSION_STATUS_FIELD_NAMES).toContain("thinkingLevel");
    expect(SESSION_STATUS_FIELD_NAMES).toContain("totalTokens");
    expect(SESSION_STATUS_FIELD_NAMES).toContain("contextTokens");
    expect(SESSION_STATUS_FIELD_NAMES).toContain("responseUsage");
  });

  it("does not contain model or modelProvider", () => {
    const names: readonly string[] = SESSION_STATUS_FIELD_NAMES;
    expect(names).not.toContain("model");
    expect(names).not.toContain("modelProvider");
  });
});

describe("pickSessionStatus", () => {
  it("returns empty object for null/undefined", () => {
    expect(pickSessionStatus(null)).toEqual({});
    expect(pickSessionStatus(undefined)).toEqual({});
  });

  it("extracts defined status fields", () => {
    const entry = makeEntry({
      thinkingLevel: "high",
      verboseLevel: "on",
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      contextTokens: 8000,
      systemSent: true,
    });
    const result = pickSessionStatus(entry);
    expect(result).toEqual({
      thinkingLevel: "high",
      verboseLevel: "on",
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      contextTokens: 8000,
      systemSent: true,
    });
  });

  it("skips undefined values", () => {
    const entry = makeEntry({ thinkingLevel: "low" });
    const result = pickSessionStatus(entry);
    expect(result).toEqual({ thinkingLevel: "low" });
    expect(Object.keys(result)).toEqual(["thinkingLevel"]);
  });

  it("does not include non-status fields", () => {
    const entry = makeEntry({
      model: "gpt-4",
      modelProvider: "openai",
      displayName: "test",
      thinkingLevel: "high",
    });
    const result = pickSessionStatus(entry);
    expect(result).not.toHaveProperty("model");
    expect(result).not.toHaveProperty("modelProvider");
    expect(result).not.toHaveProperty("displayName");
    expect(result).toHaveProperty("thinkingLevel", "high");
  });

  it("preserves false and 0 values", () => {
    const entry = makeEntry({
      totalTokensFresh: false,
      inputTokens: 0,
      systemSent: false,
    });
    const result = pickSessionStatus(entry);
    expect(result.totalTokensFresh).toBe(false);
    expect(result.inputTokens).toBe(0);
    expect(result.systemSent).toBe(false);
  });
});

describe("applySessionStatusFields", () => {
  it("does nothing for null/undefined source", () => {
    const target = { thinkingLevel: "low" as const };
    applySessionStatusFields(target, null);
    expect(target.thinkingLevel).toBe("low");
    applySessionStatusFields(target, undefined);
    expect(target.thinkingLevel).toBe("low");
  });

  it("overwrites defined fields only", () => {
    const target: Record<string, unknown> = {
      thinkingLevel: "low",
      verboseLevel: "off",
      inputTokens: 10,
    };
    applySessionStatusFields(target, {
      thinkingLevel: "high",
      // verboseLevel not set — should remain "off"
      inputTokens: 200,
    });
    expect(target.thinkingLevel).toBe("high");
    expect(target.verboseLevel).toBe("off");
    expect(target.inputTokens).toBe(200);
  });

  it("does not overwrite with undefined", () => {
    const target: Record<string, unknown> = { totalTokens: 500 };
    applySessionStatusFields(target, {});
    expect(target.totalTokens).toBe(500);
  });

  it("applies false and 0 values", () => {
    const target: Record<string, unknown> = {
      systemSent: true,
      totalTokensFresh: true,
      inputTokens: 100,
    };
    applySessionStatusFields(target, {
      systemSent: false,
      totalTokensFresh: false,
      inputTokens: 0,
    });
    expect(target.systemSent).toBe(false);
    expect(target.totalTokensFresh).toBe(false);
    expect(target.inputTokens).toBe(0);
  });
});
