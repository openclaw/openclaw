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

function expectConsultCall(
  consult: { mock: { calls: [Parameters<QueueParams["consult"]>[0]][] } },
  callIndex: number,
  question: string,
  metadata?: unknown,
) {
  const call = consult.mock.calls[callIndex]?.[0];
  if (call === undefined) {
    throw new Error(`Expected talkback consult call ${callIndex}`);
  }
  const { signal, ...request } = call;
  expect(signal).toBeInstanceOf(AbortSignal);
  expect(request).toStrictEqual({ metadata, question, responseStyle: "brief" });
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

    expectConsultCall(consult, 1, "owner", ownerMetadata);
    expectConsultCall(consult, 2, "guest", guestMetadata);
    expect(deliver).toHaveBeenCalledWith("owner-answer");
    expect(deliver).toHaveBeenCalledWith("guest-answer");
  });

  it("bounds merged pending question text while a consult is active", async () => {
    const { queue, logger, consult, finish } = await createPendingQueue();
    const fragment = "x".repeat(4096);
    for (let index = 0; index < 10; index += 1) {
      queue.enqueue(fragment);
    }
    await finish();

    expectConsultCall(consult, 1, Array.from({ length: 7 }, () => fragment).join("\n"));
    expect(consult).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledExactlyOnceWith(
      "[test] consult queue full: droppedChars=4096 queued=1 queuedChars=28678",
    );
  });

  it("bounds pending question count while preserving retained order", async () => {
    const { queue, logger, consult, finish } = await createPendingQueue();
    const metadata = Array.from({ length: 40 }, (_, index) => ({ index }));
    metadata.forEach((entry, index) => queue.enqueue(`question-${index}`, entry));
    await finish();

    expect(consult).toHaveBeenCalledTimes(33);
    expect(consult.mock.calls.slice(1).map(([request]) => request.metadata)).toStrictEqual(
      metadata.slice(0, 32),
    );
    expect(logger.warn).toHaveBeenCalledExactlyOnceWith(
      "[test] consult queue full: droppedChars=11 queued=32 queuedChars=342",
    );
  });

  it("delivers fallback text when consult fails", async () => {
    const { queue, logger, deliver } = createQueue({
      consult: vi.fn(async () => {
        throw new Error("boom");
      }),
    });

    queue.enqueue("question");
    await vi.advanceTimersByTimeAsync(1);

    expect(logger.warn).toHaveBeenCalledExactlyOnceWith("[test] consult failed: elapsedMs=0 boom");
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
    let signal: AbortSignal | undefined;
    const consult = vi.fn<QueueParams["consult"]>(
      ({ signal: nextSignal }) =>
        new Promise<{ text: string }>((_resolve, reject) => {
          signal = nextSignal;
          nextSignal.addEventListener("abort", () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          });
        }),
    );
    const { queue, logger, deliver } = createQueue({ consult });

    queue.enqueue("question");
    await vi.advanceTimersByTimeAsync(1);
    queue.close();
    queue.close();
    queue.enqueue("late question");
    await vi.runAllTimersAsync();

    if (!signal) {
      throw new Error("Expected talkback consult abort signal");
    }
    expect(signal.aborted).toBe(true);
    expect(consult).toHaveBeenCalledOnce();
    expect(deliver).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
