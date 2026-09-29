import { setImmediate } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import type { MeetingRealtimeAudioTransport } from "./realtime-audio-transport.js";
import {
  createMeetingRealtimeOutputOwner,
  createMeetingRealtimeOutputQueue,
} from "./realtime-output-owner.js";

function createQueueFixture() {
  const writeOutput = vi.fn<MeetingRealtimeAudioTransport["writeOutput"]>(async () => {});
  const clearOutput = vi.fn(async () => {});
  const beginOutput = vi.fn();
  const onFailure = vi.fn();
  const queue = createMeetingRealtimeOutputQueue({
    bytesPerMs: 2,
    onFailure,
    transport: {
      beginOutput,
      clearOutput,
      dispose: async () => {},
      onFatal: () => {},
      startInput: () => {},
      stop: async () => {},
      writeOutput,
    },
  });
  const reserve = () => {
    const token = queue.reservePrepared();
    if (!token) {
      throw new Error("Expected prepared output reservation");
    }
    return token;
  };
  return { queue, reserve, beginOutput, clearOutput, writeOutput, onFailure };
}

describe("prepared meeting realtime output", () => {
  it.each(["invalidate", "clear", "stop"] as const)(
    "%s clears the prepared playback projection after native admission completes",
    async (action) => {
      const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
      try {
        const { queue, reserve } = createQueueFixture();
        await queue.enqueuePrepared(reserve(), Buffer.alloc(2_000));
        expect(queue.pending()).toEqual({ pendingBytes: 0, pendingFrames: 0 });
        expect(queue.hasUnplayedPreparedAudio()).toBe(true);
        queue[action]();
        expect(queue.hasUnplayedPreparedAudio()).toBe(false);
      } finally {
        now.mockRestore();
      }
    },
  );

  it("expires the prepared playback projection on the existing playback timeline", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    try {
      const { queue, reserve } = createQueueFixture();
      await queue.enqueuePrepared(reserve(), Buffer.alloc(2_000));
      now.mockReturnValue(1_999);
      expect(queue.hasUnplayedPreparedAudio()).toBe(true);
      now.mockReturnValue(2_000);
      expect(queue.hasUnplayedPreparedAudio()).toBe(false);
    } finally {
      now.mockRestore();
    }
  });

  it("admits a full utterance beyond the streaming cap through bounded native writes", async () => {
    const { queue, reserve, writeOutput, beginOutput, onFailure } = createQueueFixture();
    const audio = Buffer.alloc(5_002, 7);
    expect(queue.enqueue(audio, true, true)).toBe(false);
    const refreshCurrent = vi.fn(async () => {});
    const assertCurrent = vi.fn();
    const onStarted = vi.fn(() => {
      expect(refreshCurrent).toHaveBeenCalledOnce();
      expect(beginOutput).not.toHaveBeenCalled();
    });
    const lastWrite = createDeferredCore();
    writeOutput.mockImplementation(async () => {
      if (writeOutput.mock.calls.length === 6) {
        await lastWrite.promise;
      }
    });
    const completion = queue.enqueuePrepared(reserve(), audio, {
      assertCurrent,
      refreshCurrent,
      onStarted,
    });
    const completed = vi.fn();
    void completion.then(completed, completed);
    await setImmediate();
    expect(writeOutput).toHaveBeenCalledTimes(6);
    expect(completed).not.toHaveBeenCalled();

    lastWrite.resolve();
    await completion;

    expect(writeOutput).toHaveBeenCalledTimes(6);
    const chunks = writeOutput.mock.calls.map(([chunk]) => chunk);
    expect(chunks.every((chunk) => chunk.byteLength <= 1_000)).toBe(true);
    expect(Buffer.concat(chunks)).toEqual(audio);
    expect(refreshCurrent).toHaveBeenCalledOnce();
    expect(onStarted).toHaveBeenCalledOnce();
    expect(beginOutput).toHaveBeenCalledOnce();
    expect(assertCurrent.mock.calls.length).toBeGreaterThanOrEqual(chunks.length * 2);
    expect(queue.pending()).toEqual({ pendingBytes: 0, pendingFrames: 0 });
    expect(onFailure).not.toHaveBeenCalled();
  });

  it("invalidates a reservation acquired before synthesis and allows a new reservation", async () => {
    const { queue, reserve, writeOutput } = createQueueFixture();
    const oldToken = reserve();
    queue.invalidate();
    await expect(queue.enqueuePrepared(oldToken, Buffer.alloc(10))).rejects.toThrow(
      "no longer current",
    );
    expect(writeOutput).not.toHaveBeenCalled();
    await queue.enqueuePrepared(reserve(), Buffer.alloc(10));
    expect(writeOutput).toHaveBeenCalledOnce();
  });

  it("bounds preparation to one utterance and excludes streaming until release", async () => {
    const { queue, reserve, writeOutput } = createQueueFixture();
    const token = reserve();
    expect(queue.reservePrepared()).toBeUndefined();
    expect(queue.enqueue(Buffer.alloc(10), true, true)).toBe(false);
    await expect(queue.enqueuePrepared(token, Buffer.alloc(240_002))).rejects.toThrow(
      "120 seconds",
    );
    queue.releasePrepared(token);
    const nextToken = reserve();
    queue.releasePrepared(token);
    await queue.enqueuePrepared(nextToken, Buffer.alloc(10));
    expect(writeOutput).toHaveBeenCalledOnce();
  });

  it.each(["invalidate", "clear", "stop"] as const)(
    "%s fences preparation while its source refresh is pending",
    async (action) => {
      const { queue, reserve, beginOutput, writeOutput, onFailure } = createQueueFixture();
      const refresh = createDeferredCore();
      const refreshCurrent = vi.fn(() => refresh.promise);
      const onStarted = vi.fn();
      const completion = queue.enqueuePrepared(reserve(), Buffer.alloc(3_000), {
        refreshCurrent,
        onStarted,
      });
      const rejected = expect(completion).rejects.toThrow("canceled");
      await setImmediate();
      expect(refreshCurrent).toHaveBeenCalledOnce();

      queue[action]();
      await rejected;
      refresh.resolve();
      await setImmediate();

      expect(onStarted).not.toHaveBeenCalled();
      expect(beginOutput).not.toHaveBeenCalled();
      expect(writeOutput).not.toHaveBeenCalled();
      expect(onFailure).not.toHaveBeenCalled();
    },
  );

  it("rejects a source changed during refresh without failing the meeting transport", async () => {
    const { queue, reserve, beginOutput, clearOutput, writeOutput, onFailure } =
      createQueueFixture();
    const refresh = createDeferredCore();
    let current = true;
    const completion = queue.enqueuePrepared(reserve(), Buffer.alloc(3_000), {
      refreshCurrent: () => refresh.promise,
      assertCurrent: () => {
        if (!current) {
          throw new Error("Source changed");
        }
      },
    });
    const rejected = expect(completion).rejects.toThrow("Source changed");
    await setImmediate();
    current = false;
    refresh.resolve();
    await rejected;
    await setImmediate();

    expect(beginOutput).not.toHaveBeenCalled();
    expect(writeOutput).not.toHaveBeenCalled();
    expect(clearOutput).toHaveBeenCalledOnce();
    expect(onFailure).not.toHaveBeenCalled();
  });

  it("starts new speech without waiting for a canceled refresh and fences its late cleanup", async () => {
    const { queue, reserve, writeOutput } = createQueueFixture();
    const oldRefresh = createDeferredCore();
    const oldCompletion = queue.enqueuePrepared(reserve(), Buffer.alloc(3_000, 1), {
      refreshCurrent: () => oldRefresh.promise,
    });
    const oldRejected = expect(oldCompletion).rejects.toThrow("canceled");
    await setImmediate();
    queue.invalidate();
    await oldRejected;

    const newWrite = createDeferredCore();
    writeOutput.mockImplementationOnce(() => newWrite.promise);
    const newCompletion = queue.enqueuePrepared(reserve(), Buffer.alloc(2_000, 2));
    await setImmediate();
    expect(writeOutput).toHaveBeenCalledOnce();
    oldRefresh.resolve();
    await setImmediate();
    expect(writeOutput).toHaveBeenCalledOnce();
    newWrite.resolve();
    await newCompletion;
    expect(writeOutput.mock.calls.map(([audio]) => audio)).toEqual([
      Buffer.alloc(1_000, 2),
      Buffer.alloc(1_000, 2),
    ]);
    expect(queue.pending()).toEqual({ pendingBytes: 0, pendingFrames: 0 });
  });

  it("rechecks authority after announcing playback and before native side effects", async () => {
    const { queue, reserve, beginOutput, writeOutput, onFailure } = createQueueFixture();
    let current = true;
    await expect(
      queue.enqueuePrepared(reserve(), Buffer.alloc(10), {
        onStarted: () => {
          current = false;
        },
        assertCurrent: () => {
          if (!current) {
            throw new Error("Source changed");
          }
        },
      }),
    ).rejects.toThrow("Source changed");
    expect(beginOutput).not.toHaveBeenCalled();
    expect(writeOutput).not.toHaveBeenCalled();
    expect(onFailure).not.toHaveBeenCalled();
  });

  it("drops the remaining chunks when authority changes during a native write", async () => {
    const { queue, reserve, clearOutput, writeOutput, onFailure } = createQueueFixture();
    let current = true;
    writeOutput.mockImplementationOnce(async () => {
      current = false;
    });
    await expect(
      queue.enqueuePrepared(reserve(), Buffer.alloc(3_000), {
        assertCurrent: () => {
          if (!current) {
            throw new Error("Source changed");
          }
        },
      }),
    ).rejects.toThrow("Source changed");
    await setImmediate();
    expect(writeOutput).toHaveBeenCalledOnce();
    expect(clearOutput).toHaveBeenCalledOnce();
    expect(onFailure).not.toHaveBeenCalled();
    expect(queue.pending()).toEqual({ pendingBytes: 0, pendingFrames: 0 });
  });

  it("waits for native admission and preserves a new reservation across an old in-flight clear", async () => {
    const { queue, reserve, clearOutput, writeOutput } = createQueueFixture();
    const firstWrite = createDeferredCore();
    writeOutput.mockImplementationOnce(() => firstWrite.promise);
    const oldCompletion = queue.enqueuePrepared(reserve(), Buffer.alloc(3_000, 1));
    const oldRejected = expect(oldCompletion).rejects.toThrow("canceled");
    await setImmediate();
    expect(writeOutput).toHaveBeenCalledOnce();
    queue.invalidate();
    queue.clear();
    await oldRejected;

    const newAudio = Buffer.alloc(10, 2);
    const newCompletion = queue.enqueuePrepared(reserve(), newAudio);
    const completed = vi.fn();
    void newCompletion.then(completed, completed);
    await setImmediate();
    expect(completed).not.toHaveBeenCalled();
    expect(writeOutput).toHaveBeenCalledOnce();
    firstWrite.resolve();
    await newCompletion;

    expect(clearOutput).toHaveBeenCalledTimes(2);
    expect(writeOutput.mock.calls.map(([audio]) => audio)).toEqual([
      Buffer.alloc(1_000, 1),
      newAudio,
    ]);
  });

  it("still reports a native write failure and rejects the prepared completion", async () => {
    const { queue, reserve, writeOutput, onFailure } = createQueueFixture();
    const failure = new Error("Native output disconnected");
    writeOutput.mockRejectedValueOnce(failure);
    await expect(queue.enqueuePrepared(reserve(), Buffer.alloc(3_000))).rejects.toBe(failure);
    await setImmediate();
    expect(writeOutput).toHaveBeenCalledOnce();
    expect(onFailure).toHaveBeenCalledWith("audio output", failure);
  });
});

