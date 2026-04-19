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
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "minions-cascade-"));
  store = MinionStore.openAt(path.join(tmpDir, "queue.sqlite"));
  queue = new MinionQueue(store);
});

afterEach(() => {
  store.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("cascade cancel", () => {
  it("cancels depth-3 subtree in one call", () => {
    const root = queue.add("root");
    const c1 = queue.add("c1", {}, { parentJobId: root.id });
    const c2 = queue.add("c2", {}, { parentJobId: c1.id });
    const c3 = queue.add("c3", {}, { parentJobId: c2.id });

    queue.cancelJob(root.id);

    expect(queue.getJob(root.id)!.status).toBe("cancelled");
    expect(queue.getJob(c1.id)!.status).toBe("cancelled");
    expect(queue.getJob(c2.id)!.status).toBe("cancelled");
    expect(queue.getJob(c3.id)!.status).toBe("cancelled");
  });

  it("does not cancel already-completed descendants", () => {
    const root = queue.add("root");
    const c1 = queue.add("c1", {}, { parentJobId: root.id });
    const claimed = queue.claim("tok", 30000, "default", ["c1"])!;
    queue.completeJob(claimed.id, "tok", claimed.attemptsMade, {});

    queue.cancelJob(root.id);

    expect(queue.getJob(root.id)!.status).toBe("cancelled");
    expect(queue.getJob(c1.id)!.status).toBe("completed");
  });

  it("handles wide fan-out (50 children)", () => {
    const root = queue.add("root", {}, { maxChildren: 50 });
    const childIds: number[] = [];
    for (let i = 0; i < 50; i++) {
      const child = queue.add(`c${i}`, {}, { parentJobId: root.id });
      childIds.push(child.id);
    }

    queue.cancelJob(root.id);

    for (const id of childIds) {
      expect(queue.getJob(id)!.status).toBe("cancelled");
    }
  });

  it("cancels mixed-depth tree (some active, some waiting)", () => {
    const root = queue.add("root");
    const c1 = queue.add("c1", {}, { parentJobId: root.id });
    queue.claim("tok-c1", 30000, "default", ["c1"]);
    const c2 = queue.add("c2", {}, { parentJobId: root.id });
    const c3 = queue.add("c3", {}, { parentJobId: c2.id });

    queue.cancelJob(root.id);

    expect(queue.getJob(c1.id)!.status).toBe("cancelled");
    expect(queue.getJob(c2.id)!.status).toBe("cancelled");
    expect(queue.getJob(c3.id)!.status).toBe("cancelled");
  });

  it("parent_job_id self-reference CHECK prevents cycle", () => {
    const job = queue.add("job");
    expect(() => {
      store.db
        .prepare("UPDATE minion_jobs SET parent_job_id = ? WHERE id = ?")
        .run(job.id, job.id);
    }).toThrow(/CHECK constraint/i);
  });
});
