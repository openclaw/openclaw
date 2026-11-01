import { afterEach, describe, expect, it, vi } from "vitest";
import { createFiniteRealtimeTranscriptionSession } from "./finite-session.js";
import type { RealtimeTranscriptionSessionCallbacks } from "./provider-types.js";

function fixture(
  options: {
    autoAck?: boolean;
    transcript?: string;
    maxQueuedBytes?: number;
    alignmentBytes?: number;
  } = {},
) {
  const controller = new AbortController();
  const frames: Buffer[] = [];
  const boundaries: number[] = [];
  const onError = vi.fn();
  const close = vi.fn();
  let callbacks: RealtimeTranscriptionSessionCallbacks = {};
  const session = createFiniteRealtimeTranscriptionSession({
    callbacks: { onError },
    signal: controller.signal,
    frameBytes: 2,
    segmentBytes: 8,
    maxQueuedBytes: options.maxQueuedBytes,
    alignmentBytes: options.alignmentBytes,
    commitTimeoutMs: 100,
    createSession: (hooks) => {
      callbacks = hooks;
      return {
        session: {
          connect: async () => {},
          sendAudio: (audio) => {
            frames.push(Buffer.from(audio));
          },
          close,
          isConnected: () => true,
        },
        commit: () => {
          boundaries.push(Buffer.concat(frames).length);
          if (options.autoAck !== false) {
            callbacks.onTranscript?.(options.transcript ?? `segment${boundaries.length}`);
          }
        },
      };
    },
  });
  return { session, frames, boundaries, callbacks, controller, close, onError };
}

describe("finite realtime transcription", () => {
  afterEach(() => vi.useRealTimers());

  it("preserves all bytes and ordered segments across long and concurrently submitted input", async () => {
    const f = fixture();
    await f.session.connect();
    const first = Buffer.from("abcdefghijk");
    const sending = f.session.writeAudio(first);
    first.fill(0);
    const next = f.session.writeAudio(Buffer.from("lmnopqrst"));
    const finish = f.session.finishInput();
    expect(f.session.finishInput()).toBe(finish);
    await Promise.all([sending, next]);
    await expect(finish).resolves.toEqual({ text: "segment1 segment2 segment3" });
    expect(Buffer.concat(f.frames).toString()).toBe("abcdefghijklmnopqrst");
    expect(f.boundaries).toEqual([8, 16, 20]);
    expect(f.close).toHaveBeenCalledOnce();
    await expect(f.session.writeAudio(Buffer.from("later"))).rejects.toThrow("complete");
    f.session.close();
    expect(f.onError).not.toHaveBeenCalled();
  });

  it("settles empty committed text and never commits zero-byte input", async () => {
    const empty = fixture();
    await empty.session.connect();
    await expect(empty.session.finishInput()).resolves.toEqual({ text: "" });
    expect(empty.boundaries).toEqual([]);
    const silent = fixture({ transcript: "" });
    await silent.session.connect();
    await silent.session.writeAudio(Buffer.alloc(4));
    await expect(silent.session.finishInput()).resolves.toEqual({ text: "" });
    expect(silent.boundaries).toEqual([4]);
  });

  it("waits for a late acknowledgment and forbids more input after finish", async () => {
    const f = fixture({ autoAck: false });
    await f.session.connect();
    await f.session.writeAudio(Buffer.from("abc"));
    const finish = f.session.finishInput();
    let settled = false;
    void finish.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(f.boundaries).toEqual([3]);
    expect(settled).toBe(false);
    await expect(f.session.writeAudio(Buffer.from("x"))).rejects.toThrow("already finished");
    f.callbacks.onPartial?.("not final");
    expect(settled).toBe(false);
    f.callbacks.onTranscript?.("late final");
    await expect(finish).resolves.toEqual({ text: "late final" });
  });

  it.each(["abort", "close", "error"] as const)(
    "rejects pending commit on %s without partial success",
    async (mode) => {
      const f = fixture({ autoAck: false });
      await f.session.connect();
      await f.session.writeAudio(Buffer.from("abc"));
      const finish = f.session.finishInput();
      const rejected = expect(finish).rejects.toThrow(
        mode === "error" ? "provider failure" : "aborted",
      );
      await Promise.resolve();
      if (mode === "abort") {
        f.controller.abort();
      }
      if (mode === "close") {
        f.session.close();
      }
      if (mode === "error") {
        f.callbacks.onError?.(new Error("provider failure"));
      }
      f.callbacks.onTranscript?.("too late");
      await rejected;
      expect(f.close).toHaveBeenCalledOnce();
      expect(f.onError).toHaveBeenCalledOnce();
    },
  );

  it("fails stalled commits with bounded lifetime", async () => {
    vi.useFakeTimers();
    const f = fixture({ autoAck: false });
    await f.session.connect();
    await f.session.writeAudio(Buffer.from("abc"));
    const finish = f.session.finishInput();
    const rejected = expect(finish).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(100);
    await rejected;
    expect(f.close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("fails queue overflow instead of dropping already admitted audio", async () => {
    const f = fixture({ maxQueuedBytes: 4 });
    await f.session.connect();
    const first = f.session.writeAudio(Buffer.from("abcd"));
    const rejectedFirst = expect(first).rejects.toThrow("queue exceeded");
    await expect(f.session.writeAudio(Buffer.from("ef"))).rejects.toThrow("queue exceeded");
    await rejectedFirst;
    await expect(f.session.finishInput()).rejects.toThrow("queue exceeded");
    expect(f.close).toHaveBeenCalledOnce();
  });

  it("rejects an unrequested final instead of misattributing it to later bytes", async () => {
    const f = fixture();
    await f.session.connect();
    f.callbacks.onTranscript?.("unsolicited");
    await expect(f.session.finishInput()).rejects.toThrow("without a pending commit");
  });

  it("carries split samples between chunks and rejects incomplete final samples", async () => {
    const f = fixture({ alignmentBytes: 2 });
    await f.session.connect();
    await f.session.writeAudio(Buffer.from("abc"));
    await f.session.writeAudio(Buffer.from("d"));
    await expect(f.session.finishInput()).resolves.toEqual({ text: "segment1" });
    expect(f.frames.map((frame) => frame.toString())).toEqual(["ab", "cd"]);
    const incomplete = fixture({ alignmentBytes: 2 });
    await incomplete.session.connect();
    await incomplete.session.writeAudio(Buffer.from("a"));
    await expect(incomplete.session.finishInput()).rejects.toThrow("incomplete audio sample");
    expect(incomplete.close).toHaveBeenCalledOnce();
  });
});
