import { createRoot } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { useStreamAutoFollow } from "./stream-auto-follow.ts";

afterEach(() => {
  vi.useRealTimers();
});

it("preserves reader position until forced to follow, then cancels on disposal", () => {
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
    document.addEventListener("scroll", follow.handleScroll, true);
    container.dispatchEvent(new Event("scroll"));
    follow.schedule();
    vi.advanceTimersByTime(20);
    expect(container.scrollTop).toBe(0);

    follow.schedule(true);
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
    document.removeEventListener("scroll", follow.handleScroll, true);
    container.remove();
  }
});

it("keeps admitted following through an anchor scroll and rechecks the toggle", () => {
  vi.useFakeTimers();
  const container = document.createElement("div");
  Object.defineProperties(container, {
    scrollHeight: { value: 1_000 },
    clientHeight: { value: 100 },
  });
  document.body.append(container);
  container.scrollTop = 900;
  const scroll = vi.spyOn(container, "scrollTop", "set");
  let enabled = false;
  let follow!: ReturnType<typeof useStreamAutoFollow>;
  const dispose = createRoot((stop) => {
    follow = useStreamAutoFollow({
      container: () => container,
      enabled: () => enabled,
      identity: () => "stream",
    });
    return stop;
  });
  try {
    container.addEventListener("scroll", follow.handleScroll);
    follow.schedule();
    vi.advanceTimersByTime(20);
    expect(container.scrollTop).toBe(900);
    expect(scroll).not.toHaveBeenCalled();
    enabled = true;
    follow.schedule();
    // An anchor scroll must not revoke following already admitted for this frame.
    container.scrollTop = 400;
    container.dispatchEvent(new Event("scroll"));
    scroll.mockClear();
    follow.schedule();
    vi.advanceTimersByTime(20);
    expect(container.scrollTop).toBe(1_000);
    expect(scroll).toHaveBeenCalledExactlyOnceWith(1_000);
    container.scrollTop = 400;
    scroll.mockClear();
    follow.schedule();
    enabled = false;
    vi.advanceTimersByTime(20);
    expect(container.scrollTop).toBe(400);
    expect(scroll).not.toHaveBeenCalled();
    enabled = true;
    follow.schedule();
    dispose();
    vi.advanceTimersByTime(20);
    expect(container.scrollTop).toBe(400);
    expect(scroll).not.toHaveBeenCalled();
  } finally {
    dispose();
    scroll.mockRestore();
    container.removeEventListener("scroll", follow.handleScroll);
    container.remove();
  }
});
