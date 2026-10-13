import { createRoot } from "solid-js";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { useVisiblePoll } from "./visible-poll.ts";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function browserVisibility(initial: DocumentVisibilityState) {
  let visibility = initial;
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
  return (next: DocumentVisibilityState) => {
    visibility = next;
    document.dispatchEvent(new Event("visibilitychange"));
  };
}

describe("Solid visible polling", () => {
  it.each(["visible", "hidden"] as const)(
    "starts explicitly, pauses while hidden and catches up once (initially %s)",
    (initial) => {
      vi.useFakeTimers();
      const visibility = browserVisibility(initial);
      const tick = vi.fn();
      let polling!: ReturnType<typeof useVisiblePoll>;
      const dispose = createRoot((stop) => {
        polling = useVisiblePoll(1_000, tick);
        return stop;
      });
      onTestFinished(dispose);
      vi.advanceTimersByTime(1_000);
      expect(tick).not.toHaveBeenCalled();
      expect(polling.start()).toBe(true);
      expect(polling.start()).toBe(false);
      vi.advanceTimersByTime(1_000);
      expect(tick).toHaveBeenCalledTimes(initial === "visible" ? 1 : 0);
      tick.mockClear();

      visibility("hidden");
      vi.advanceTimersByTime(5_000);
      expect(tick).not.toHaveBeenCalled();
      visibility("visible");
      visibility("visible");
      expect(tick).toHaveBeenCalledOnce();
      vi.advanceTimersByTime(1_000);
      expect(tick).toHaveBeenCalledTimes(2);
      polling.stop();
      visibility("hidden");
      visibility("visible");
      vi.advanceTimersByTime(1_000);
      expect(tick).toHaveBeenCalledTimes(2);

      expect(polling.start()).toBe(true);
      dispose();
      visibility("hidden");
      visibility("visible");
      vi.advanceTimersByTime(1_000);
      expect(tick).toHaveBeenCalledTimes(2);
    },
  );
});
