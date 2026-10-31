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

function update(key: string, connectionId = key, typing = true, preview?: string) {
  return updateTypingConnections({ key, connectionId, typing, preview, now: Date.now() });
}

function typingBroadcast<T>(intervalMs: number, state: (value: T) => [boolean, string]) {
  const updates: T[] = [];
  const broadcast = (value: T, elapsed = 0) => {
    vi.advanceTimersByTime(elapsed);
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
    update("idle");
    update("refreshed");
    vi.advanceTimersByTime(2_000);
    update("refreshed");
    vi.advanceTimersByTime(500);
    expect(vi.getTimerCount()).toBe(1);
    expect(update("idle", "idle", false)).toEqual({ typing: false });
    vi.advanceTimersByTime(2_000);
    expect(vi.getTimerCount()).toBe(0);
    expect(update("refreshed", "refreshed", false)).toEqual({ typing: false });

    update("stopped");
    update("stopped", "stopped", false);
    expect(vi.getTimerCount()).toBe(0);
    update("reset");
    clearSessionTypingState();
    expect(vi.getTimerCount()).toBe(0);
    expect(update("reset", "reset", false)).toEqual({ typing: false });
  });

  it("cancels cleanup for capacity-evicted buckets without dropping refreshed peers", () => {
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

  it("expires stale previews while a refreshed boolean-only connection remains live", () => {
    update("expired-preview", "preview-tab", true, "expired draft");
    vi.advanceTimersByTime(1_000);
    update("expired-preview", "presence-tab");
    vi.advanceTimersByTime(1_500);
    expect(update("expired-preview", "presence-tab")).toEqual({ typing: true });
  });
});

describe("session typing broadcast throttle", () => {
  it("attempts only the latest draft at the trailing edge after delivery", () => {
    const { updates: previews, broadcast } = typingBroadcast(250, (preview: string) => [
      true,
      preview,
    ]);

    broadcast("first");
    broadcast("second", 50);
    broadcast("latest", 50);
    vi.advanceTimersByTime(150);

    expect(previews).toEqual(["first", "latest"]);

    broadcast("after trailing edge", 50);
    expect(previews).toEqual(["first", "latest"]);
    vi.advanceTimersByTime(200);
    expect(previews).toEqual(["first", "latest", "after trailing edge"]);
  });

  it("preserves boolean-only cancellation and trailing stop behavior", () => {
    const { updates, broadcast } = typingBroadcast(1_000, (typing: boolean) => [typing, ""]);

    broadcast(true);
    broadcast(false, 100);
    broadcast(true, 100);
    vi.advanceTimersByTime(800);
    expect(updates).toEqual([true, true]);

    broadcast(false, 100);
    vi.advanceTimersByTime(900);
    expect(updates).toEqual([true, true, false]);
  });
});
