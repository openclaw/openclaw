/* @vitest-environment jsdom */
import type { ReactiveController, ReactiveControllerHost } from "lit";
import { afterEach, expect, it, vi } from "vitest";
import { createPresenceActivityController } from "./presence-activity-controller.ts";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("schedules only the next person expiry and clears hidden or disconnected work", () => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  const refresh = vi.fn();
  let lifecycle: ReactiveController = {};
  const host: ReactiveControllerHost = {
    addController: (controller) => {
      lifecycle = controller;
    },
    removeController: vi.fn(),
    requestUpdate: refresh,
    updateComplete: Promise.resolve(true),
  };
  let viewers = [
    {
      id: "person",
      watchedSessions: [],
      entries: [{ ts: Date.now(), lastActivityAt: Date.now() - 119_000 }],
    },
  ];
  const controller = createPresenceActivityController(host, () => viewers);
  lifecycle.hostConnected?.();
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
  lifecycle.hostDisconnected?.();
  expect(vi.getTimerCount()).toBe(0);
  refresh.mockClear();
  lifecycle.hostConnected?.();
  expect(refresh).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(1);
  vi.advanceTimersByTime(120_000);
  expect(refresh).toHaveBeenCalledTimes(2);
  lifecycle.hostDisconnected?.();
});
