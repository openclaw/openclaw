import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __testing,
  clearSessionRunCancelTarget,
  emitSessionRunCancel,
  onSessionRunCancel,
  requestSessionRunCancel,
  setSessionRunAbortRequester,
  type SessionRunAbortRequester,
  type SessionRunCancelTarget,
} from "./session-run-cancel.js";

function target(sessionKey: string, runId: string): SessionRunCancelTarget {
  return { kind: "session_run", sessionKey, runId };
}

describe("session-run cancel fan-out seam", () => {
  afterEach(() => {
    vi.useRealTimers();
    __testing.reset();
  });

  describe("core -> plugin (emitSessionRunCancel)", () => {
    it("notifies handlers registered for the matching session_run target", () => {
      const matched = vi.fn();
      const other = vi.fn();
      onSessionRunCancel(target("agent:main:main", "run-1"), matched);
      onSessionRunCancel(target("agent:main:main", "run-2"), other);

      const result = emitSessionRunCancel(target("agent:main:main", "run-1"), {
        source: "test",
        message: "stopped",
      });

      expect(result.handlerCount).toBe(1);
      expect(matched).toHaveBeenCalledTimes(1);
      expect(matched).toHaveBeenCalledWith(
        { kind: "session_run", sessionKey: "agent:main:main", runId: "run-1" },
        { source: "test", message: "stopped" },
      );
      expect(other).not.toHaveBeenCalled();
    });

    it("is idempotent when the same target is cancelled twice (already-terminal)", () => {
      const handler = vi.fn();
      onSessionRunCancel(target("agent:main:main", "run-1"), handler);

      expect(emitSessionRunCancel(target("agent:main:main", "run-1")).handlerCount).toBe(1);
      expect(emitSessionRunCancel(target("agent:main:main", "run-1")).handlerCount).toBe(0);
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it("records terminal cancel for late handler registration and replays it", () => {
      const cancelTarget = target("agent:main:main", "run-late");
      const first = emitSessionRunCancel(cancelTarget, {
        source: "chat-abort",
        message: "user",
      });
      const late = vi.fn();

      const dispose = onSessionRunCancel(cancelTarget, late);

      expect(first.handlerCount).toBe(0);
      expect(late).toHaveBeenCalledTimes(1);
      expect(late).toHaveBeenCalledWith(cancelTarget, { source: "chat-abort", message: "user" });
      expect(__testing.hasTerminalCancel(cancelTarget)).toBe(true);
      dispose();
    });

    it("keeps the first terminal reason for deterministic late replay", () => {
      const cancelTarget = target("agent:main:main", "run-terminal");
      emitSessionRunCancel(cancelTarget, { source: "first", message: "one" });
      emitSessionRunCancel(cancelTarget, { source: "second", message: "two" });
      const late = vi.fn();

      onSessionRunCancel(cancelTarget, late);

      expect(late).toHaveBeenCalledWith(cancelTarget, { source: "first", message: "one" });
    });

    it("clears sticky terminal state for explicit run teardown", () => {
      const cancelTarget = target("agent:main:main", "run-clear");
      emitSessionRunCancel(cancelTarget, { source: "chat-abort" });
      clearSessionRunCancelTarget(cancelTarget);
      const handler = vi.fn();

      onSessionRunCancel(cancelTarget, handler);

      expect(handler).not.toHaveBeenCalled();
      expect(__testing.handlerCount(cancelTarget)).toBe(1);
    });

    it("prunes sticky terminal state after the replay TTL", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
      const cancelTarget = target("agent:main:main", "run-ttl");
      emitSessionRunCancel(cancelTarget, { source: "chat-abort" });
      vi.setSystemTime(Date.now() + __testing.terminalCancelTtlMs() + 1);
      const handler = vi.fn();

      onSessionRunCancel(cancelTarget, handler);

      expect(handler).not.toHaveBeenCalled();
      expect(__testing.handlerCount(cancelTarget)).toBe(1);
      expect(__testing.hasTerminalCancel(cancelTarget)).toBe(false);
    });

    it("bounds sticky terminal state to the newest max entries", () => {
      const maxEntries = __testing.terminalCancelMaxEntries();
      for (let i = 0; i < maxEntries + 3; i += 1) {
        emitSessionRunCancel(target("agent:main:main", `run-${i}`), { source: "chat-abort" });
      }

      expect(__testing.terminalCancelCount()).toBe(maxEntries);
      expect(__testing.hasTerminalCancel(target("agent:main:main", "run-0"))).toBe(false);
      expect(__testing.hasTerminalCancel(target("agent:main:main", "run-1"))).toBe(false);
      expect(__testing.hasTerminalCancel(target("agent:main:main", "run-2"))).toBe(false);
      expect(__testing.hasTerminalCancel(target("agent:main:main", `run-${maxEntries + 2}`))).toBe(
        true,
      );
    });

    it("reports no live handlers when nothing is registered", () => {
      const result = emitSessionRunCancel(target("agent:main:main", "run-1"));
      expect(result.handlerCount).toBe(0);
    });

    it("removes handlers via the returned disposer without affecting others", () => {
      const stays = vi.fn();
      const leaves = vi.fn();
      onSessionRunCancel(target("agent:main:main", "run-1"), stays);
      const dispose = onSessionRunCancel(target("agent:main:main", "run-1"), leaves);

      dispose();
      emitSessionRunCancel(target("agent:main:main", "run-1"));

      expect(stays).toHaveBeenCalledTimes(1);
      expect(leaves).not.toHaveBeenCalled();
    });

    it("continues fan-out when a handler throws", () => {
      const noisy = vi.fn(() => {
        throw new Error("boom");
      });
      const healthy = vi.fn();
      onSessionRunCancel(target("agent:main:main", "run-1"), noisy);
      onSessionRunCancel(target("agent:main:main", "run-1"), healthy);

      expect(() => emitSessionRunCancel(target("agent:main:main", "run-1"))).not.toThrow();
      expect(noisy).toHaveBeenCalledTimes(1);
      expect(healthy).toHaveBeenCalledTimes(1);
    });

    it("swallows async handler rejections", async () => {
      const rejecting = vi.fn(async () => {
        throw new Error("async boom");
      });
      onSessionRunCancel(target("agent:main:main", "run-1"), rejecting);

      emitSessionRunCancel(target("agent:main:main", "run-1"));
      await Promise.resolve();
      await Promise.resolve();

      expect(rejecting).toHaveBeenCalledTimes(1);
    });
  });

  describe("plugin -> core (requestSessionRunCancel)", () => {
    it("routes the cancel request through the registered abort requester", async () => {
      const requester: SessionRunAbortRequester = vi.fn(async () => true);
      setSessionRunAbortRequester(requester);

      const result = await requestSessionRunCancel(target("agent:main:main", "run-1"), {
        source: "plugin:test",
      });

      expect(result).toEqual({ requested: true, aborted: true });
      expect(requester).toHaveBeenCalledWith(
        { kind: "session_run", sessionKey: "agent:main:main", runId: "run-1" },
        { source: "plugin:test" },
      );
    });

    it("reports aborted=false when the requester finds no active run", async () => {
      setSessionRunAbortRequester(() => false);

      const result = await requestSessionRunCancel(target("agent:main:main", "run-1"));

      expect(result).toEqual({ requested: true, aborted: false });
    });

    it("reports requested=false when no requester is registered", async () => {
      const result = await requestSessionRunCancel(target("agent:main:main", "run-1"));
      expect(result).toEqual({ requested: false, aborted: false });
    });

    it("reports aborted=false when the requester throws", async () => {
      setSessionRunAbortRequester(() => {
        throw new Error("abort boom");
      });

      const result = await requestSessionRunCancel(target("agent:main:main", "run-1"));
      expect(result).toEqual({ requested: true, aborted: false });
    });

    it("clears the requester when the setter disposer runs", async () => {
      const requester = vi.fn(async () => true);
      const dispose = setSessionRunAbortRequester(requester);

      dispose();
      const result = await requestSessionRunCancel(target("agent:main:main", "run-1"));

      expect(requester).not.toHaveBeenCalled();
      expect(result).toEqual({ requested: false, aborted: false });
    });
  });
});
