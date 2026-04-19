import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MinionQueue } from "../queue.js";
import { MinionStore } from "../store.js";
import { MinionWorker } from "../worker.js";
import { BUILTIN_HANDLERS } from "./index.js";

let tmpDir: string;
let store: MinionStore;
let queue: MinionQueue;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "minions-handlers-"));
  store = MinionStore.openAt(path.join(tmpDir, "queue.sqlite"));
  queue = new MinionQueue(store);
});

afterEach(() => {
  store.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("handler registry", () => {
  it("BUILTIN_HANDLERS is sorted alphabetically", () => {
    const names = BUILTIN_HANDLERS.map((h) => h.name);
    const sorted = [...names].toSorted();
    expect(names).toEqual(sorted);
  });

  it("has exactly 4 built-in handlers", () => {
    expect(BUILTIN_HANDLERS).toHaveLength(4);
  });

  it("all handlers are named with dot notation", () => {
    for (const h of BUILTIN_HANDLERS) {
      expect(h.name).toMatch(/^[a-z]+\.[a-z]+$/);
    }
  });
});

describe("subagent.spawn handler (contract)", () => {
  it("processes a job with task via mock spawn", async () => {
    queue.add("subagent.spawn", {
      task: "summarize the README",
      childSessionKey: "agent:test:subagent:child-1",
      runId: "run-abc-123",
    });

    const worker = new MinionWorker(store, { pollInterval: 50 });
    // Register a mock handler that simulates spawnSubagentDirect's return
    // shape without importing the full agent runtime.
    worker.register("subagent.spawn", async (job) => {
      if (!job.data.task) {
        throw new Error("task required");
      }
      return {
        status: "accepted",
        childSessionKey: job.data.childSessionKey ?? "mock-key",
        runId: job.data.runId ?? "mock-run",
      };
    });
    // Register other handlers from builtins (they're stubs, no heavy imports)
    for (const h of BUILTIN_HANDLERS.filter((h) => h.name !== "subagent.spawn")) {
      worker.register(h.name, h.handler);
    }

    const done = worker.start();
    await sleep(300);
    worker.stop();
    await done;

    const job = queue.getJobs({ name: "subagent.spawn" })[0];
    expect(job.status).toBe("completed");
    expect(job.result).toMatchObject({
      childSessionKey: "agent:test:subagent:child-1",
      runId: "run-abc-123",
    });
  });

  it("rejects missing task", async () => {
    queue.add("subagent.spawn", { runId: "run-1" });

    const worker = new MinionWorker(store, { pollInterval: 50 });
    worker.register("subagent.spawn", async (job) => {
      if (!job.data.task) {
        const { UnrecoverableError } = await import("../types.js");
        throw new UnrecoverableError("task required");
      }
      return {};
    });
    for (const h of BUILTIN_HANDLERS.filter((h) => h.name !== "subagent.spawn")) {
      worker.register(h.name, h.handler);
    }

    const done = worker.start();
    await sleep(300);
    worker.stop();
    await done;

    const job = queue.getJobs({ name: "subagent.spawn" })[0];
    expect(job.status).toBe("dead");
    expect(job.errorText).toMatch(/task required/);
  });
});

describe("acp.spawn handler (stub)", () => {
  it("processes a job with sessionKey", async () => {
    queue.add("acp.spawn", { sessionKey: "agent:test:acp:session-1" });

    const worker = new MinionWorker(store, { pollInterval: 50 });
    for (const h of BUILTIN_HANDLERS) {
      worker.register(h.name, h.handler);
    }

    const done = worker.start();
    await sleep(300);
    worker.stop();
    await done;

    const job = queue.getJobs({ name: "acp.spawn" })[0];
    expect(job.status).toBe("completed");
  });
});

describe("cron.tick handler (stub)", () => {
  it("processes a job with cronId", async () => {
    queue.add("cron.tick", { cronId: "daily-backup", expression: "0 0 * * *" });

    const worker = new MinionWorker(store, { pollInterval: 50 });
    for (const h of BUILTIN_HANDLERS) {
      worker.register(h.name, h.handler);
    }

    const done = worker.start();
    await sleep(300);
    worker.stop();
    await done;

    const job = queue.getJobs({ name: "cron.tick" })[0];
    expect(job.status).toBe("completed");
  });
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
