import { describe, expect, it } from "vitest";
import type { SessionEntry } from "./types.js";
import { mergeSessionEntry } from "./types.js";

describe("SessionEntry cache fields", () => {
  it("supports cacheRead and cacheWrite fields", () => {
    const entry: SessionEntry = {
      sessionId: "test-session",
      updatedAt: Date.now(),
      cacheRead: 1500,
      cacheWrite: 300,
    };

    expect(entry.cacheRead).toBe(1500);
    expect(entry.cacheWrite).toBe(300);
  });

  it("merges cache fields properly", () => {
    const existing: SessionEntry = {
      sessionId: "test-session",
      updatedAt: Date.now(),
      cacheRead: 1000,
      cacheWrite: 200,
      totalTokens: 5000,
    };

    const patch: Partial<SessionEntry> = {
      cacheRead: 1500,
      cacheWrite: 300,
    };

    const merged = mergeSessionEntry(existing, patch);

    expect(merged.cacheRead).toBe(1500);
    expect(merged.cacheWrite).toBe(300);
    expect(merged.totalTokens).toBe(5000); // Preserved from existing
  });

  it("handles undefined cache fields", () => {
    const entry: SessionEntry = {
      sessionId: "test-session",
      updatedAt: Date.now(),
      totalTokens: 5000,
    };

    expect(entry.cacheRead).toBeUndefined();
    expect(entry.cacheWrite).toBeUndefined();
  });

  it("allows cache fields to be cleared with undefined", () => {
    const existing: SessionEntry = {
      sessionId: "test-session",
      updatedAt: Date.now(),
      cacheRead: 1000,
      cacheWrite: 200,
    };

    const patch: Partial<SessionEntry> = {
      cacheRead: undefined,
      cacheWrite: undefined,
    };

    const merged = mergeSessionEntry(existing, patch);

    expect(merged.cacheRead).toBeUndefined();
    expect(merged.cacheWrite).toBeUndefined();
  });

  it("clears stale sessionFile when sessionId changes without a new transcript path", () => {
    const existing: SessionEntry = {
      sessionId: "old-session",
      updatedAt: Date.now(),
      sessionFile: "/tmp/old-session.jsonl",
      totalTokens: 5000,
    };

    const merged = mergeSessionEntry(existing, {
      sessionId: "new-session",
    });

    expect(merged.sessionId).toBe("new-session");
    expect(merged.sessionFile).toBeUndefined();
    expect(merged.totalTokens).toBe(5000);
  });

  it("preserves explicit sessionFile when callers rotate sessionId and transcript together", () => {
    const existing: SessionEntry = {
      sessionId: "old-session",
      updatedAt: Date.now(),
      sessionFile: "/tmp/old-session.jsonl",
    };

    const merged = mergeSessionEntry(existing, {
      sessionId: "new-session",
      sessionFile: "/tmp/new-session.jsonl",
    });

    expect(merged.sessionId).toBe("new-session");
    expect(merged.sessionFile).toBe("/tmp/new-session.jsonl");
  });
});