describe("exact speech output ownership", () => {
  it("releases an idle takeover block while preserving stale provider response fences", () => {
    const owner = createMeetingRealtimeOutputOwner();
    const takeover = owner.block();
    const token = owner.reserveExactSpeech();
    owner.noteEvent({ direction: "server", type: "response.created", responseId: "during-speech" });

    owner.releaseExactSpeech(token);

    expect(owner.isBlockedBy(takeover.token)).toBe(false);
    expect(owner.accept("during-speech")).toBe(false);
    expect(owner.accept("fresh-response")).toBe(true);
  });

  it("preserves an interruption block when releasing a revoked exact speech reservation", () => {
    const owner = createMeetingRealtimeOutputOwner();
    owner.block();
    const token = owner.reserveExactSpeech();
    const interruption = owner.block();

    owner.releaseExactSpeech(token);

    expect(owner.isExactSpeechCurrent(token)).toBe(false);
    expect(owner.isBlockedBy(interruption.token)).toBe(true);
    expect(owner.accept(undefined)).toBe(false);
  });

  it("recovers a fresh keyed response after idle exact interruption without weakening legacy blocks", () => {
    const owner = createMeetingRealtimeOutputOwner();
    owner.block();
    const speech = owner.reserveExactSpeech();
    owner.block();
    owner.releaseExactSpeech(speech);
    expect(owner.accept(undefined)).toBe(false);
    expect(owner.accept("fresh-response")).toBe(true);

    const legacy = createMeetingRealtimeOutputOwner();
    legacy.block();
    expect(legacy.accept(undefined)).toBe(false);
    expect(legacy.accept("fresh-response")).toBe(false);
  });

  it("recovers fresh provider speech after interrupting an admitted exact buffer", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    try {
      const owner = createMeetingRealtimeOutputOwner();
      const { queue, reserve } = createQueueFixture();
      owner.block();
      const speech = owner.reserveExactSpeech();
      await queue.enqueuePrepared(reserve(), Buffer.alloc(2_000));
      owner.releaseExactSpeech(speech);
      expect(owner.hasExactSpeech()).toBe(false);
      expect(queue.hasUnplayedPreparedAudio()).toBe(true);

      owner.block(queue.hasUnplayedPreparedAudio());
      queue.invalidate();

      expect(queue.hasUnplayedPreparedAudio()).toBe(false);
      expect(owner.accept(undefined)).toBe(false);
      expect(owner.accept("fresh-response")).toBe(true);
    } finally {
      now.mockRestore();
    }
  });

  it.each(["release", "interrupt"] as const)(
    "does not resume a suppressed continuous response tail after exact speech %s",
    (action) => {
      const owner = createMeetingRealtimeOutputOwner();
      const token = owner.reserveExactSpeech();
      expect(owner.acceptContinuous(true)).toBe(false);
      expect(owner.acceptContinuous(false)).toBe(false);
      if (action === "release") {
        owner.releaseExactSpeech(token);
      } else {
        owner.block();
      }
      expect(owner.acceptContinuous(true)).toBe(false);
      expect(owner.acceptContinuous(false)).toBe(true);
      expect(owner.acceptContinuous(true)).toBe(true);
    },
  );

  it("resets continuous tail suppression on teardown despite reserved silence", () => {
    const owner = createMeetingRealtimeOutputOwner();
    const token = owner.reserveExactSpeech();
    expect(owner.acceptContinuous(true)).toBe(false);
    expect(owner.acceptContinuous(false)).toBe(false);
    owner.releaseExactSpeech(token);
    expect(owner.acceptContinuous(true)).toBe(false);
    owner.reserveExactSpeech();
    expect(owner.acceptContinuous(true)).toBe(false);
    owner.reset();
    expect(owner.acceptContinuous(true)).toBe(true);
  });

  it("excludes provider audio and remembers response tails until after exact speech", () => {
    const owner = createMeetingRealtimeOutputOwner();
    const token = owner.reserveExactSpeech();
    owner.noteEvent({ direction: "server", type: "response.created", responseId: "during-speech" });
    expect(owner.hasExactSpeech()).toBe(true);
    expect(owner.accept(undefined)).toBe(false);
    expect(owner.accept("audio-only-response")).toBe(false);
    owner.releaseExactSpeech(Symbol("unrelated"));
    expect(owner.isExactSpeechCurrent(token)).toBe(true);
    owner.releaseExactSpeech(token);
    expect(owner.hasExactSpeech()).toBe(false);
    expect(owner.accept("during-speech")).toBe(false);
    expect(owner.accept("audio-only-response")).toBe(false);
    expect(owner.accept("new-response")).toBe(true);
  });

  it.each(["block", "providerClear", "reset"] as const)(
    "%s revokes exact speech authority",
    (action) => {
      const owner = createMeetingRealtimeOutputOwner();
      const token = owner.reserveExactSpeech();
      owner[action]();
      expect(owner.isExactSpeechCurrent(token)).toBe(false);
      expect(owner.hasExactSpeech()).toBe(false);
    },
  );

  it("does not revoke new exact speech for a previously blocked provider clear", () => {
    const owner = createMeetingRealtimeOutputOwner();
    owner.accept("old-response");
    owner.block();
    const token = owner.reserveExactSpeech();
    expect(owner.providerClear()).toBe(false);
    expect(owner.isExactSpeechCurrent(token)).toBe(true);
    owner.block();
    expect(owner.isExactSpeechCurrent(token)).toBe(false);
  });
});
