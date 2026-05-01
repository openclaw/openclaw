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

    it("reports no handlers when nothing is registered (no active run)", () => {
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

  describe("sticky cancellation (late handler registration)", () => {
    it("replays terminal cancel to handler registered after emit", () => {
      const t = target("agent:main:main", "run-1");
      const reason = { source: "chat-abort", message: "user stopped" };

      // Core aborts before any plugin handler is registered.
      emitSessionRunCancel(t, reason);

      // Late handler must still observe the terminal cancel.
      const lateHandler = vi.fn();
      onSessionRunCancel(t, lateHandler);

      expect(lateHandler).toHaveBeenCalledTimes(1);
      expect(lateHandler).toHaveBeenCalledWith(t, reason);
    });

    it("replays to multiple late handlers", () => {
      const t = target("agent:main:main", "run-1");

      emitSessionRunCancel(t, { source: "server-close" });

      const handler1 = vi.fn();
      const handler2 = vi.fn();
      onSessionRunCancel(t, handler1);
      onSessionRunCancel(t, handler2);

      expect(handler1).toHaveBeenCalledTimes(1);
      expect(handler2).toHaveBeenCalledTimes(1);
    });

    it("keeps terminal cancel reason from first emit when multiple emits occur", () => {
      const t = target("agent:main:main", "run-1");

      emitSessionRunCancel(t, { source: "first", message: "original" });
      // Second emit should not overwrite terminal reason (first wins).
      emitSessionRunCancel(t, { source: "second", message: "override" });

      const lateHandler = vi.fn();
      onSessionRunCancel(t, lateHandler);

      expect(lateHandler).toHaveBeenCalledWith(t, { source: "first", message: "original" });
    });

    it("clears terminal cancel so later handlers receive normal registration", () => {
      const t = target("agent:main:main", "run-1");

      emitSessionRunCancel(t, { source: "chat-abort" });
      clearSessionRunCancelTarget(t);

      // After clearing, new registrations follow the normal path.
      const handler = vi.fn();
      onSessionRunCancel(t, handler);
      expect(handler).not.toHaveBeenCalled();
      expect(__testing.handlerCount(t)).toBe(1);
    });

    it("clears terminal state on __testing.reset", () => {
      const t = target("agent:main:main", "run-1");

      emitSessionRunCancel(t, { source: "test" });
      expect(__testing.terminalCancelCount()).toBe(1);

      __testing.reset();

      const handler = vi.fn();
      onSessionRunCancel(t, handler);
      expect(handler).not.toHaveBeenCalled();
      expect(__testing.terminalCancelCount()).toBe(0);
    });

    it("late handler that throws does not prevent others from replaying", () => {
      const t = target("agent:main:main", "run-1");
      emitSessionRunCancel(t);

      const noisy = vi.fn(() => {
        throw new Error("late boom");
      });
      const healthy = vi.fn();

      expect(() => onSessionRunCancel(t, noisy)).not.toThrow();
      onSessionRunCancel(t, healthy);

      expect(noisy).toHaveBeenCalledTimes(1);
      expect(healthy).toHaveBeenCalledTimes(1);
    });

    it("late async handler rejections are swallowed", async () => {
      const t = target("agent:main:main", "run-1");
      emitSessionRunCancel(t);

      const rejecting = vi.fn(async () => {
        throw new Error("async late boom");
      });
      onSessionRunCancel(t, rejecting);

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
