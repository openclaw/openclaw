import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  findBestSnapshot,
  formatSnapshotPrefix,
  hashResult,
  writeCronSnapshot,
  type CronSnapshot,
} from "./snapshot.js";

let tmpDir: string;
let storePath: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cron-snap-test-"));
  storePath = path.join(tmpDir, "cron-store.json");
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function makeSnapshot(overrides: Partial<CronSnapshot> = {}): CronSnapshot {
  return {
    ts: Date.now(),
    jobId: "test-job",
    source: "realtime",
    result: "Sales: $1,234",
    durationMs: 5000,
    ...overrides,
  };
}

describe("writeCronSnapshot + findBestSnapshot", () => {
  it("writes and reads back a snapshot", async () => {
    const snap = makeSnapshot();
    await writeCronSnapshot({ storePath, snapshot: snap });
    const found = await findBestSnapshot({ storePath, jobId: "test-job" });
    expect(found).not.toBeNull();
    expect(found!.result).toBe("Sales: $1,234");
    expect(found!.source).toBe("realtime");
  });

  it("returns null when no snapshots exist", async () => {
    const found = await findBestSnapshot({ storePath, jobId: "nonexistent" });
    expect(found).toBeNull();
  });

  it("prefers 24h realtime over older snapshot", async () => {
    const now = Date.now();
    const old = makeSnapshot({ ts: now - 48 * 3600 * 1000, result: "old data" });
    const recent = makeSnapshot({ ts: now - 1 * 3600 * 1000, result: "recent data" });
    await writeCronSnapshot({ storePath, snapshot: old });
    await writeCronSnapshot({ storePath, snapshot: recent });
    const found = await findBestSnapshot({ storePath, jobId: "test-job" });
    expect(found!.result).toBe("recent data");
  });

  it("falls back to 72h when nothing in 24h", async () => {
    const now = Date.now();
    const snap = makeSnapshot({ ts: now - 50 * 3600 * 1000, result: "48h old data" });
    await writeCronSnapshot({ storePath, snapshot: snap });
    const found = await findBestSnapshot({ storePath, jobId: "test-job" });
    expect(found).not.toBeNull();
    expect(found!.result).toBe("48h old data");
  });

  it("returns null when all snapshots are older than 72h", async () => {
    const now = Date.now();
    const snap = makeSnapshot({ ts: now - 100 * 3600 * 1000, result: "very old" });
    await writeCronSnapshot({ storePath, snapshot: snap });
    const found = await findBestSnapshot({ storePath, jobId: "test-job" });
    expect(found).toBeNull();
  });
});

describe("formatSnapshotPrefix", () => {
  it("formats date correctly", () => {
    const snap = makeSnapshot({ ts: new Date("2026-02-19T14:30:00Z").getTime() });
    const prefix = formatSnapshotPrefix(snap);
    expect(prefix).toContain("2026-02-19");
    expect(prefix).toContain("not realtime");
  });
});

describe("hashResult", () => {
  it("returns consistent 16-char hex hash", () => {
    const h1 = hashResult("Sales: $1,234");
    const h2 = hashResult("Sales: $1,234");
    expect(h1).toBe(h2);
    expect(h1).toHaveLength(16);
    expect(h1).toMatch(/^[0-9a-f]{16}$/);
  });

  it("returns different hash for different input", () => {
    const h1 = hashResult("Sales: $1,234");
    const h2 = hashResult("Sales: $5,678");
    expect(h1).not.toBe(h2);
  });
});

describe("snapshot pruning", () => {
  it("prunes excess snapshots beyond 50", async () => {
    // Write 55 snapshots.
    const now = Date.now();
    for (let i = 0; i < 55; i++) {
      await writeCronSnapshot({
        storePath,
        snapshot: makeSnapshot({ ts: now - (55 - i) * 1000, result: `entry-${i}` }),
      });
    }
    const dir = path.join(path.dirname(storePath), "snapshots", "test-job");
    const files = await fs.readdir(dir);
    expect(files.filter((f) => f.endsWith(".json")).length).toBeLessThanOrEqual(50);
  });
});
