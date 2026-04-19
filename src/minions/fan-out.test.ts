import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { submitFanOut } from "./fan-out.js";
import { MinionQueue } from "./queue.js";
import { MinionStore } from "./store.js";

let tmpDir: string;
let store: MinionStore;
let queue: MinionQueue;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "minions-fanout-"));
  store = MinionStore.openAt(path.join(tmpDir, "queue.sqlite"));
  queue = new MinionQueue(store);
});

afterEach(() => {
  store.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("submitFanOut", () => {
  it("creates parent + N children atomically", () => {
    const result = submitFanOut(queue, "batch", [
      { name: "task", data: { idx: 0 } },
      { name: "task", data: { idx: 1 } },
      { name: "task", data: { idx: 2 } },
    ]);

    expect(result.parent.status).toBe("waiting-children");
    expect(result.children).toHaveLength(3);
    for (const child of result.children) {
      expect(child.parentJobId).toBe(result.parent.id);
      expect(child.depth).toBe(1);
      expect(child.status).toBe("waiting");
    }
  });

  it("cascade-cancel from parent kills all children", () => {
    const result = submitFanOut(queue, "batch", [
      { name: "task", data: { idx: 0 } },
      { name: "task", data: { idx: 1 } },
      { name: "task", data: { idx: 2 } },
    ]);

    queue.cancelJob(result.parent.id);

    for (const child of result.children) {
      expect(queue.getJob(child.id)!.status).toBe("cancelled");
    }
    expect(queue.getJob(result.parent.id)!.status).toBe("cancelled");
  });

  it("rejects empty children array", () => {
    expect(() => submitFanOut(queue, "batch", [])).toThrow(
      "Fan-out requires at least one child",
    );
  });

  it("respects maxChildren from parentOpts", () => {
    const result = submitFanOut(
      queue,
      "batch",
      [{ name: "task" }, { name: "task" }],
      { maxChildren: 5 },
    );
    expect(queue.getJob(result.parent.id)!.maxChildren).toBe(5);
  });

  it("parent resolves to waiting when all children complete", () => {
    const result = submitFanOut(queue, "batch", [
      { name: "task", data: { idx: 0 } },
      { name: "task", data: { idx: 1 } },
    ]);

    for (const child of result.children) {
      const claimed = queue.claim("tok", 30000, "default", ["task"])!;
      queue.completeJob(claimed.id, "tok", claimed.attemptsMade, { done: true });
    }

    expect(queue.getJob(result.parent.id)!.status).toBe("waiting");
  });

  it("rolls up tokens from all children to parent", () => {
    const result = submitFanOut(queue, "batch", [
      { name: "task", data: { idx: 0 } },
      { name: "task", data: { idx: 1 } },
      { name: "task", data: { idx: 2 } },
    ]);

    for (let i = 0; i < 3; i++) {
      const claimed = queue.claim("tok", 30000, "default", ["task"])!;
      queue.updateTokens(claimed.id, "tok", { input: 100, output: 50, cacheRead: 25 });
      queue.completeJob(claimed.id, "tok", claimed.attemptsMade, {});
    }

    const parent = queue.getJob(result.parent.id)!;
    expect(parent.tokensInput).toBe(300);
    expect(parent.tokensOutput).toBe(150);
    expect(parent.tokensCacheRead).toBe(75);
  });
});
