import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  broadcastTypingThrottled,
  clearSessionTypingState,
  updateTypingConnections,
} from "./session-typing-state.js";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(10_000);
  clearSessionTypingState();
});

afterEach(() => {
  clearSessionTypingState();
  vi.useRealTimers();
});

function typingSession(key: string) {
  return (connectionId: string, now: number, typing = true, preview?: string) =>
    updateTypingConnections({ key, connectionId, typing, preview, now });
}

function typingBroadcast<T>(intervalMs: number, state: (value: T) => [boolean, string]) {
  const updates: T[] = [];
  const broadcast = (value: T) => {
    const [typing, preview] = state(value);
    return broadcastTypingThrottled({
      key: "typing-broadcast",
      typing,
      signature: `${typing}\0${preview}`,
      intervalMs,
      now: Date.now(),
      emit: () => {
        updates.push(value);
        return true;
      },
    });
  };
  return { updates, broadcast };
}

describe("session typing connection state", () => {
  it("owns idle cleanup, refresh, stop, and reset without further input", () => {
    const update = (key: string, typing = true) =>
      updateTypingConnections({ key, connectionId: key, typing, now: Date.now() });

    update("idle");
    update("refreshed");
    vi.advanceTimersByTime(2_000);
    update("refreshed");
    vi.advanceTimersByTime(500);
    expect(vi.getTimerCount()).toBe(1);
    expect(update("idle", false)).toEqual({ typing: false });
    vi.advanceTimersByTime(2_000);
    expect(vi.getTimerCount()).toBe(0);
    expect(update("refreshed", false)).toEqual({ typing: false });

    update("stopped");
    update("stopped", false);
    expect(vi.getTimerCount()).toBe(0);
    update("reset");
    clearSessionTypingState();
    expect(vi.getTimerCount()).toBe(0);
    expect(update("reset", false)).toEqual({ typing: false });
  });

  it("cancels cleanup for capacity-evicted buckets without dropping refreshed peers", () => {
    const update = (key: string, connectionId = key, typing = true) =>
      updateTypingConnections({ key, connectionId, typing, now: Date.now() });

    for (let index = 0; index < 2_048; index++) {
      update(String(index));
    }
    update("0");
    update("overflow");
    expect(vi.getTimerCount()).toBe(2_048);
    expect(update("1", "other", false)).toEqual({ typing: false });
    expect(update("0", "other", false)).toEqual({ typing: true });
    vi.advanceTimersByTime(2_500);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retains the newest live preview across an actor's connections", () => {
    const update = typingSession("shared-preview");
    expect(update("preview-tab", 10_000, true, "first draft")).toEqual({
      typing: true,
      preview: "first draft",
    });
    expect(update("presence-tab", 10_100)).toEqual({ typing: true, preview: "first draft" });
    expect(update("presence-tab", 10_200, true, "newer draft")).toEqual({
      typing: true,
      preview: "newer draft",
    });
  });

  it("removes a stopped connection's preview while preserving another connection's liveness", () => {
    const update = typingSession("stopped-preview");
    update("preview-tab", 10_000, true, "draft");
    update("presence-tab", 10_100);
    expect(update("preview-tab", 10_200, false)).toEqual({ typing: true });
    expect(update("presence-tab", 10_300, false)).toEqual({ typing: false });
    expect(update("missing-tab", 10_400, false)).toEqual({ typing: false });
  });

  it("expires stale previews while a refreshed boolean-only connection remains live", () => {
    const update = typingSession("expired-preview");
    update("preview-tab", 10_000, true, "expired draft");
    update("presence-tab", 11_000);
    expect(update("presence-tab", 12_500)).toEqual({ typing: true });
  });
});

describe("session typing broadcast throttle", () => {
  it("attempts only the latest draft at the trailing edge after delivery", () => {
    const { updates: previews, broadcast } = typingBroadcast(250, (preview: string) => [
      true,
      preview,
    ]);

    broadcast("first");
    vi.advanceTimersByTime(50);
    broadcast("second");
    vi.advanceTimersByTime(50);
    broadcast("latest");
    vi.advanceTimersByTime(150);

    expect(previews).toEqual(["first", "latest"]);

    vi.advanceTimersByTime(50);
    broadcast("after trailing edge");
    expect(previews).toEqual(["first", "latest"]);
    vi.advanceTimersByTime(200);
    expect(previews).toEqual(["first", "latest", "after trailing edge"]);
  });

  it("preserves boolean-only cancellation and trailing stop behavior", () => {
    const { updates, broadcast } = typingBroadcast(1_000, (typing: boolean) => [typing, ""]);

    broadcast(true);
    vi.advanceTimersByTime(100);
    broadcast(false);
    vi.advanceTimersByTime(100);
    broadcast(true);
    vi.advanceTimersByTime(800);
    expect(updates).toEqual([true, true]);

    vi.advanceTimersByTime(100);
    broadcast(false);
    vi.advanceTimersByTime(900);
    expect(updates).toEqual([true, true, false]);
  });
});
