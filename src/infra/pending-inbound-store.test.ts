import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearActiveTurn,
  clearAllActiveTurns,
  clearPendingInbound,
  clearPendingInboundEntries,
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

  it("writePendingInbound prunes oldest entries when exceeding MAX_PENDING_ENTRIES (200)", async () => {
    // Write 210 entries sequentially — oldest 10 should be pruned.
    for (let i = 0; i < 210; i++) {
      await writePendingInbound(stateDir, {
        channel: "telegram",
        id: `prune-${i}`,
        payload: { index: i },
        capturedAt: 1700000000000 + i,
      });
    }

    const result = await readPendingInbound(stateDir);
    expect(result).toHaveLength(200);

    // The 10 oldest (capturedAt 1700000000000..1700000000009) should be pruned.
    const capturedAts = result.map((e) => e.capturedAt).toSorted((a, b) => a - b);
    expect(capturedAts[0]).toBeGreaterThanOrEqual(1700000000010);
  });

  it("writeActiveTurn prunes oldest turns when exceeding MAX_ACTIVE_TURNS (50)", async () => {
    // Write 60 turns sequentially — oldest 10 should be pruned.
    for (let i = 0; i < 60; i++) {
      await writeActiveTurn(stateDir, {
        sessionId: `sess-prune-${i}`,
        sessionKey: `telegram:${i}`,
        channel: "telegram",
        startedAt: 1700000000000 + i,
      });
    }

    const result = await readStaleActiveTurns(stateDir);
    expect(result).toHaveLength(50);

    // The 10 oldest (startedAt 1700000000000..1700000000009) should be pruned.
    const startedAts = result.map((e) => e.startedAt).toSorted((a, b) => a - b);
    expect(startedAts[0]).toBeGreaterThanOrEqual(1700000000010);
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
});
