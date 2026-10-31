import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createRealtimeVoiceAgentTalkbackQueue } from "./agent-talkback-runtime.js";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

type QueueParams = Parameters<typeof createRealtimeVoiceAgentTalkbackQueue>[0];

function createQueue(params: Pick<QueueParams, "consult"> & Partial<QueueParams>) {
  const logger = { info: vi.fn(), warn: vi.fn() };
  const deliver = vi.fn();
  const queue = createRealtimeVoiceAgentTalkbackQueue({
    debounceMs: 1,
    isStopped: () => false,
    logger,
    logPrefix: "[test]",
    responseStyle: "brief",
    fallbackText: "fallback",
    deliver,
    ...params,
  });
  return { queue, logger, deliver };
}

async function createPendingQueue(debounceMs = 1) {
  const { promise: pending, resolve } = createDeferred<{ text: string }>();
  const consult = vi
    .fn<QueueParams["consult"]>()
    .mockImplementationOnce(() => pending)
    .mockResolvedValue({ text: "queued-answer" });
  const fixture = createQueue({ consult, debounceMs });
  fixture.queue.enqueue("first");
  await vi.advanceTimersByTimeAsync(debounceMs);
  return {
    ...fixture,
    consult,
    finish: async () => {
      resolve({ text: "first-answer" });
      await vi.runAllTimersAsync();
    },
  };
}

describe("realtime voice agent talkback queue", () => {
  it("keeps active pending questions split by metadata", async () => {
    const ownerMetadata = { senderIsOwner: true };
    const guestMetadata = { senderIsOwner: false };
    const { queue, deliver, consult, finish } = await createPendingQueue(10);
    consult
      .mockResolvedValueOnce({ text: "owner-answer" })
      .mockResolvedValueOnce({ text: "guest-answer" });
    queue.enqueue("owner", ownerMetadata);
    queue.enqueue("guest", guestMetadata);
    await vi.advanceTimersByTimeAsync(10);
    await finish();

    expect(
      consult.mock.calls.slice(1).map(([{ question, metadata }]) => [question, metadata]),
    ).toEqual([
      ["owner", ownerMetadata],
      ["guest", guestMetadata],
    ]);
    expect(deliver.mock.calls.slice(1)).toEqual([["owner-answer"], ["guest-answer"]]);
  });

  it("bounds merged pending question text while a consult is active", async () => {
    const { queue, logger, consult, finish } = await createPendingQueue();
    const fragment = "x".repeat(4096);
    for (let index = 0; index < 10; index += 1) {
      queue.enqueue(fragment);
    }
    await finish();

    expect(consult.mock.calls.map(([request]) => request.question)).toEqual([
      "first",
      Array.from({ length: 7 }, () => fragment).join("\n"),
    ]);
    expect(logger.warn).toHaveBeenCalledOnce();
  });

  it("bounds pending question count while preserving retained order", async () => {
    const { queue, logger, consult, finish } = await createPendingQueue();
    const metadata = Array.from({ length: 40 }, (_, index) => ({ index }));
    metadata.forEach((entry, index) => queue.enqueue(`question-${index}`, entry));
    await finish();

    expect(consult.mock.calls.slice(1).map(([request]) => request.metadata)).toStrictEqual(
      metadata.slice(0, 32),
    );
    expect(logger.warn).toHaveBeenCalledOnce();
  });

  it("delivers fallback text when consult fails", async () => {
    const { queue, logger, deliver } = createQueue({
      consult: vi.fn<QueueParams["consult"]>().mockRejectedValue(new Error("boom")),
    });

    queue.enqueue("question");
    await vi.advanceTimersByTimeAsync(1);

    expect(logger.warn).toHaveBeenCalledOnce();
    expect(deliver).toHaveBeenCalledWith("fallback");
  });

  it("cancels pending debounced work on close", async () => {
    const consult = vi.fn(async () => ({ text: "answer" }));
    const { queue } = createQueue({
      debounceMs: 100,
      consult,
    });

    queue.enqueue("question");
    queue.close();
    await vi.advanceTimersByTimeAsync(100);

    expect(consult).not.toHaveBeenCalled();
  });

  it("aborts the active consult on close without delivering fallback", async () => {
    const pending = createDeferred<{ text: string }>();
    const consult = vi.fn<QueueParams["consult"]>(({ signal }) => {
      signal.addEventListener("abort", () => pending.reject(signal.reason));
      return pending.promise;
    });
    const { queue, logger, deliver } = createQueue({ consult });

    queue.enqueue("question");
    await vi.advanceTimersByTimeAsync(1);
    queue.close();
    queue.close();
    queue.enqueue("late question");
    await vi.runAllTimersAsync();

    expect(consult.mock.calls[0]?.[0].signal.aborted).toBe(true);
    expect(consult).toHaveBeenCalledOnce();
    expect(deliver).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
