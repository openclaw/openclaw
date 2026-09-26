import assert from "node:assert/strict";
import { threadId } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { serveOwnedWorkerTasks } from "./worker-task-server.js";

export type ResourceFixtureInput = { retain?: string; wait?: SharedArrayBuffer };
export type ResourceFixtureReply = { keys: string[]; threadId: number };
const resources = new Set<string>();
serveOwnedWorkerTasks<ResourceFixtureReply>(
  async (input) => {
    assert.ok(isRecord(input));
    if (input.retain !== undefined) {
      assert.ok(typeof input.retain === "string");
      resources.add(input.retain);
    }
    if (input.wait) {
      assert.ok(input.wait instanceof SharedArrayBuffer);
      const barrier = new Int32Array(input.wait);
      Atomics.store(barrier, 0, 1);
      await Atomics.waitAsync(barrier, 1, 0).value;
    }
    return { keys: [...resources], threadId };
  },
  {
    closeResource(key) {
      if (key === "fail-once" && resources.delete(key)) {
        throw new Error("Retained resource close refused");
      }
      if (key === undefined) {
        resources.clear();
      } else {
        resources.delete(key);
      }
    },
  },
);
