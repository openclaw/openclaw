import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearActiveTurn,
  clearAllActiveTurns,
  clearPendingInbound,
  clearPendingInboundEntries,
  readActiveTurn,
  readPendingInbound,
  readStaleActiveTurns,
  writeActiveTurn,
  writePendingInbound,
  type ActiveTurnEntry,
  type PendingInboundEntry,
} from "./pending-inbound-store.js";

describe("pending-inbound-store", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-pending-inbound-"));
  });

  afterEach(() => {
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it("write + read round-trip", async () => {
    const entry: PendingInboundEntry = {
      channel: "telegram",
      id: "12345",
      payload: { chatId: 999, text: "hello" },
      capturedAt: 1700000000000,
    };

    await writePendingInbound(stateDir, entry);
    const result = await readPendingInbound(stateDir);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(entry);
  });

  it("dedup: writing same channel:id twice only stores one entry", async () => {
    const entry1: PendingInboundEntry = {
      channel: "telegram",
      id: "100",
      payload: { text: "first" },
      capturedAt: 1700000000000,
    };
    const entry2: PendingInboundEntry = {
      channel: "telegram",
      id: "100",
      payload: { text: "second" },
      capturedAt: 1700000001000,
    };

    await writePendingInbound(stateDir, entry1);
    await writePendingInbound(stateDir, entry2);
    const result = await readPendingInbound(stateDir);

    expect(result).toHaveLength(1);
    // Second write overwrites first
    expect(result[0].payload).toEqual({ text: "second" });
    expect(result[0].capturedAt).toBe(1700000001000);
  });

  it("dedup: multi-account Discord — same message seen by two accounts stored independently", async () => {
    // Two Discord bot accounts both see the same message (same channel + message id).
    // Without accountId in the key the second write silently overwrites the first.
    // With accountId each account's capture gets its own slot.
    const messageId = "msg-discord-999";
    const entryAccount1: PendingInboundEntry = {
      channel: "discord",
      id: messageId,
      accountId: "bot-account-A",
      payload: { text: "from account A", accountId: "bot-account-A" },
      capturedAt: 1700000000000,
    };
    const entryAccount2: PendingInboundEntry = {
      channel: "discord",
      id: messageId,
      accountId: "bot-account-B",
      payload: { text: "from account B", accountId: "bot-account-B" },
      capturedAt: 1700000000001,
    };

    await writePendingInbound(stateDir, entryAccount1);
    await writePendingInbound(stateDir, entryAccount2);
    const result = await readPendingInbound(stateDir);

    // Both entries must be retained — different accounts, same message id
    expect(result).toHaveLength(2);
    const payloads = result.map((e) => (e.payload as { text: string }).text).toSorted();
    expect(payloads).toEqual(["from account A", "from account B"]);
  });

  it("dedup: same Discord message + same account still deduplicates", async () => {
    // Same bot account capturing the same message twice (e.g. handler called twice)
    // must still deduplicate to a single entry.
    const entry1: PendingInboundEntry = {
      channel: "discord",
      id: "msg-dup-111",
      accountId: "bot-account-A",
      payload: { text: "first capture" },
      capturedAt: 1700000000000,
    };
    const entry2: PendingInboundEntry = {
      channel: "discord",
      id: "msg-dup-111",
      accountId: "bot-account-A",
      payload: { text: "second capture" },
      capturedAt: 1700000000100,
    };

    await writePendingInbound(stateDir, entry1);
    await writePendingInbound(stateDir, entry2);
    const result = await readPendingInbound(stateDir);

    expect(result).toHaveLength(1);
    // Second write overwrites first (same account + same message = same key)
    expect((result[0].payload as { text: string }).text).toBe("second capture");
  });

  it("stores multiple entries with different keys", async () => {
    await writePendingInbound(stateDir, {
      channel: "telegram",
      id: "1",
      payload: { text: "tg message" },
      capturedAt: 1700000000000,
    });
    await writePendingInbound(stateDir, {
      channel: "discord",
      id: "2",
      payload: { text: "dc message" },
      capturedAt: 1700000001000,
    });
    await writePendingInbound(stateDir, {
      channel: "telegram",
      id: "3",
      payload: { text: "another tg" },
      capturedAt: 1700000002000,
    });

    const result = await readPendingInbound(stateDir);
    expect(result).toHaveLength(3);

    const channels = result.map((e) => `${e.channel}:${e.id}`).toSorted();
    expect(channels).toEqual(["discord:2", "telegram:1", "telegram:3"]);
  });

  it("clear removes file", async () => {
    await writePendingInbound(stateDir, {
      channel: "telegram",
      id: "1",
      payload: {},
      capturedAt: Date.now(),
    });

    // File exists
    const before = await readPendingInbound(stateDir);
    expect(before).toHaveLength(1);

    await clearPendingInbound(stateDir);

    // File removed — read returns empty
    const after = await readPendingInbound(stateDir);
    expect(after).toEqual([]);
  });

  it("read on missing file returns []", async () => {
    const result = await readPendingInbound(stateDir);
    expect(result).toEqual([]);
  });

  it("clear on missing file does not throw", async () => {
    await expect(clearPendingInbound(stateDir)).resolves.toBeUndefined();
  });

  it("capturedAt is preserved correctly", async () => {
    const now = Date.now();
    await writePendingInbound(stateDir, {
      channel: "telegram",
      id: "42",
      payload: { text: "test" },
      capturedAt: now,
    });

    const result = await readPendingInbound(stateDir);
    expect(result).toHaveLength(1);
    expect(result[0].capturedAt).toBe(now);
  });

  // --- Active Turn tests ---

  it("writeActiveTurn + readStaleActiveTurns round-trip", async () => {
    const turn: ActiveTurnEntry = {
      sessionId: "sess-001",
      sessionKey: "telegram:12345",
      channel: "telegram",
      startedAt: 1700000000000,
    };

    await writeActiveTurn(stateDir, turn);
    const result = await readStaleActiveTurns(stateDir);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(turn);
  });

  it("clearActiveTurn removes entry", async () => {
    await writeActiveTurn(stateDir, {
      sessionId: "sess-002",
      sessionKey: "telegram:999",
      channel: "telegram",
      startedAt: 1700000000000,
    });
    await writeActiveTurn(stateDir, {
      sessionId: "sess-003",
      sessionKey: "discord:channel:456",
      channel: "discord",
      startedAt: 1700000001000,
    });

    await clearActiveTurn(stateDir, "sess-002");
    const result = await readStaleActiveTurns(stateDir);

    expect(result).toHaveLength(1);
    expect(result[0].sessionId).toBe("sess-003");
  });

  it("readStaleActiveTurns on missing file returns []", async () => {
    const result = await readStaleActiveTurns(stateDir);
    expect(result).toEqual([]);
  });

  it("scheduler session keys are stored and readable (delivery-target resolution skips them at recovery)", async () => {
    // Scheduler isolated sessions use keys like "scheduler:jobid:runid".
    // The store saves them normally — server-startup.ts skips them during
    // active-turn recovery because no delivery target resolves for these
    // session keys (they have no channel mapping).
    const turn: ActiveTurnEntry = {
      sessionId: "sess-sched-001",
      sessionKey: "scheduler:abc123:run456",
      channel: "system",
      startedAt: 1700000000000,
    };

    await writeActiveTurn(stateDir, turn);
    const result = await readStaleActiveTurns(stateDir);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(turn);
    expect(result[0].sessionKey).toMatch(/^scheduler:/);
  });

  it("active turns and pending inbound entries coexist without collision", async () => {
    // Write a pending inbound entry
    await writePendingInbound(stateDir, {
      channel: "telegram",
      id: "msg-100",
      payload: { text: "hello" },
      capturedAt: 1700000000000,
    });

    // Write an active turn entry
    await writeActiveTurn(stateDir, {
      sessionId: "sess-010",
      sessionKey: "telegram:777",
      channel: "telegram",
      startedAt: 1700000001000,
    });

    // Both should be independently readable
    const pending = await readPendingInbound(stateDir);
    expect(pending).toHaveLength(1);
    expect(pending[0].id).toBe("msg-100");

    const turns = await readStaleActiveTurns(stateDir);
    expect(turns).toHaveLength(1);
    expect(turns[0].sessionId).toBe("sess-010");

    // Clearing one does not affect the other
    await clearActiveTurn(stateDir, "sess-010");
    const pendingAfter = await readPendingInbound(stateDir);
    expect(pendingAfter).toHaveLength(1);
    expect(pendingAfter[0].id).toBe("msg-100");

    const turnsAfter = await readStaleActiveTurns(stateDir);
    expect(turnsAfter).toEqual([]);
  });

  // --- Scoped clear functions ---

  it("clearPendingInboundEntries removes entries but preserves active turns", async () => {
    await writePendingInbound(stateDir, {
      channel: "telegram",
      id: "msg-200",
      payload: { text: "hello" },
      capturedAt: 1700000000000,
    });
    await writeActiveTurn(stateDir, {
      sessionId: "sess-020",
      sessionKey: "telegram:888",
      channel: "telegram",
      startedAt: 1700000001000,
    });

    await clearPendingInboundEntries(stateDir);

    const pending = await readPendingInbound(stateDir);
    expect(pending).toEqual([]);

    // Active turns should still be there
    const turns = await readStaleActiveTurns(stateDir);
    expect(turns).toHaveLength(1);
    expect(turns[0].sessionId).toBe("sess-020");
  });

  it("clearAllActiveTurns removes turns but preserves inbound entries", async () => {
    await writePendingInbound(stateDir, {
      channel: "telegram",
      id: "msg-300",
      payload: { text: "preserved" },
      capturedAt: 1700000000000,
    });
    await writeActiveTurn(stateDir, {
      sessionId: "sess-030",
      sessionKey: "telegram:999",
      channel: "telegram",
      startedAt: 1700000001000,
    });
    await writeActiveTurn(stateDir, {
      sessionId: "sess-031",
      sessionKey: "discord:channel:100",
      channel: "discord",
      startedAt: 1700000002000,
    });

    await clearAllActiveTurns(stateDir);

    const turns = await readStaleActiveTurns(stateDir);
    expect(turns).toEqual([]);

    // Inbound entries should still be there
    const pending = await readPendingInbound(stateDir);
    expect(pending).toHaveLength(1);
    expect(pending[0].id).toBe("msg-300");
  });

  it("clearPendingInboundEntries on missing file does not throw", async () => {
    await expect(clearPendingInboundEntries(stateDir)).resolves.toBeUndefined();
  });

  it("clearAllActiveTurns on missing file does not throw", async () => {
    await expect(clearAllActiveTurns(stateDir)).resolves.toBeUndefined();
  });

  // --- Session key stored at capture time ---

  it("sessionKey is stored and readable on pending inbound entries", async () => {
    const entry: PendingInboundEntry = {
      channel: "telegram",
      id: "msg-400",
      payload: { text: "with key" },
      capturedAt: 1700000000000,
      sessionKey: "agent:main:telegram:direct:12345",
    };

    await writePendingInbound(stateDir, entry);
    const result = await readPendingInbound(stateDir);

    expect(result).toHaveLength(1);
    expect(result[0].sessionKey).toBe("agent:main:telegram:direct:12345");
  });

  it("entries without sessionKey remain backward compatible (undefined)", async () => {
    const entry: PendingInboundEntry = {
      channel: "telegram",
      id: "msg-401",
      payload: { text: "no key" },
      capturedAt: 1700000000000,
    };

    await writePendingInbound(stateDir, entry);
    const result = await readPendingInbound(stateDir);

    expect(result).toHaveLength(1);
    expect(result[0].sessionKey).toBeUndefined();
  });

  // --- Concurrent write safety (lock serialization) ---

  it("concurrent writes do not lose entries (lock serialization)", async () => {
    // Fire 10 concurrent writes — without locking some would be lost.
    const writes = Array.from({ length: 10 }, (_, i) =>
      writePendingInbound(stateDir, {
        channel: "telegram",
        id: `concurrent-${i}`,
        payload: { index: i },
        capturedAt: 1700000000000 + i,
      }),
    );
    await Promise.all(writes);

    const result = await readPendingInbound(stateDir);
    expect(result).toHaveLength(10);
  });

  // --- Bounded store growth (pruning) ---

  it("writePendingInbound rejects new entries when at MAX_PENDING_ENTRIES (200) capacity", async () => {
    // Write exactly 200 entries to fill the store.
    for (let i = 0; i < 200; i++) {
      const accepted = await writePendingInbound(stateDir, {
        channel: "telegram",
        id: `fill-${i}`,
        payload: { index: i },
        capturedAt: 1700000000000 + i,
      });
      expect(accepted).toBe(true);
    }

    // The 201st entry should be rejected (not silently drop oldest).
    const rejected = await writePendingInbound(stateDir, {
      channel: "telegram",
      id: "overflow-entry",
      payload: { index: 200 },
      capturedAt: 1700000000200,
    });
    expect(rejected).toBe(false);

    const result = await readPendingInbound(stateDir);
    expect(result).toHaveLength(200);

    // All original 200 entries are preserved (none silently dropped).
    const ids = result.map((e) => e.id).toSorted();
    expect(ids).not.toContain("overflow-entry");
    expect(ids).toContain("fill-0"); // oldest is still there
    expect(ids).toContain("fill-199"); // newest is still there
  });

  it("writePendingInbound allows dedup overwrites even when at capacity", async () => {
    // Fill the store to capacity.
    for (let i = 0; i < 200; i++) {
      await writePendingInbound(stateDir, {
        channel: "telegram",
        id: `fill-${i}`,
        payload: { index: i },
        capturedAt: 1700000000000 + i,
      });
    }

    // Overwriting an existing key (same channel:id) should succeed even at capacity.
    const accepted = await writePendingInbound(stateDir, {
      channel: "telegram",
      id: "fill-50",
      payload: { index: 50, updated: true },
      capturedAt: 1700000000050,
    });
    expect(accepted).toBe(true);

    const result = await readPendingInbound(stateDir);
    expect(result).toHaveLength(200);
  });

  it("writeActiveTurn rejects new entries when at MAX_ACTIVE_TURNS (50) capacity", async () => {
    // Write exactly 50 turns to fill the tracking map.
    for (let i = 0; i < 50; i++) {
      const accepted = await writeActiveTurn(stateDir, {
        sessionId: `sess-fill-${i}`,
        sessionKey: `telegram:${i}`,
        channel: "telegram",
        startedAt: 1700000000000 + i,
      });
      expect(accepted).toBe(true);
    }

    // The 51st entry should be rejected (not evict oldest).
    const rejected = await writeActiveTurn(stateDir, {
      sessionId: "sess-overflow",
      sessionKey: "telegram:overflow",
      channel: "telegram",
      startedAt: 1700000000050,
    });
    expect(rejected).toBe(false);

    const result = await readStaleActiveTurns(stateDir);
    expect(result).toHaveLength(50);

    // All original 50 entries are preserved (none silently evicted).
    const sessionIds = result.map((e) => e.sessionId).toSorted();
    expect(sessionIds).not.toContain("sess-overflow");
    expect(sessionIds).toContain("sess-fill-0"); // oldest is still there
    expect(sessionIds).toContain("sess-fill-49"); // newest is still there
  });

  it("writeActiveTurn allows overwrites of same sessionId even when at capacity", async () => {
    // Fill the tracking map to capacity.
    for (let i = 0; i < 50; i++) {
      await writeActiveTurn(stateDir, {
        sessionId: `sess-fill-${i}`,
        sessionKey: `telegram:${i}`,
        channel: "telegram",
        startedAt: 1700000000000 + i,
      });
    }

    // Overwriting an existing sessionId should succeed even at capacity.
    const accepted = await writeActiveTurn(stateDir, {
      sessionId: "sess-fill-25",
      sessionKey: "telegram:25",
      channel: "telegram",
      startedAt: 1700000099999,
    });
    expect(accepted).toBe(true);

    const result = await readStaleActiveTurns(stateDir);
    expect(result).toHaveLength(50);
  });

  it("concurrent active turn writes do not lose entries", async () => {
    const writes = Array.from({ length: 10 }, (_, i) =>
      writeActiveTurn(stateDir, {
        sessionId: `sess-concurrent-${i}`,
        sessionKey: `telegram:${i}`,
        channel: "telegram",
        startedAt: 1700000000000 + i,
      }),
    );
    await Promise.all(writes);

    const result = await readStaleActiveTurns(stateDir);
    expect(result).toHaveLength(10);
  });

  // --- processStartedAt guard (server-startup recovery filter) ---
  //
  // server-startup.ts records processStartedAt = Date.now() before channels
  // start, then filters readStaleActiveTurns() to skip entries where
  // startedAt >= processStartedAt (those are live turns from this process,
  // not stale leftovers from a previous process).  These tests validate
  // that filtering logic at the data level.

  it("processStartedAt guard: turns before boot are stale, turns at/after boot are live", async () => {
    const processStartedAt = 1700000005000;

    // Stale turn from previous process (startedAt < processStartedAt)
    await writeActiveTurn(stateDir, {
      sessionId: "sess-stale-1",
      sessionKey: "telegram:111",
      channel: "telegram",
      startedAt: 1700000000000, // well before boot
    });

    // Another stale turn, just barely before boot
    await writeActiveTurn(stateDir, {
      sessionId: "sess-stale-2",
      sessionKey: "telegram:222",
      channel: "telegram",
      startedAt: 1700000004999, // 1ms before boot
    });

    // Live turn from THIS process (startedAt === processStartedAt)
    await writeActiveTurn(stateDir, {
      sessionId: "sess-live-1",
      sessionKey: "telegram:333",
      channel: "telegram",
      startedAt: 1700000005000, // exactly at boot
    });

    // Live turn from THIS process (startedAt > processStartedAt)
    await writeActiveTurn(stateDir, {
      sessionId: "sess-live-2",
      sessionKey: "telegram:444",
      channel: "telegram",
      startedAt: 1700000006000, // after boot
    });

    const allTurns = await readStaleActiveTurns(stateDir);
    expect(allTurns).toHaveLength(4);

    // Apply the same filter that server-startup.ts uses
    const staleTurns = allTurns.filter((t) => t.startedAt < processStartedAt);
    const liveTurns = allTurns.filter((t) => t.startedAt >= processStartedAt);

    expect(staleTurns).toHaveLength(2);
    expect(staleTurns.map((t) => t.sessionId).toSorted()).toEqual(["sess-stale-1", "sess-stale-2"]);

    expect(liveTurns).toHaveLength(2);
    expect(liveTurns.map((t) => t.sessionId).toSorted()).toEqual(["sess-live-1", "sess-live-2"]);
  });

  it("processStartedAt guard: all turns before boot are stale (no false positives)", async () => {
    const processStartedAt = Date.now();

    // Write turns with timestamps in the past
    for (let i = 0; i < 5; i++) {
      await writeActiveTurn(stateDir, {
        sessionId: `sess-old-${i}`,
        sessionKey: `telegram:${i}`,
        channel: "telegram",
        startedAt: processStartedAt - 60_000 + i * 1000, // 60s to 56s ago
      });
    }

    const allTurns = await readStaleActiveTurns(stateDir);
    const staleTurns = allTurns.filter((t) => t.startedAt < processStartedAt);

    expect(staleTurns).toHaveLength(5);
    // None should be skipped — all are from "previous process"
    expect(allTurns.filter((t) => t.startedAt >= processStartedAt)).toHaveLength(0);
  });

  it("processStartedAt guard: all turns after boot are live (no false negatives)", async () => {
    const processStartedAt = Date.now() - 1000; // boot 1s ago

    // Write turns with timestamps after boot (simulating new turns from this process)
    for (let i = 0; i < 3; i++) {
      await writeActiveTurn(stateDir, {
        sessionId: `sess-new-${i}`,
        sessionKey: `telegram:${i}`,
        channel: "telegram",
        startedAt: processStartedAt + 100 + i * 100, // 100ms to 300ms after boot
      });
    }

    const allTurns = await readStaleActiveTurns(stateDir);
    const liveTurns = allTurns.filter((t) => t.startedAt >= processStartedAt);

    expect(liveTurns).toHaveLength(3);
    // None should be recovered — all are from "this process"
    expect(allTurns.filter((t) => t.startedAt < processStartedAt)).toHaveLength(0);
  });

  // --- readActiveTurn (single-entry re-validation, TOCTOU guard) ---

  it("readActiveTurn returns the entry for an existing sessionId", async () => {
    const turn: ActiveTurnEntry = {
      sessionId: "sess-read-001",
      sessionKey: "telegram:12345",
      channel: "telegram",
      startedAt: 1700000010000,
    };
    await writeActiveTurn(stateDir, turn);

    const result = await readActiveTurn(stateDir, "sess-read-001");
    expect(result).toEqual(turn);
  });

  it("readActiveTurn returns undefined for a non-existent sessionId", async () => {
    await writeActiveTurn(stateDir, {
      sessionId: "sess-read-002",
      sessionKey: "telegram:99999",
      channel: "telegram",
      startedAt: 1700000010000,
    });

    const result = await readActiveTurn(stateDir, "sess-read-MISSING");
    expect(result).toBeUndefined();
  });

  it("readActiveTurn returns undefined after the entry is cleared", async () => {
    await writeActiveTurn(stateDir, {
      sessionId: "sess-read-003",
      sessionKey: "telegram:77777",
      channel: "telegram",
      startedAt: 1700000010000,
    });

    await clearActiveTurn(stateDir, "sess-read-003");

    const result = await readActiveTurn(stateDir, "sess-read-003");
    expect(result).toBeUndefined();
  });

  it("readActiveTurn returns undefined on missing file", async () => {
    const result = await readActiveTurn(stateDir, "sess-read-no-file");
    expect(result).toBeUndefined();
  });

  it("readActiveTurn reflects an updated startedAt after a re-write (TOCTOU guard)", async () => {
    const processStartedAt = 1700000005000;

    // Simulate stale turn from previous process written before snapshot
    await writeActiveTurn(stateDir, {
      sessionId: "sess-toctou-001",
      sessionKey: "telegram:111",
      channel: "telegram",
      startedAt: 1700000000000, // stale: before processStartedAt
    });

    // Take snapshot (mirrors readStaleActiveTurns in server-startup)
    const snapshot = await readStaleActiveTurns(stateDir);
    expect(snapshot).toHaveLength(1);
    const snapshotTurn = snapshot[0];
    expect(snapshotTurn.startedAt).toBeLessThan(processStartedAt);

    // Simulate a fresh turn written under the same sessionId AFTER the snapshot
    // (e.g. channel handler started a new turn that recycled the sessionId)
    await writeActiveTurn(stateDir, {
      sessionId: "sess-toctou-001",
      sessionKey: "telegram:111",
      channel: "telegram",
      startedAt: 1700000010000, // fresh: after processStartedAt
    });

    // Re-validate by reading the current store entry
    const current = await readActiveTurn(stateDir, "sess-toctou-001");
    expect(current).toBeDefined();
    // startedAt has changed — the recovery loop should skip this entry
    expect(current!.startedAt).not.toBe(snapshotTurn.startedAt);
    expect(current!.startedAt).toBe(1700000010000);
  });

  // --- File permission tests (Aisle Low #3) ---

  it("pending-inbound.json is written with mode 0o600", async () => {
    await writePendingInbound(stateDir, {
      channel: "telegram",
      id: "perm-test-1",
      payload: { text: "secret" },
      capturedAt: Date.now(),
    });

    const filePath = path.join(stateDir, "pending-inbound.json");
    const stat = await fsp.stat(filePath);
    // Mask to the low 9 permission bits (strip file type bits)
    const mode = stat.mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("state dir is created with mode 0o700", async () => {
    // Use a sub-directory that does not yet exist
    const subDir = path.join(stateDir, "sub-state-dir");

    await writePendingInbound(subDir, {
      channel: "telegram",
      id: "perm-test-2",
      payload: { text: "secret" },
      capturedAt: Date.now(),
    });

    const stat = await fsp.stat(subDir);
    const mode = stat.mode & 0o777;
    expect(mode).toBe(0o700);
  });

  // --- Unhandled rejection guard (P1 inline comment #2912274100) ---
  //
  // withInProcessQueue attaches a .finally() cleanup to the internal promise
  // chain and must suppress the resulting mirror-rejection with .catch(() => {})
  // to prevent Node.js from emitting an unhandled-rejection event when the
  // queued operation fails.  This test verifies that a failing write:
  //   a) rejects the returned promise (caller sees the error), AND
  //   b) does not leave a dangling unhandled-rejection on the cleanup promise.

  it("failed write rejects the returned promise but does not leak an unhandled rejection", async () => {
    // Simulate a write failure by making the state dir a file (not a directory),
    // which causes mkdir/writeFile inside writeJsonAtomic to throw ENOTDIR/EEXIST.
    const fakeStateDir = path.join(stateDir, "not-a-dir.txt");
    await fsp.writeFile(fakeStateDir, "I am a file, not a directory", "utf8");

    const unhandledRejections: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandledRejections.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);

    let caughtError: unknown;
    try {
      await writePendingInbound(fakeStateDir, {
        channel: "telegram",
        id: "rej-test-1",
        payload: {},
        capturedAt: Date.now(),
      });
    } catch (err) {
      caughtError = err;
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }

    // Caller must see the error
    expect(caughtError).toBeDefined();

    // Flush the microtask queue so any dangling rejections would fire
    await new Promise((resolve) => setTimeout(resolve, 20));

    // No unhandled rejections should have escaped
    expect(unhandledRejections).toHaveLength(0);
  });
});
