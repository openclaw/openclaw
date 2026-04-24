import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createFixtureSuite } from "../../test-utils/fixture-suite.js";
import {
  isProtectedSessionMaintenanceEntry,
  pruneOrphanedTranscripts,
  resolveMaintenanceConfigFromInput,
  resolveSessionEntryMaintenanceHighWater,
} from "./store-maintenance.js";
import { capEntryCount, getActiveSessionMaintenanceWarning, pruneStaleEntries } from "./store.js";
import type { SessionEntry } from "./types.js";

const DAY_MS = 24 * 60 * 60 * 1000;

const fixtureSuite = createFixtureSuite("openclaw-pruning-suite-");

beforeAll(async () => {
  await fixtureSuite.setup();
});

afterAll(async () => {
  await fixtureSuite.cleanup();
});

function makeEntry(updatedAt: number): SessionEntry {
  return { sessionId: crypto.randomUUID(), updatedAt };
}

function makeStore(entries: Array<[string, SessionEntry]>): Record<string, SessionEntry> {
  return Object.fromEntries(entries);
}

// ---------------------------------------------------------------------------
// Unit tests — each function called with explicit override parameters.
// No config loading needed; overrides bypass resolveMaintenanceConfig().
// ---------------------------------------------------------------------------

describe("pruneStaleEntries", () => {
  it("removes entries older than maxAgeDays", () => {
    const now = Date.now();
    const store = makeStore([
      ["old", makeEntry(now - 31 * DAY_MS)],
      ["fresh", makeEntry(now - 1 * DAY_MS)],
    ]);

    const pruned = pruneStaleEntries(store, 30 * DAY_MS);

    expect(pruned).toBe(1);
    expect(store.old).toBeUndefined();
    expect(store.fresh).toBeDefined();
  });

  it("preserves durable external conversation entries", () => {
    const now = Date.now();
    const store = makeStore([
      ["old", makeEntry(now - 31 * DAY_MS)],
      ["agent:main:slack:channel:C123:thread:1710000000.000100", makeEntry(now - 31 * DAY_MS)],
      ["agent:main:telegram:group:-100123:topic:77", makeEntry(now - 31 * DAY_MS)],
      ["agent:main:slack:channel:C999", makeEntry(now - 31 * DAY_MS)],
      ["agent:main:telegram:group:-100123", { ...makeEntry(now - 31 * DAY_MS), chatType: "group" }],
      ["agent:main:discord:channel:ops", { ...makeEntry(now - 31 * DAY_MS), chatType: "channel" }],
    ]);

    const pruned = pruneStaleEntries(store, 30 * DAY_MS);

    expect(pruned).toBe(1);
    expect(store.old).toBeUndefined();
    expect(store["agent:main:slack:channel:C123:thread:1710000000.000100"]).toBeDefined();
    expect(store["agent:main:telegram:group:-100123:topic:77"]).toBeDefined();
    expect(store["agent:main:slack:channel:C999"]).toBeDefined();
    expect(store["agent:main:telegram:group:-100123"]).toBeDefined();
    expect(store["agent:main:discord:channel:ops"]).toBeDefined();
  });
});

describe("capEntryCount", () => {
  it("over limit: keeps N most recent by updatedAt, deletes rest", () => {
    const now = Date.now();
    const store = makeStore([
      ["oldest", makeEntry(now - 4 * DAY_MS)],
      ["old", makeEntry(now - 3 * DAY_MS)],
      ["mid", makeEntry(now - 2 * DAY_MS)],
      ["recent", makeEntry(now - 1 * DAY_MS)],
      ["newest", makeEntry(now)],
    ]);

    const evicted = capEntryCount(store, 3);

    expect(evicted).toBe(2);
    expect(Object.keys(store)).toHaveLength(3);
    expect(store.newest).toBeDefined();
    expect(store.recent).toBeDefined();
    expect(store.mid).toBeDefined();
    expect(store.oldest).toBeUndefined();
    expect(store.old).toBeUndefined();
  });

  it("preserves durable external conversation entries when capping", () => {
    const now = Date.now();
    const threadKey = "agent:main:discord:channel:123456:thread:987654";
    const store = makeStore([
      [threadKey, makeEntry(now - 5 * DAY_MS)],
      ["oldest", makeEntry(now - 4 * DAY_MS)],
      ["old", makeEntry(now - 3 * DAY_MS)],
      ["recent", makeEntry(now - 1 * DAY_MS)],
      ["newest", makeEntry(now)],
    ]);

    const evicted = capEntryCount(store, 3);

    expect(evicted).toBe(2);
    expect(Object.keys(store)).toHaveLength(3);
    expect(store[threadKey]).toBeDefined();
    expect(store.newest).toBeDefined();
    expect(store.recent).toBeDefined();
    expect(store.oldest).toBeUndefined();
    expect(store.old).toBeUndefined();
  });
});

