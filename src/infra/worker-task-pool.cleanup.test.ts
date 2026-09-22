import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import { WorkerTaskPool } from "./worker-task-pool.js";
import type { PoolFixtureInput, PoolFixtureResult } from "./worker-task-pool.test-support.js";

const cleanup = vi.hoisted(() => vi.fn<() => Promise<void>>());
vi.mock("./temp-artifact-cleanup.js", () => ({ removeTemporaryArtifacts: cleanup }));

const workerUrl = new URL("./worker-task-pool.test-support.ts", import.meta.url);

describe("worker task artifact lifetime", () => {
  it("releases stopped execution before disposal while every close joins pending cleanup", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "worker-cleanup-owner-"));
    const gate = createDeferredCore();
    const entered = createDeferredCore();
    const context = new AsyncLocalStorage<string>();
    let cleanupContext: string | undefined;
    cleanup
      .mockImplementationOnce(() => {
        cleanupContext = context.getStore();
        entered.resolve();
        return gate.promise;
      })
      .mockResolvedValue(undefined);
    const roots: string[] = [];
    const pool = new WorkerTaskPool<PoolFixtureInput, PoolFixtureResult>({
      workerUrl,
      maxWorkers: 1,
      maxPendingTasks: 1,
      prepareWorker: () => {
        const owned = fs.mkdtempSync(path.join(directory, "generation-"));
        roots.push(owned);
        return { options: {}, temporaryDirectory: owned };
      },
    });
    try {
      const controller = new AbortController();
      const counters = new SharedArrayBuffer(8);
      const active = context.run("request", () =>
        pool.run({ label: "held", counters, wait: true }, { signal: controller.signal }),
      );
      let taskSettled = false;
      void active
        .finally(() => {
          taskSettled = true;
        })
        .catch(() => {});
      await expect.poll(() => Atomics.load(new Int32Array(counters), 0)).toBe(1);
      context.run("request", () => controller.abort(new Error("canceled owner")));
      await entered.promise;
      expect(cleanupContext).toBeUndefined();
      await expect.poll(() => taskSettled).toBe(true);
      await expect(active).rejects.toThrow("canceled owner");
      await expect(pool.run({ label: "replacement" }, {})).resolves.toMatchObject({
        label: "replacement",
      });
      expect(new Set(roots).size).toBe(2);
      let closed = false;
      const closing = Promise.all([pool.close(), pool.close()]).then(() => {
        closed = true;
      });
      await expect.poll(() => cleanup.mock.calls.length).toBe(2);
      expect(closed).toBe(false);
      gate.resolve();
      await closing;
      expect(closed).toBe(true);
    } finally {
      gate.resolve();
      await pool.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
