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
  let identity = "stream";
  let follow!: ReturnType<typeof useStreamAutoFollow>;
  const dispose = createRoot((stop) => {
    follow = useStreamAutoFollow({
      container: () => container,
      enabled: () => true,
      identity: () => identity,
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
    identity = "replacement";
    vi.advanceTimersByTime(20);
    expect(container.scrollTop).toBe(0);

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

it("keeps admitted virtual following through an anchor scroll and rechecks the toggle", () => {
  vi.useFakeTimers();
  const container = document.createElement("div");
  Object.defineProperties(container, {
    scrollHeight: { value: 1_000 },
    clientHeight: { value: 100 },
  });
  document.body.append(container);
  container.scrollTop = 900;
  const scrollToEnd = vi.fn();
  let enabled = false;
  let follow!: ReturnType<typeof useStreamAutoFollow>;
  const dispose = createRoot((stop) => {
    follow = useStreamAutoFollow({
      container: () => container,
      enabled: () => enabled,
      identity: () => "stream",
      scrollToEnd,
    });
    return stop;
  });
  try {
    container.addEventListener("scroll", follow.handleScroll);
    follow.schedule();
    vi.advanceTimersByTime(20);
    expect(scrollToEnd).not.toHaveBeenCalled();
    enabled = true;
    follow.schedule();
    // The virtualizer retains an old row while the new tail is being rendered.
    container.scrollTop = 400;
    container.dispatchEvent(new Event("scroll"));
    vi.advanceTimersByTime(20);
    expect(scrollToEnd).toHaveBeenCalledOnce();
    expect(container.scrollTop).toBe(400);
    follow.schedule();
    enabled = false;
    vi.advanceTimersByTime(20);
    expect(scrollToEnd).toHaveBeenCalledOnce();
    enabled = true;
    follow.schedule();
    dispose();
    vi.advanceTimersByTime(20);
    expect(scrollToEnd).toHaveBeenCalledOnce();
  } finally {
    dispose();
    container.removeEventListener("scroll", follow.handleScroll);
    container.remove();
  }
});
