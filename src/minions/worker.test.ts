import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MinionQueue } from "./queue.js";
import { MinionStore } from "./store.js";
import { MinionWorker } from "./worker.js";

let tmpDir: string;
let dbPath: string;
let store: MinionStore;
let queue: MinionQueue;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "minions-worker-"));
  dbPath = path.join(tmpDir, "queue.sqlite");
  store = MinionStore.openAt(dbPath);
  queue = new MinionQueue(store);
});

afterEach(() => {
  store.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("MinionWorker", () => {
  it("registers handlers and sorts names deterministically", () => {
    const worker = new MinionWorker(store);
    worker.register("z-handler", async () => ({}));
    worker.register("a-handler", async () => ({}));
    worker.register("m-handler", async () => ({}));
    expect(worker.registeredNames).toEqual(["a-handler", "m-handler", "z-handler"]);
  });

  it("throws if start() called with no handlers", async () => {
    const worker = new MinionWorker(store);
    await expect(worker.start()).rejects.toThrow("No handlers registered");
  });

  it("processes a job end-to-end", async () => {
    queue.add("echo", { msg: "hello" });

    const worker = new MinionWorker(store, { pollInterval: 50, concurrency: 1 });
    let handlerCalled = false;
    let receivedData: Record<string, unknown> = {};

    worker.register("echo", async (job) => {
      handlerCalled = true;
      receivedData = job.data;
      return { echoed: true };
    });

    const done = worker.start();
    await sleep(200);
    worker.stop();
    await done;

    expect(handlerCalled).toBe(true);
    expect(receivedData).toEqual({ msg: "hello" });

    const job = queue.getJobs({ name: "echo" })[0];
    expect(job.status).toBe("completed");
    expect(job.result).toEqual({ echoed: true });
  });

  it("retries on handler error with backoff", async () => {
    queue.add("flaky", {}, { maxAttempts: 3, backoffDelay: 10, backoffJitter: 0 });

    let attempts = 0;
    const worker = new MinionWorker(store, { pollInterval: 50 });
    worker.register("flaky", async () => {
      attempts++;
      if (attempts < 3) {
        throw new Error("temporary failure");
      }
      return { ok: true };
    });

    const done = worker.start();
    await sleep(1500);
    worker.stop();
    await done;

    expect(attempts).toBeGreaterThanOrEqual(2);
  });

  it("dead-letters on UnrecoverableError without retry", async () => {
    const { UnrecoverableError } = await import("./types.js");
    queue.add("fatal", {}, { maxAttempts: 5 });

    let attempts = 0;
    const worker = new MinionWorker(store, { pollInterval: 50 });
    worker.register("fatal", async () => {
      attempts++;
      throw new UnrecoverableError("permanent failure");
    });

    const done = worker.start();
    await sleep(200);
    worker.stop();
    await done;

    expect(attempts).toBe(1);
    const job = queue.getJobs({ name: "fatal" })[0];
    expect(job.status).toBe("dead");
  });

  it("sets handler_pid on claim", async () => {
    queue.add("echo", {});

    const worker = new MinionWorker(store, { pollInterval: 50 });
    worker.register("echo", async (job) => {
      const row = queue.getJob(job.id)!;
      expect(row.handlerPid).toBe(process.pid);
      return {};
    });

    const done = worker.start();
    await sleep(200);
    worker.stop();
    await done;
  });
});

describe("backoff", () => {
  it("calculates exponential backoff", async () => {
    const { calculateBackoff } = await import("./backoff.js");
    const base = calculateBackoff({
      backoffType: "exponential",
      backoffDelay: 1000,
      backoffJitter: 0,
      attemptsMade: 1,
    });
    expect(base).toBe(1000);

    const second = calculateBackoff({
      backoffType: "exponential",
      backoffDelay: 1000,
      backoffJitter: 0,
      attemptsMade: 3,
    });
    expect(second).toBe(4000);
  });

  it("calculates fixed backoff", async () => {
    const { calculateBackoff } = await import("./backoff.js");
    const val = calculateBackoff({
      backoffType: "fixed",
      backoffDelay: 2000,
      backoffJitter: 0,
      attemptsMade: 5,
    });
    expect(val).toBe(2000);
  });
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
