import { createRoot } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { useStreamAutoFollow } from "./stream-auto-follow.ts";

afterEach(() => {
  vi.useRealTimers();
});

it("preserves reader position until a new stream resets following, then cancels on disposal", () => {
  vi.useFakeTimers();
  const container = document.createElement("div");
  Object.defineProperties(container, {
    scrollHeight: { value: 1_000 },
    clientHeight: { value: 100 },
  });
  document.body.append(container);
  let follow!: ReturnType<typeof useStreamAutoFollow>;
  const dispose = createRoot((stop) => {
    follow = useStreamAutoFollow({
      container: () => container,
      enabled: () => true,
      identity: () => "stream",
    });
    return stop;
  });
  try {
    container.addEventListener("scroll", follow.handleScroll);
    container.dispatchEvent(new Event("scroll"));
    follow.schedule();
    vi.advanceTimersByTime(20);
    expect(container.scrollTop).toBe(0);

    follow.reset();
    follow.schedule();
    vi.advanceTimersByTime(20);
    expect(container.scrollTop).toBe(1_000);

    container.scrollTop = 0;
    follow.schedule();
    dispose();
    vi.advanceTimersByTime(20);
    expect(container.scrollTop).toBe(0);
  } finally {
    dispose();
    container.removeEventListener("scroll", follow.handleScroll);
    container.remove();
  }
});
