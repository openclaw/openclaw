import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearPendingInbound,
  readPendingInbound,
  writePendingInbound,
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
});