describe("isProtectedSessionMaintenanceEntry", () => {
  it("does not protect synthetic sessions just because they carry group metadata", () => {
    expect(
      isProtectedSessionMaintenanceEntry("agent:main:subagent:worker", {
        ...makeEntry(Date.now()),
        chatType: "group",
      }),
    ).toBe(false);
    expect(
      isProtectedSessionMaintenanceEntry("agent:main:cron:job:run:123", {
        ...makeEntry(Date.now()),
        origin: { chatType: "group" },
      }),
    ).toBe(false);
  });

  it("protects metadata-less Telegram topic keys without treating every :topic: id as a thread", () => {
    expect(
      isProtectedSessionMaintenanceEntry(
        "agent:main:telegram:group:-100123:topic:77",
        makeEntry(Date.now()),
      ),
    ).toBe(true);
    expect(
      isProtectedSessionMaintenanceEntry(
        "agent:main:opaque:topic:om_topic_root:sender:ou_topic_user",
        makeEntry(Date.now()),
      ),
    ).toBe(false);
  });

  it("protects metadata-less channel session keys and channel chat metadata", () => {
    expect(
      isProtectedSessionMaintenanceEntry("agent:main:slack:channel:C123", makeEntry(Date.now())),
    ).toBe(true);
    expect(
      isProtectedSessionMaintenanceEntry(
        "agent:main:custom:channel:room-one:with:colon",
        makeEntry(Date.now()),
      ),
    ).toBe(true);
    expect(
      isProtectedSessionMaintenanceEntry("agent:main:opaque", {
        ...makeEntry(Date.now()),
        chatType: "channel",
      }),
    ).toBe(true);
  });
});

describe("resolveMaintenanceConfigFromInput", () => {
  it("defaults to enforcing session maintenance", () => {
    const maintenance = resolveMaintenanceConfigFromInput();

    expect(maintenance.mode).toBe("enforce");
  });

  it("batches normal entry-count maintenance for production-sized caps", () => {
    expect(resolveSessionEntryMaintenanceHighWater(2)).toBe(3);
    expect(resolveSessionEntryMaintenanceHighWater(50)).toBe(75);
    expect(resolveSessionEntryMaintenanceHighWater(500)).toBe(550);
  });
});

describe("getActiveSessionMaintenanceWarning", () => {
  it("warns when the active session is outside the retained recent entries", () => {
    const now = Date.now();
    const store = makeStore([
      ["newest", makeEntry(now)],
      ["recent", makeEntry(now - 1)],
      ["active", makeEntry(now - 2)],
      ["old", makeEntry(now - 3)],
    ]);

    const warning = getActiveSessionMaintenanceWarning({
      store,
      activeSessionKey: "active",
      pruneAfterMs: DAY_MS,
      maxEntries: 2,
      nowMs: now,
    });

    expect(warning?.wouldCap).toBe(true);
    expect(warning?.wouldPrune).toBe(false);
  });

  it("preserves insertion order tie behavior from stable sorting", () => {
    const now = Date.now();
    const store = makeStore([
      ["same-before", makeEntry(now)],
      ["active", makeEntry(now)],
      ["same-after", makeEntry(now)],
    ]);

    const warning = getActiveSessionMaintenanceWarning({
      store,
      activeSessionKey: "active",
      pruneAfterMs: DAY_MS,
      maxEntries: 1,
      nowMs: now,
    });

    expect(warning?.wouldCap).toBe(true);
  });
});

