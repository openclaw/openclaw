import { afterEach, describe, expect, it, vi } from "vitest";
import type { MeetingRealtimeAudioTransport } from "./realtime-audio-transport.js";
import { createMeetingRealtimeOutputQueue } from "./realtime-output-owner.js";

function createTransport(): MeetingRealtimeAudioTransport {
  return {
    onFatal: vi.fn(),
    startInput: vi.fn(),
    stop: vi.fn(async () => {}),
    writeOutput: vi.fn(async () => {}),
    clearOutput: vi.fn(async () => {}),
    dispose: vi.fn(async () => {}),
  };
}

describe("meeting realtime output queue", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    ["forward", 60_000],
    ["backward", -60_000],
  ] as const)(
    "tracks audible playback across a %s wall-clock jump",
    async (_, wallClockShiftMs) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-09-23T00:00:00.000Z"));
      const queue = createMeetingRealtimeOutputQueue({
        transport: createTransport(),
        bytesPerMs: 1,
        onFailure: vi.fn(),
      });

      expect(queue.enqueue(Buffer.alloc(100), true, true)).toBe(true);
      await vi.advanceTimersByTimeAsync(0);
      expect(queue.pending()).toEqual({ pendingBytes: 0, pendingFrames: 0 });

      vi.setSystemTime(Date.now() + wallClockShiftMs);
      expect(queue.hasUnplayedAudibleAudio()).toBe(true);

      await vi.advanceTimersByTimeAsync(101);
      expect(queue.hasUnplayedAudibleAudio()).toBe(false);
    },
  );
});
