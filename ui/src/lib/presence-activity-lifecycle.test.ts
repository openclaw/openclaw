/* @vitest-environment jsdom */
import { afterEach, expect, it, vi } from "vitest";
import { createPresenceActivityLifecycle } from "./presence-activity-lifecycle.ts";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("schedules only the next person expiry and clears hidden or disconnected work", () => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  const refresh = vi.fn();
  let viewers = [
    {
      id: "person",
      watchedSessions: [],
      entries: [{ ts: Date.now(), lastActivityAt: Date.now() - 119_000 }],
    },
  ];
  const controller = createPresenceActivityLifecycle(() => viewers, refresh);
  controller.connect();
  refresh.mockClear();
  controller.sync();
  controller.sync();
  expect(vi.getTimerCount()).toBe(1);
  vi.advanceTimersByTime(1_000);
  expect(refresh).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
  viewers = [{ ...viewers[0]!, entries: [{ ts: Date.now(), lastActivityAt: Date.now() }] }];
  controller.sync();
  visibility.mockReturnValue("hidden");
  document.dispatchEvent(new Event("visibilitychange"));
  expect(vi.getTimerCount()).toBe(0);
  vi.advanceTimersByTime(120_000);
  visibility.mockReturnValue("visible");
  document.dispatchEvent(new Event("visibilitychange"));
  expect(refresh).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
  viewers = [{ ...viewers[0]!, entries: [{ ts: Date.now(), lastActivityAt: Date.now() }] }];
  controller.sync();
  controller.disconnect();
  expect(vi.getTimerCount()).toBe(0);
  refresh.mockClear();
  controller.connect();
  expect(refresh).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(1);
  vi.advanceTimersByTime(120_000);
  expect(refresh).toHaveBeenCalledTimes(2);
  controller.disconnect();
});
