import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { QuantdWalRecord } from "./types.js";
import { appendQuantdWalRecord, readQuantdWalRecords } from "./wal.js";

describe("quantd wal", () => {
  const cleanupPaths: string[] = [];

  afterEach(async () => {
    await Promise.all(
      cleanupPaths.splice(0).map(async (target) => {
        await fs.rm(target, { recursive: true, force: true });
      }),
    );
  });

  it("appends and replays records in order", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-quantd-wal-"));
    cleanupPaths.push(root);
    const walPath = path.join(root, "quantd.jsonl");

    const records: QuantdWalRecord[] = [
      {
        sequence: 1,
        kind: "heartbeat",
        receivedAt: "2026-03-14T09:00:00.000Z",
        eventId: "hb-1",
        payload: { source: "gateway" },
      },
      {
        sequence: 2,
        kind: "market_event",
        receivedAt: "2026-03-14T09:00:01.000Z",
        eventId: "mkt-1",
        payload: { symbol: "EURUSD", signal: "enter_long" },
      },
    ];

    for (const record of records) {
      await appendQuantdWalRecord({ walPath, record });
    }

    await expect(readQuantdWalRecords({ walPath })).resolves.toEqual(records);
  });
});
