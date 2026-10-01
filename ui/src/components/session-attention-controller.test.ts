import type { ReactiveController } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isSessionSnoozed } from "../lib/sessions/session-snooze.ts";
import { SessionAttentionController } from "./session-attention-controller.ts";

afterEach(() => vi.useRealTimers());

function setup(snoozedUntil: number) {
  vi.useFakeTimers();
  vi.setSystemTime(100);
  const row = { snoozedUntil };
  let visible = !isSessionSnoozed(row, Date.now());
  const host = {
    isConnected: true,
    sessionAttentionContext: undefined,
    addController: (_controller: ReactiveController) => {},
    removeController: (_controller: ReactiveController) => {},
    updateComplete: Promise.resolve(true),
    requestUpdate: vi.fn(() => {
      visible = !isSessionSnoozed(row, Date.now());
      controller.scheduleSessionSnoozeWake([row]);
    }),
  };
  const controller = new SessionAttentionController(host);
  controller.scheduleSessionSnoozeWake([row]);
  return { host, controller, row, visible: () => visible };
}

describe("session snooze deadline invalidation", () => {
  it("resurfaces a row at the deadline without polling", () => {
    const h = setup(200);
    vi.advanceTimersByTime(99);
    expect(h.visible()).toBe(false);
    expect(h.host.requestUpdate).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(isSessionSnoozed(h.row, Date.now())).toBe(false);
    vi.advanceTimersByTime(1);
    expect(h.visible()).toBe(true);
    expect(h.host.requestUpdate).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    h.controller.hostDisconnected();
  });

  it("replaces the old deadline on a new projection and retires it on disconnect", () => {
    const h = setup(200);
    h.row.snoozedUntil = 300;
    h.controller.scheduleSessionSnoozeWake([h.row]);
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(101);
    expect(h.host.requestUpdate).not.toHaveBeenCalled();
    h.host.isConnected = false;
    h.controller.hostDisconnected();
    h.controller.scheduleSessionSnoozeWake([h.row]);
    vi.advanceTimersByTime(200);
    expect(h.host.requestUpdate).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clamps distant deadlines and rearms them until due", () => {
    const h = setup(2_147_483_847);
    vi.advanceTimersByTime(2_147_483_647);
    expect(h.visible()).toBe(false);
    expect(h.host.requestUpdate).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(101);
    expect(h.visible()).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    h.controller.hostDisconnected();
  });
});
