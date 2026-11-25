import { describe, expect, it, vi } from "vitest";
import {
  TERMINAL_OPEN_DEADLINE_MS,
  TerminalOpenDeadlineError,
  createTerminalOpenDeadline,
  waitForTerminalOpenDeadline,
} from "./open-deadline.js";

describe("terminal open deadline on the monotonic clock", () => {
  it("expires and aborts when monotonic time reaches the deadline despite a wall-clock rewind", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      const deadline = createTerminalOpenDeadline();

      // Rewind the wall clock by 90s. Under vitest fake timers,
      // setSystemTime moves Date.now() but leaves performance.now() untouched.
      vi.setSystemTime(-90_000);

      const never = new Promise<string>(() => {});

      const promise = waitForTerminalOpenDeadline(() => never, deadline);

      // Attach a rejection handler before advancing the deadline timer.
      promise.catch(() => {});

      await vi.advanceTimersByTimeAsync(TERMINAL_OPEN_DEADLINE_MS);

      await expect(promise).rejects.toThrow(TerminalOpenDeadlineError);
      expect(deadline.controller.signal.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
