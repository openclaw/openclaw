import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearActiveTurn,
  clearPendingInbound,
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
});
