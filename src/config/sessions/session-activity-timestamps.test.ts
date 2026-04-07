import { describe, expect, it } from "vitest";
import type { SessionEntry } from "./types.js";
import { mergeSessionEntry } from "./types.js";

describe("SessionEntry activity timestamp fields", () => {
  it("supports lastUserMessageAt field", () => {
    const now = Date.now();
    const entry: SessionEntry = {
      sessionId: "test-session",
      updatedAt: now,
      lastUserMessageAt: now,
    };

    expect(entry.lastUserMessageAt).toBe(now);
  });

  it("supports lastAssistantMessageAt field", () => {
    const now = Date.now();
    const entry: SessionEntry = {
      sessionId: "test-session",
      updatedAt: now,
      lastAssistantMessageAt: now,
    };

    expect(entry.lastAssistantMessageAt).toBe(now);
  });

  it("sets lastCacheTouchAt when cache usage > 0", () => {
    const now = Date.now();
    // Simulate recording a cache touch (cacheRead > 0)
    const entry: SessionEntry = {
      sessionId: "test-session",
      updatedAt: now,
      cacheRead: 1500,
      cacheWrite: 0,
      lastCacheTouchAt: now,
    };

    expect(entry.lastCacheTouchAt).toBe(now);
  });

  it("does not set lastCacheTouchAt when no cache data", () => {
    const now = Date.now();
    const entry: SessionEntry = {
      sessionId: "test-session",
      updatedAt: now,
      cacheRead: 0,
      cacheWrite: 0,
    };

    // lastCacheTouchAt should remain unset when cacheRead and cacheWrite are both 0
    expect(entry.lastCacheTouchAt).toBeUndefined();
  });

  it("merges lastUserMessageAt field properly", () => {
    const t1 = Date.now();
    const t2 = t1 + 5000;

    const existing: SessionEntry = {
      sessionId: "test-session",
      updatedAt: t1,
      lastUserMessageAt: t1,
    };

    const patch: Partial<SessionEntry> = {
      lastUserMessageAt: t2,
    };

    const merged = mergeSessionEntry(existing, patch);
    expect(merged.lastUserMessageAt).toBe(t2);
  });

  it("merges lastAssistantMessageAt field properly", () => {
    const t1 = Date.now();
    const t2 = t1 + 3000;

    const existing: SessionEntry = {
      sessionId: "test-session",
      updatedAt: t1,
      lastAssistantMessageAt: t1,
    };

    const patch: Partial<SessionEntry> = {
      lastAssistantMessageAt: t2,
    };

    const merged = mergeSessionEntry(existing, patch);
    expect(merged.lastAssistantMessageAt).toBe(t2);
  });

  it("merges lastCacheTouchAt field properly", () => {
    const t1 = Date.now();
    const t2 = t1 + 8000;

    const existing: SessionEntry = {
      sessionId: "test-session",
      updatedAt: t1,
      lastCacheTouchAt: t1,
    };

    const patch: Partial<SessionEntry> = {
      lastCacheTouchAt: t2,
    };

    const merged = mergeSessionEntry(existing, patch);
    expect(merged.lastCacheTouchAt).toBe(t2);
  });

  it("all three timestamp fields are optional", () => {
    const entry: SessionEntry = {
      sessionId: "test-session",
      updatedAt: Date.now(),
    };

    expect(entry.lastUserMessageAt).toBeUndefined();
    expect(entry.lastAssistantMessageAt).toBeUndefined();
    expect(entry.lastCacheTouchAt).toBeUndefined();
  });
});
