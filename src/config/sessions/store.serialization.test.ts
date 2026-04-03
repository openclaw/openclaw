import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SESSION_STORE_SERIALIZATION_REPLACER } from "./store-serialization.js";
import { clearSessionStoreCacheForTest, loadSessionStore, saveSessionStore } from "./store.js";
import type { SessionEntry } from "./types.js";

// Keep tests deterministic: never read a real openclaw.json.
vi.mock("../config.js", () => ({
  loadConfig: vi.fn().mockReturnValue({}),
}));

let fixtureRoot = "";
let fixtureCount = 0;

beforeAll(async () => {
  fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-serialization-test-"));
});

afterAll(async () => {
  await fs.rm(fixtureRoot, { recursive: true, force: true });
});

beforeEach(() => {
  clearSessionStoreCacheForTest();
});

afterEach(() => {
  clearSessionStoreCacheForTest();
});

function makeEntry(overrides: Partial<SessionEntry> = {}): SessionEntry {
  return {
    sessionId: crypto.randomUUID(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

async function createCaseDir(prefix: string): Promise<string> {
  const dir = path.join(fixtureRoot, `${prefix}-${fixtureCount++}`);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

describe("SESSION_STORE_SERIALIZATION_REPLACER", () => {
  it("strips skillsSnapshot from serialized output", () => {
    const obj = { foo: "bar", skillsSnapshot: { skills: ["a", "b"] } };
    const json = JSON.stringify(obj, SESSION_STORE_SERIALIZATION_REPLACER, 2);
    const parsed = JSON.parse(json);
    expect(parsed.foo).toBe("bar");
    expect(parsed.skillsSnapshot).toBeUndefined();
  });

  it("preserves systemPromptReport (carries warning dedupe state)", () => {
    const report = { tokens: 5000, bootstrapTruncation: { warningSignaturesSeen: ["sig1"] } };
    const obj = { foo: "bar", systemPromptReport: report };
    const json = JSON.stringify(obj, SESSION_STORE_SERIALIZATION_REPLACER, 2);
    const parsed = JSON.parse(json);
    expect(parsed.foo).toBe("bar");
    expect(parsed.systemPromptReport).toEqual(report);
  });

  it("strips skillsSnapshot but keeps systemPromptReport inside session entries", () => {
    const store = {
      "session-1": {
        sessionId: "abc",
        updatedAt: 1000,
        skillsSnapshot: { skills: [{ name: "test", definition: "x".repeat(500) }] },
        systemPromptReport: { tokens: 9999, text: "y".repeat(500) },
      },
    };
    const json = JSON.stringify(store, SESSION_STORE_SERIALIZATION_REPLACER, 2);
    const parsed = JSON.parse(json);
    expect(parsed["session-1"].sessionId).toBe("abc");
    expect(parsed["session-1"].updatedAt).toBe(1000);
    expect(parsed["session-1"].skillsSnapshot).toBeUndefined();
    expect(parsed["session-1"].systemPromptReport).toBeDefined();
  });

  it("preserves all other fields unchanged", () => {
    const entry = {
      sessionId: "test-id",
      updatedAt: 12345,
      channel: "discord",
      lastTo: "user@example.com",
    };
    const json = JSON.stringify(entry, SESSION_STORE_SERIALIZATION_REPLACER, 2);
    const parsed = JSON.parse(json);
    expect(parsed).toEqual(entry);
  });
});

describe("saveSessionStore excludes transient fields from disk", () => {
  let testDir: string;
  let storePath: string;

  beforeEach(async () => {
    testDir = await createCaseDir("serialization");
    storePath = path.join(testDir, "sessions.json");
  });

  it("strips skillsSnapshot but preserves systemPromptReport on disk", async () => {
    const store: Record<string, SessionEntry> = {
      "test-session": makeEntry({
        skillsSnapshot: {
          skills: [{ name: "big-skill", definition: "x".repeat(1000) }],
        } as unknown as SessionEntry["skillsSnapshot"],
        systemPromptReport: {
          bootstrapTruncation: { warningSignaturesSeen: ["sig-abc"] },
        } as unknown as SessionEntry["systemPromptReport"],
      }),
    };

    await saveSessionStore(storePath, store, { skipMaintenance: true });

    const raw = await fs.readFile(storePath, "utf-8");
    const written = JSON.parse(raw);
    expect(written["test-session"].sessionId).toBeDefined();
    expect(written["test-session"].updatedAt).toBeDefined();
    expect(written["test-session"].skillsSnapshot).toBeUndefined();
    expect(written["test-session"].systemPromptReport).toBeDefined();
    expect(raw).not.toContain("skillsSnapshot");
    expect(raw).toContain("systemPromptReport");
  });

  it("round-trips all non-transient fields correctly", async () => {
    const store: Record<string, SessionEntry> = {
      "session-a": makeEntry({
        channel: "discord",
        lastTo: "user1",
        skillsSnapshot: { huge: "data" } as unknown as SessionEntry["skillsSnapshot"],
      }),
      "session-b": makeEntry({
        channel: "telegram",
        lastTo: "user2",
      }),
    };

    await saveSessionStore(storePath, store, { skipMaintenance: true });
    clearSessionStoreCacheForTest();
    const loaded = loadSessionStore(storePath);

    expect(loaded["session-a"].channel).toBe("discord");
    expect(loaded["session-a"].lastTo).toBe("user1");
    expect(loaded["session-a"].skillsSnapshot).toBeUndefined();
    expect(loaded["session-b"].channel).toBe("telegram");
    expect(loaded["session-b"].lastTo).toBe("user2");
  });
});