describe("pruneOrphanedTranscripts", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await fixtureSuite.createCaseDir("orphan-prune");
  });

  async function writeTranscript(
    fileName: string,
    headerSessionId: string,
    mtimeOffsetMs: number,
  ): Promise<void> {
    const filePath = path.join(testDir, `${fileName}.jsonl`);
    const header = {
      type: "session",
      version: 1,
      id: headerSessionId,
      timestamp: new Date().toISOString(),
    };
    await fs.writeFile(filePath, `${JSON.stringify(header)}\n`, "utf-8");
    if (mtimeOffsetMs !== 0) {
      const mtime = new Date(Date.now() + mtimeOffsetMs);
      await fs.utimes(filePath, mtime, mtime);
    }
  }

  it("warn mode: reports orphans but does not delete", async () => {
    await writeTranscript("orphan-old", "orphan-old", -60 * DAY_MS);
    await writeTranscript("kept", "kept", 0);
    const store = makeStore([["active", { sessionId: "kept", updatedAt: Date.now() }]]);

    const result = await pruneOrphanedTranscripts(testDir, store, {
      mode: "warn",
      pruneAfterMs: 30 * DAY_MS,
    });

    expect(result.pruned).toBe(0);
    expect(result.wouldPrune).toBe(1);
    expect(result.wouldBytes).toBeGreaterThan(0);
    const remaining = (await fs.readdir(testDir)).toSorted();
    expect(remaining).toEqual(["kept.jsonl", "orphan-old.jsonl"]);
  });

  it("enforce mode: unlinks orphan older than grace window", async () => {
    await writeTranscript("orphan-old", "orphan-old", -60 * DAY_MS);
    await writeTranscript("kept", "kept", 0);
    const store = makeStore([["active", { sessionId: "kept", updatedAt: Date.now() }]]);

    const result = await pruneOrphanedTranscripts(testDir, store, {
      mode: "enforce",
      pruneAfterMs: 30 * DAY_MS,
    });

    expect(result.pruned).toBe(1);
    expect(result.bytes).toBeGreaterThan(0);
    expect(result.wouldPrune).toBe(0);
    const remaining = await fs.readdir(testDir);
    expect(remaining).toContain("kept.jsonl");
    expect(remaining).not.toContain("orphan-old.jsonl");
    // bytes actually reclaimed, not hidden in a sibling archive directory
    expect(remaining).not.toContain(".orphans-archive");
  });

  it("preserves orphan transcripts younger than pruneAfterMs", async () => {
    await writeTranscript("orphan-young", "orphan-young", -1 * DAY_MS);
    const store = makeStore([]);

    const result = await pruneOrphanedTranscripts(testDir, store, {
      mode: "enforce",
      pruneAfterMs: 30 * DAY_MS,
    });

    expect(result.pruned).toBe(0);
    expect(result.wouldPrune).toBe(0);
    const remaining = await fs.readdir(testDir);
    expect(remaining).toContain("orphan-young.jsonl");
  });

  it("preserves topic-thread transcript (sessionId-topic-threadId.jsonl) without explicit sessionFile", async () => {
    // Topic sessions derive transcript path as `${sessionId}-topic-${encoded-topicId}.jsonl`
    // via resolveSessionTranscriptPathInDir. The stored SessionEntry may only carry sessionId;
    // the live transcript file would otherwise look like an orphan to a naive scanner.
    // File header carries the live sessionId; filename reflects the derived
    // topic path produced by resolveSessionTranscriptPathInDir.
    await writeTranscript("abc-uuid-topic-456", "abc-uuid", -60 * DAY_MS);
    const store = makeStore([
      ["agent:main:channel:thread-456", { sessionId: "abc-uuid", updatedAt: Date.now() }],
    ]);

    const result = await pruneOrphanedTranscripts(testDir, store, {
      mode: "enforce",
      pruneAfterMs: 30 * DAY_MS,
    });

    expect(result.pruned).toBe(0);
    const remaining = await fs.readdir(testDir);
    expect(remaining).toContain("abc-uuid-topic-456.jsonl");
  });

  it("treats sessionFile basename as a reference (transcript name != current sessionId)", async () => {
    // Header id reflects the live sessionId written by ensureSessionHeader.
    await writeTranscript("legacy-file-id", "new-session-id", -60 * DAY_MS);
    const store = makeStore([
      [
        "active",
        {
          sessionId: "new-session-id",
          sessionFile: path.join(testDir, "legacy-file-id.jsonl"),
          updatedAt: Date.now(),
        },
      ],
    ]);

    const result = await pruneOrphanedTranscripts(testDir, store, {
      mode: "enforce",
      pruneAfterMs: 30 * DAY_MS,
    });

    expect(result.pruned).toBe(0);
    const remaining = await fs.readdir(testDir);
    expect(remaining).toContain("legacy-file-id.jsonl");
  });

  it("missing sessions dir: no-op, no throw", async () => {
    const missingDir = path.join(testDir, "does-not-exist");
    const result = await pruneOrphanedTranscripts(
      missingDir,
      {},
      {
        mode: "enforce",
        pruneAfterMs: 30 * DAY_MS,
      },
    );
    expect(result.pruned).toBe(0);
    expect(result.wouldPrune).toBe(0);
  });

  it("ignores non-jsonl files and subdirectories", async () => {
    await writeTranscript("orphan-old", "orphan-old", -60 * DAY_MS);
    await fs.writeFile(path.join(testDir, "sessions.json"), "{}", "utf-8");
    await fs.mkdir(path.join(testDir, "some-subdir"), { recursive: true });

    const result = await pruneOrphanedTranscripts(
      testDir,
      {},
      {
        mode: "enforce",
        pruneAfterMs: 30 * DAY_MS,
      },
    );

    expect(result.pruned).toBe(1);
    const remaining = await fs.readdir(testDir);
    expect(remaining).toContain("sessions.json");
    expect(remaining).toContain("some-subdir");
  });

  it("does not delete unrelated .jsonl files lacking a session header (custom session.store scenario)", async () => {
    // Simulate a custom session.store dir that contains unrelated logs or
    // exports. The old-enough .jsonl without a session header must be left
    // alone even though its name would pass the filename filter.
    const filePath = path.join(testDir, "my-unrelated-log.jsonl");
    await fs.writeFile(filePath, `{"kind":"log","ts":"2025-01-01T00:00:00Z"}\n`, "utf-8");
    const mtime = new Date(Date.now() - 60 * DAY_MS);
    await fs.utimes(filePath, mtime, mtime);

    const result = await pruneOrphanedTranscripts(
      testDir,
      {},
      {
        mode: "enforce",
        pruneAfterMs: 30 * DAY_MS,
      },
    );

    expect(result.pruned).toBe(0);
    const remaining = await fs.readdir(testDir);
    expect(remaining).toContain("my-unrelated-log.jsonl");
  });
});
