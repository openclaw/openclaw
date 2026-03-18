import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearSessionStoreCacheForTest, loadSessionStore, saveSessionStore, updateLastRoute } from "./store.js";
import type { SessionEntry } from "./types.js";

// Prevent reads of a real openclaw.json during tests.
vi.mock("../config.js", () => ({
  loadConfig: vi.fn().mockReturnValue({}),
}));

let testDir = "";

beforeEach(async () => {
  testDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-ulr-test-"));
});

afterEach(async () => {
  clearSessionStoreCacheForTest();
  await fs.rm(testDir, { recursive: true, force: true });
});

function makeEntry(updatedAt: number): SessionEntry {
  return { sessionId: crypto.randomUUID(), updatedAt };
}

describe("updateLastRoute", () => {
  it("does not bump updatedAt for an existing session", async () => {
    // Verifies fix for issue #49515: updateLastRoute was calling mergeSessionEntry
    // which reset updatedAt to Date.now() on every inbound message, preventing
    // idle/daily session resets from firing.
    const storePath = path.join(testDir, "sessions.json");
    const sessionKey = "agent:main:telegram:dm:user-1";
    const originalUpdatedAt = Date.now() - 60_000; // 1 minute ago

    const initial: Record<string, SessionEntry> = {
      [sessionKey]: makeEntry(originalUpdatedAt),
    };
    await saveSessionStore(storePath, initial);

    await updateLastRoute({
      storePath,
      sessionKey,
      deliveryContext: { channel: "telegram", to: "telegram:user-1" },
    });

    const store = loadSessionStore(storePath);
    const entry = store[sessionKey];
    expect(entry).toBeDefined();
    // updatedAt must not be bumped to wall-clock time — it should stay at originalUpdatedAt
    // so that evaluateSessionFreshness can correctly detect idle sessions.
    expect(entry!.updatedAt).toBe(originalUpdatedAt);
  });

  it("sets updatedAt to now for a new (non-existing) session", async () => {
    const storePath = path.join(testDir, "sessions.json");
    await saveSessionStore(storePath, {});

    const before = Date.now();
    await updateLastRoute({
      storePath,
      sessionKey: "agent:main:telegram:dm:user-2",
      deliveryContext: { channel: "telegram", to: "telegram:user-2" },
    });
    const after = Date.now();

    const store = loadSessionStore(storePath);
    const entry = store["agent:main:telegram:dm:user-2"];
    expect(entry).toBeDefined();
    expect(entry!.updatedAt).toBeGreaterThanOrEqual(before);
    expect(entry!.updatedAt).toBeLessThanOrEqual(after);
  });
});
