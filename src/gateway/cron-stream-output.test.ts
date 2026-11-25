import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { ProcessSupervisor, SpawnInput } from "../process/supervisor/types.js";
import {
  createCronStreamMatchingJob,
  createCronStreamWatcherFixture,
  exitResult,
  fakeSupervisor,
  job,
  settle,
  flushStreamOutput,
  streamBatchArgs as batchArgs,
  streamStateArgs as stateArgs,
} from "./cron-stream-watchers.test-helpers.js";

vi.mock("./cron-stream-matcher.js", () => ({
  matchCronStreamLines: async (pattern: string, lines: string[]) => {
    const matcher = new RegExp(pattern);
    return lines.some((line) => matcher.test(line));
  },
}));

const fixture = () => createCronStreamWatcherFixture({ minIntervalMs: 1 });
function blockedBatch(result: "busy" | "fired") {
  const gate = createDeferred();
  const fireBatch = vi
    .fn()
    .mockImplementationOnce(async () => {
      await gate.promise;
      return result;
    })
    .mockResolvedValue("fired");
  return { fireBatch, releaseFirst: gate.resolve };
}
const flush = (ms = 100) => flushStreamOutput(ms);

describe("cron stream output", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not match an oversized line by its truncated prefix", async () => {
    const { fake, fireBatch, watchers } = fixture();
    await watchers.start(createCronStreamMatchingJob("^keep"));

    // Delivery truncation must not be confused with incomplete intake.
    fake.inputs[0]?.onStdout?.(`keep ${"x".repeat(2_000)}\n`);
    await flush();
    expect(fireBatch).toHaveBeenCalledOnce();
    expect(fireBatch.mock.calls[0]?.[1]).toMatch(/^keep x/u);
    expect(fireBatch.mock.calls[0]?.[1]).toMatch(/\[truncated\]$/u);

    fake.inputs[0]?.onStdout?.(`keep ${"x".repeat(5_000)}\n`);
    await flush();
    expect(fireBatch).toHaveBeenCalledOnce();
    await watchers.stopAll("shutdown");
  });

  it("treats a line over the intake bound as an unprovable prefix even when callbacks split it", async () => {
    const { fake, fireBatch, watchers } = fixture();
    await watchers.start(createCronStreamMatchingJob("^keep"));

    // Individually bounded fragments still exceed the assembled-line intake cap.
    fake.inputs[0]?.onStdout?.(`keep ${"x".repeat(1_500)}`);
    await settle();
    fake.inputs[0]?.onStdout?.("x".repeat(1_500));
    await settle();
    fake.inputs[0]?.onStdout?.(`${"x".repeat(1_500)}\n`);
    await flush();
    expect(fireBatch).not.toHaveBeenCalled();

    // The oversized line consumed through its newline; the next line is clean.
    fake.inputs[0]?.onStdout?.("keep after\n");
    await flush();
    expect(fireBatch).toHaveBeenCalledOnce();
    expect(fireBatch.mock.calls[0]?.[1]).toBe("keep after");
    await watchers.stopAll("shutdown");
  });

  it("does not synthesize a line across dropped output chunks", async () => {
    const { fake, fireBatch, watchers } = fixture();
    await watchers.start(createCronStreamMatchingJob("^keep$"));

    // Exhaust intake between "kee" and "p": joining them would fabricate "keep".
    fake.inputs[0]?.onStdout?.("kee");
    fake.inputs[0]?.onStderr?.("Z".repeat(4_093));
    fake.inputs[0]?.onStdout?.("DROPPED\n");
    await settle();
    fake.inputs[0]?.onStdout?.("p\n");
    await flush();
    expect(fireBatch).not.toHaveBeenCalled();

    fake.inputs[0]?.onStdout?.("keep\n");
    await flush();
    expect(fireBatch).toHaveBeenCalledOnce();
    expect(fireBatch.mock.calls[0]?.[1]).toBe("keep");
    await watchers.stopAll("shutdown");
  });

  it("does not match a retained prefix when its continuation was dropped before exit", async () => {
    const { fake, fireBatch, watchers } = fixture();
    await watchers.start(createCronStreamMatchingJob("^keep$"));

    // The retained prefix looks like a complete match, but the dropped chunk
    // continued that source line. EOF cannot prove where the real line ended.
    fake.inputs[0]?.onStdout?.("keep");
    fake.inputs[0]?.onStderr?.("Z".repeat(4_092));
    fake.inputs[0]?.onStdout?.("-not-the-end");
    await settle();
    fake.exits[0]?.(exitResult());
    await settle();

    expect(fireBatch).not.toHaveBeenCalled();
    await watchers.stopAll("shutdown");
  });

  it("buffers output emitted before the asynchronous spawn call resolves", async () => {
    const source = fakeSupervisor();
    const spawn = vi.fn(async (input: SpawnInput) => {
      input.onStdout?.("early\n");
      return await source.spawn(input);
    });
    const supervisor = {
      ...source.supervisor,
      spawn,
    } satisfies ProcessSupervisor;
    const { fireBatch, watchers } = createCronStreamWatcherFixture({
      getProcessSupervisor: () => supervisor,
      minIntervalMs: 1,
    });

    await watchers.start(job());
    await vi.advanceTimersByTimeAsync(50);

    expect(fireBatch).toHaveBeenCalledWith(...batchArgs("early"));
    await watchers.stopAll("shutdown");
  });

  it("keeps one bounded pending batch while a payload is busy and honors minimum spacing", async () => {
    vi.setSystemTime(1_000);
    const { fireBatch, releaseFirst } = blockedBatch("fired");
    const { fake, updateState, watchers } = createCronStreamWatcherFixture({
      minIntervalMs: 100,
      fireBatch,
    });
    await watchers.reconcile([job()], true);
    await settle();

    fake.inputs[0]?.onStdout?.("first\n");
    await flush(50);
    fake.inputs[0]?.onStdout?.("second\nthird\n");
    await flush(50);
    expect(fireBatch).toHaveBeenCalledTimes(1);
    releaseFirst();
    await settle();
    await vi.advanceTimersByTimeAsync(49);
    expect(fireBatch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fireBatch).toHaveBeenLastCalledWith(...batchArgs("second\nthird"));
    expect(updateState).toHaveBeenCalledWith(...stateArgs({ streamCoalescedBatches: 1 }));
    await watchers.stopAll("shutdown");
  });

  it("prepends a busy retry ahead of batches that arrived while it was in flight", async () => {
    vi.setSystemTime(1_000);
    const { fireBatch, releaseFirst } = blockedBatch("busy");
    const { fake, watchers } = createCronStreamWatcherFixture({
      minIntervalMs: 1,
      fireBatch,
    });
    await watchers.start(job());

    fake.inputs[0]?.onStdout?.("first\n");
    await flush(50);
    fake.inputs[0]?.onStdout?.("second\n");
    await flush(50);
    releaseFirst();
    await settle();
    await vi.advanceTimersByTimeAsync(1);

    expect(fireBatch).toHaveBeenNthCalledWith(2, ...batchArgs("first\nsecond"));
    await watchers.stopAll("shutdown");
  });

  it("counts a gate drop in the serialized owner", async () => {
    const { fake, updateState, watchers } = createCronStreamWatcherFixture({
      minIntervalMs: 1,
      fireBatch: vi.fn(async () => "dropped" as const),
    });
    await watchers.reconcile([job()], true);
    await settle();

    fake.inputs[0]?.onStdout?.("ignored\n");
    await vi.advanceTimersByTimeAsync(50);

    expect(updateState).toHaveBeenCalledWith(...stateArgs({ streamDroppedBatches: 1 }));
    await watchers.stopAll("shutdown");
  });

  it("counts payload errors and rejected dispatches in the serialized owner", async () => {
    const fireBatch = vi
      .fn<() => Promise<"error">>()
      .mockResolvedValueOnce("error")
      .mockRejectedValueOnce(new Error("dispatch failed"));
    const { fake, updateState, watchers } = createCronStreamWatcherFixture({
      minIntervalMs: 1,
      fireBatch,
    });
    await watchers.reconcile([job()], true);
    await settle();

    fake.inputs[0]?.onStdout?.("failed\n");
    await vi.advanceTimersByTimeAsync(50);
    await settle();

    expect(updateState).toHaveBeenCalledWith(...stateArgs({ streamDroppedBatches: 1 }));

    fake.inputs[0]?.onStdout?.("rejected\n");
    await vi.advanceTimersByTimeAsync(50);
    await settle();
    expect(updateState).toHaveBeenCalledWith(...stateArgs({ streamDroppedBatches: 2 }));
    await watchers.stopAll("shutdown");
  });

  it("fires a batch for an empty line accepted by match mode", async () => {
    const { fake, fireBatch, watchers } = fixture();
    await watchers.reconcile([createCronStreamMatchingJob("^$")], true);
    await settle();

    fake.inputs[0]?.onStdout?.("\n");
    await vi.advanceTimersByTimeAsync(50);

    expect(fireBatch).toHaveBeenCalledWith(...batchArgs(""));
    await watchers.stopAll("shutdown");
  });

  it("stops the source when a once trigger disables its job", async () => {
    const { fake, watchers } = createCronStreamWatcherFixture({
      minIntervalMs: 1,
      fireBatch: vi.fn(async () => "disabled" as const),
    });
    await watchers.reconcile([job()], true);
    await settle();

    fake.inputs[0]?.onStdout?.("once\n");
    await vi.advanceTimersByTimeAsync(50);
    await settle();

    expect(fake.runs[0]?.detachOutput).toHaveBeenCalled();
    expect(fake.runs[0]?.cancel).toHaveBeenCalled();
    expect(watchers.activeJobIds()).toEqual([]);
  });

  it("keeps interleaved stdout and stderr partial lines independent", async () => {
    const { fake, fireBatch, watchers } = fixture();
    await watchers.reconcile([job()], true);
    await settle();

    fake.inputs[0]?.onStdout?.("out");
    fake.inputs[0]?.onStderr?.("err\n");
    fake.inputs[0]?.onStdout?.("put\n");
    await vi.advanceTimersByTimeAsync(50);

    expect(fireBatch).toHaveBeenCalledWith(...batchArgs("err\noutput"));
    await watchers.stopAll("shutdown");
  });
});
