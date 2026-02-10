import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearZombieBuffer,
  getQueuedCount,
  isZombie,
  markZombie,
  queuePayload,
  reBind,
  setZombieBufferCallbacks,
} from "./zombie-session-buffer.js";

const ZOMBIE_REAPER_MS = 30_000;

describe("zombie-session-buffer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    clearZombieBuffer();
    setZombieBufferCallbacks(null);
  });

  afterEach(() => {
    clearZombieBuffer();
    setZombieBufferCallbacks(null);
    vi.useRealTimers();
  });

  describe("markZombie", () => {
    it("marks session as zombie and starts reaper", () => {
      markZombie("agent:main:discord:channel:123");
      expect(isZombie("agent:main:discord:channel:123")).toBe(true);
    });

    it("trims session key", () => {
      markZombie("  agent:main:discord  ");
      expect(isZombie("agent:main:discord")).toBe(true);
    });

    it("ignores empty key", () => {
      markZombie("");
      markZombie("   ");
      expect(isZombie("")).toBe(false);
    });

    it("resets reaper when marking same session again", () => {
      const onReap = vi.fn();
      setZombieBufferCallbacks({ onReap });

      markZombie("session-1");
      vi.advanceTimersByTime(ZOMBIE_REAPER_MS - 1000);
      markZombie("session-1");
      vi.advanceTimersByTime(1000);

      expect(onReap).not.toHaveBeenCalled();
      vi.advanceTimersByTime(ZOMBIE_REAPER_MS - 1000);
      expect(onReap).toHaveBeenCalledWith("session-1");
    });
  });

  describe("reaper", () => {
    it("reaps zombie session after timeout", () => {
      const onReap = vi.fn();
      setZombieBufferCallbacks({ onReap });

      markZombie("session-1");
      expect(isZombie("session-1")).toBe(true);

      vi.advanceTimersByTime(ZOMBIE_REAPER_MS);

      expect(isZombie("session-1")).toBe(false);
      expect(onReap).toHaveBeenCalledWith("session-1");
    });

    it("clears queued payloads on reap", () => {
      markZombie("session-1");
      queuePayload("session-1", { event: "chat", data: {} });
      expect(getQueuedCount("session-1")).toBe(1);

      vi.advanceTimersByTime(ZOMBIE_REAPER_MS);

      expect(getQueuedCount("session-1")).toBe(0);
    });
  });

  describe("reBind", () => {
    it("returns empty when session is not zombie", () => {
      const result = reBind("nonexistent");
      expect(result).toEqual([]);
    });

    it("cancels reaper and returns queued payloads", () => {
      const onReBind = vi.fn();
      setZombieBufferCallbacks({ onReap: vi.fn(), onReBind });

      markZombie("session-1");
      queuePayload("session-1", { event: "chat", text: "hello" });
      queuePayload("session-1", { event: "agent", seq: 2 });

      const result = reBind("session-1");

      expect(isZombie("session-1")).toBe(false);
      expect(result).toHaveLength(2);
      expect(result[0].payload).toEqual({ event: "chat", text: "hello" });
      expect(result[1].payload).toEqual({ event: "agent", seq: 2 });
      expect(onReBind).toHaveBeenCalledWith("session-1");

      vi.advanceTimersByTime(ZOMBIE_REAPER_MS);
      expect(isZombie("session-1")).toBe(false);
    });

    it("returns empty array when session has no queued payloads", () => {
      markZombie("session-1");
      const result = reBind("session-1");
      expect(result).toEqual([]);
    });
  });

  describe("queuePayload", () => {
    it("queues only for zombie sessions", () => {
      queuePayload("not-zombie", { x: 1 });
      expect(getQueuedCount("not-zombie")).toBe(0);

      markZombie("session-1");
      queuePayload("session-1", { x: 1 });
      queuePayload("session-1", { x: 2 });
      expect(getQueuedCount("session-1")).toBe(2);
    });

    it("ignores empty session key", () => {
      markZombie("session-1");
      queuePayload("", { x: 1 });
      expect(getQueuedCount("session-1")).toBe(0);
    });
  });

  describe("clearZombieBuffer", () => {
    it("clears all zombies and cancels reapers", () => {
      const onReap = vi.fn();
      setZombieBufferCallbacks({ onReap });

      markZombie("session-1");
      markZombie("session-2");
      queuePayload("session-1", {});

      clearZombieBuffer();

      expect(isZombie("session-1")).toBe(false);
      expect(isZombie("session-2")).toBe(false);
      expect(getQueuedCount("session-1")).toBe(0);
      vi.advanceTimersByTime(ZOMBIE_REAPER_MS);
      expect(onReap).not.toHaveBeenCalled();
    });
  });
});
