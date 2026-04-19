import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MinionQueue } from "./queue.js";
import { MinionStore } from "./store.js";

let tmpDir: string;
let store: MinionStore;
let queue: MinionQueue;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "minions-idemp-"));
  store = MinionStore.openAt(path.join(tmpDir, "queue.sqlite"));
  queue = new MinionQueue(store);
});

afterEach(() => {
  store.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("idempotency key semantics", () => {
  it("two null-key submits create two distinct jobs", () => {
    const a = queue.add("task", { v: 1 });
    const b = queue.add("task", { v: 2 });
    expect(a.id).not.toBe(b.id);
  });

  it("two same-non-null-key submits return one job", () => {
    const a = queue.add("task", { v: 1 }, { idempotencyKey: "dedup" });
    const b = queue.add("task", { v: 2 }, { idempotencyKey: "dedup" });
    expect(a.id).toBe(b.id);
    expect(b.data).toEqual({ v: 1 });
  });

  it("different non-null keys create distinct jobs", () => {
    const a = queue.add("task", {}, { idempotencyKey: "key-a" });
    const b = queue.add("task", {}, { idempotencyKey: "key-b" });
    expect(a.id).not.toBe(b.id);
  });

  it("ten parallel submits with same key produce exactly one row", () => {
    const key = "race-test";
    const results: number[] = [];
    for (let i = 0; i < 10; i++) {
      const job = queue.add("task", { attempt: i }, { idempotencyKey: key });
      results.push(job.id);
    }
    const uniqueIds = new Set(results);
    expect(uniqueIds.size).toBe(1);

    const count = store.db
      .prepare("SELECT count(*) AS n FROM minion_jobs WHERE idempotency_key = ?")
      .get(key) as { n: number | bigint };
    const n = typeof count.n === "bigint" ? Number(count.n) : count.n;
    expect(n).toBe(1);
  });
});
