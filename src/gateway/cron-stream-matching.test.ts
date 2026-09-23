import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { WorkerTaskError } from "../infra/worker-task-pool.js";
import * as matcher from "./cron-stream-matcher.js";
import {
  createCronStreamMatchingJob,
  createCronStreamWatcherFixture,
  job,
} from "./cron-stream-watchers.test-helpers.js";

afterEach(() => vi.restoreAllMocks());

describe("cron stream matching lifecycle", () => {
  it("dispatches complete long lines through the matching worker", async () => {
    const { fake, fireBatch, watchers } = createCronStreamWatcherFixture({ minIntervalMs: 1 });
    try {
      await watchers.start(createCronStreamMatchingJob("^build-start .* build-complete$"));
      fake.inputs[0]?.onStdout?.(`build-start ${"x".repeat(3_000)} build-complete\n`);
      await vi.waitFor(() => expect(fireBatch).toHaveBeenCalledOnce(), { timeout: 5_000 });
      expect(fireBatch.mock.calls[0]?.[1]).toMatch(/^build-start x.*\[truncated\]$/u);
    } finally {
      await watchers.stopAll("shutdown");
    }
  });

  it.each(["timeout", "overloaded"] as const)(
    "stops and records a matching %s instead of silently dropping the event",
    async (code) => {
      vi.spyOn(matcher, "matchCronStreamLines").mockRejectedValueOnce(
        new WorkerTaskError(`controlled matcher ${code}`, code),
      );
      const { fake, fireBatch, recordFailure, watchers } = createCronStreamWatcherFixture();
      try {
        await watchers.start(createCronStreamMatchingJob("^ready$"));
        fake.inputs[0]?.onStdout?.("ready\n");
        await vi.waitFor(() => expect(watchers.inspect("stream-job")?.state).toBe("stopped"));
        expect(recordFailure).toHaveBeenCalledWith(
          "stream-job",
          `stream source match failed: controlled matcher ${code}; check the match expression and Gateway load, then re-enable the job`,
          expect.objectContaining({
            streamStatus: "error",
            streamRestartExhausted: true,
          }),
          expect.any(String),
          expect.any(String),
        );
        expect(fake.runs[0]?.cancel).toHaveBeenCalledWith("manual-cancel");
        expect(watchers.inspect("stream-job")?.droppedBatches).toBe(1);
        expect(fireBatch).not.toHaveBeenCalled();
      } finally {
        await watchers.stopAll("shutdown");
      }
    },
  );

  it.each([
    { mode: "line", text: "ready\n", dropped: 1 },
    { mode: "match", text: "ready\n", dropped: 1 },
    { mode: "match", text: "pending\n", dropped: 0 },
  ])("accounts for queued $mode input when disable wins", async ({ mode, text, dropped }) => {
    const { fake, fireBatch, watchers } = createCronStreamWatcherFixture();
    try {
      await watchers.start(mode === "line" ? job() : createCronStreamMatchingJob("^ready$"));
      fake.inputs[0]?.onStdout?.(text);
      await watchers.stop("stream-job", "disabled");
      expect(watchers.inspect("stream-job")?.droppedBatches).toBe(dropped);
      expect(fireBatch).not.toHaveBeenCalled();
    } finally {
      await watchers.stopAll("shutdown");
    }
  });

  it.each(["ready\n", "pending\nready\n"])(
    "joins cancelled matching and accounts for stopped input %j",
    async (chunk) => {
      const entered = createDeferred<AbortSignal | undefined>();
      const result = createDeferred<boolean>();
      vi.spyOn(matcher, "matchCronStreamLines").mockImplementationOnce(
        async (_pattern, _lines, signal) => {
          entered.resolve(signal);
          return await result.promise;
        },
      );
      const { fake, fireBatch, recordFailure, watchers } = createCronStreamWatcherFixture();
      try {
        await watchers.start(createCronStreamMatchingJob("^ready$"));
        fake.inputs[0]?.onStdout?.(chunk);
        const signal = await entered.promise;
        await delay(0);
        let stopped = false;
        const stop = watchers.stop("stream-job", "disabled").then(() => {
          stopped = true;
        });
        expect(signal?.aborted).toBe(true);
        await delay(0);
        expect(stopped).toBe(false);
        result.resolve(true);
        await stop;
        expect(fireBatch).not.toHaveBeenCalled();
        expect(recordFailure).not.toHaveBeenCalled();
        expect(watchers.inspect("stream-job")?.droppedBatches).toBe(1);
        expect(watchers.activeJobIds()).toEqual([]);
      } finally {
        result.resolve(false);
        await watchers.stopAll("shutdown");
      }
    },
  );

  it("does not count a line-mode prefix whose continuation was dropped before disable", async () => {
    const { fake, fireBatch, watchers } = createCronStreamWatcherFixture();
    try {
      await watchers.start(
        job({ schedule: { kind: "stream", command: ["stream-source"], maxBatchBytes: 1_024 } }),
      );
      fake.inputs[0]?.onStdout?.("x".repeat(4_096));
      fake.inputs[0]?.onStdout?.("tail\n");
      await watchers.stop("stream-job", "disabled");
      expect(watchers.inspect("stream-job")?.droppedBatches).toBe(0);
      expect(fireBatch).not.toHaveBeenCalled();
    } finally {
      await watchers.stopAll("shutdown");
    }
  });
});
