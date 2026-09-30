import { afterAll, describe, expect, it, vi } from "vitest";
import { resolveRuntimeProcessEntrypointUrl } from "../infra/runtime-process-url.js";
import { WorkerTaskPool } from "../infra/worker-task-pool.js";
import { createDeferredCore } from "../shared/deferred.js";
import { matchCronStreamLines } from "./cron-stream-matcher.js";

const pool = new WorkerTaskPool<{ pattern: string; lines: string[] }, boolean>({
  workerUrl: resolveRuntimeProcessEntrypointUrl("cronStreamMatcher"),
  maxWorkers: 1,
});

afterAll(async () => {
  await pool.close();
});

describe("cron stream matcher", () => {
  it.each([
    {
      name: "long complete line",
      pattern: "^build-start .* build-complete$",
      lines: [`build-start ${"x".repeat(3_000)} build-complete`],
      matches: true,
    },
    {
      name: "long line with a different ending",
      pattern: "^build-start .* build-complete$",
      lines: [`build-start ${"x".repeat(3_000)} build-incomplete`],
      matches: false,
    },
    { name: "empty line", pattern: "^$", lines: [""], matches: true },
    { name: "no source lines", pattern: "^$", lines: [], matches: false },
    {
      name: "match after a nonmatching line",
      pattern: "^ready$",
      lines: ["pending", "ready"],
      matches: true,
    },
    {
      name: "separate complete lines",
      pattern: "^build-start .* build-complete$",
      lines: ["build-start ", " build-complete"],
      matches: false,
    },
  ])("evaluates $name in the worker", async ({ pattern, lines, matches }) => {
    await expect(pool.run({ pattern, lines }, { timeoutMs: 10_000 })).resolves.toBe(matches);
  });

  it("expires delayed matching instead of returning a nonmatch", async () => {
    vi.useFakeTimers();
    const release = createDeferredCore();
    const entered = createDeferredCore();
    const delayed = vi.spyOn(WorkerTaskPool.prototype, "run");
    delayed.mockImplementationOnce(function (
      this: WorkerTaskPool<unknown, unknown>,
      input,
      options,
    ) {
      delayed.mockRestore();
      return this.run(async () => {
        entered.resolve();
        await release.promise;
        return input;
      }, options);
    });
    try {
      const result = expect(matchCronStreamLines("^ready$", ["ready"])).rejects.toMatchObject({
        code: "timeout",
      });
      await entered.promise;
      await vi.advanceTimersByTimeAsync(3_000);
      await result;
    } finally {
      release.resolve();
      delayed.mockRestore();
      vi.useRealTimers();
    }
  });
});
