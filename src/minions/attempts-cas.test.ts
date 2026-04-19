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
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "minions-cas-"));
  store = MinionStore.openAt(path.join(tmpDir, "queue.sqlite"));
  queue = new MinionQueue(store);
});

afterEach(() => {
  store.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("CAS guard on complete/fail", () => {
  it("completeJob succeeds with matching attempts_made", () => {
    queue.add("echo");
    const claimed = queue.claim("tok", 30000, "default", ["echo"])!;
    const result = queue.completeJob(claimed.id, "tok", claimed.attemptsMade, { ok: true });
    expect(result).not.toBeNull();
    expect(result!.status).toBe("completed");
  });

  it("completeJob rejects stale attempts_made (simulates double-execution)", () => {
    queue.add("echo");
    const claimed = queue.claim("tok", 30000, "default", ["echo"])!;
    const result = queue.completeJob(claimed.id, "tok", claimed.attemptsMade + 1, { ok: true });
    expect(result).toBeNull();
    const job = queue.getJob(claimed.id)!;
    expect(job.status).toBe("active");
  });

  it("failJob rejects stale attempts_made", () => {
    queue.add("echo");
    const claimed = queue.claim("tok", 30000, "default", ["echo"])!;
    const result = queue.failJob(claimed.id, "tok", claimed.attemptsMade + 1, "err", "failed");
    expect(result).toBeNull();
    const job = queue.getJob(claimed.id)!;
    expect(job.status).toBe("active");
  });

  it("only one of two concurrent completions wins", () => {
    queue.add("echo");
    const claimed = queue.claim("tok-1", 30000, "default", ["echo"])!;

    const firstWins = queue.completeJob(claimed.id, "tok-1", claimed.attemptsMade, { winner: 1 });
    expect(firstWins).not.toBeNull();

    const secondLoses = queue.completeJob(claimed.id, "tok-1", claimed.attemptsMade, { winner: 2 });
    expect(secondLoses).toBeNull();

    const job = queue.getJob(claimed.id)!;
    expect(job.result).toEqual({ winner: 1 });
  });
});
