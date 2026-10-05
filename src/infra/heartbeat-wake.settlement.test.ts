import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { resetGatewayWorkAdmission } from "../process/gateway-work-admission.js";
import {
  HEARTBEAT_SKIP_REQUESTS_IN_FLIGHT,
  requestHeartbeat,
  requestHeartbeatAndWait,
  setHeartbeatWakeHandler,
} from "./heartbeat-wake.js";
import {
  requestSessionEventWakeAndWait,
  setSessionEventWakeHandler,
} from "./session-event-wake.js";

describe("heartbeat wake settlement", () => {
  let disposeHandler: (() => void) | undefined;

  afterEach(async () => {
    resetGatewayWorkAdmission();
    if (vi.isFakeTimers()) {
      disposeHandler?.();
      disposeHandler = setHeartbeatWakeHandler(async () => ({
        status: "skipped",
        reason: "disabled",
      }));
      await vi.runAllTimersAsync();
    }
    disposeHandler?.();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function setHandler(handler: Parameters<typeof setHeartbeatWakeHandler>[0]) {
    disposeHandler = setHeartbeatWakeHandler(handler);
  }

  it.each(["absent", "queued", "running"])(
    "settles a waiter with an unavailable handler when %s",
    async (phase) => {
      vi.useFakeTimers();
      const release = createDeferred();
      setHandler(
        phase === "absent"
          ? null
          : async () => {
              await release.promise;
              return { status: "ran", durationMs: 1 };
            },
      );
      const controller = new AbortController();
      const result = requestHeartbeatAndWait(
        { source: "interval", intent: "scheduled", coalesceMs: 0 },
        { abortSignal: controller.signal },
      );
      try {
        if (phase === "running") {
          await vi.advanceTimersByTimeAsync(0);
        }
        if (phase !== "absent") {
          disposeHandler?.();
        }
        expect(await Promise.race([result, Promise.resolve("pending")])).toEqual({
          status: "skipped",
          reason: "handler-unavailable",
        });
        if (phase === "absent") {
          const handler = vi.fn().mockResolvedValue({ status: "ran", durationMs: 1 });
          setHandler(handler);
          await vi.advanceTimersByTimeAsync(0);
          expect(handler).not.toHaveBeenCalled();
        }
      } finally {
        controller.abort();
        release.resolve();
        await result;
      }
    },
  );

  it("dispatches queued notifications after installation before a later target", async () => {
    vi.useFakeTimers();
    setHandler(null);
    const wake = { source: "session-state" as const, intent: "immediate" as const };
    requestHeartbeat({
      ...wake,
      sessionKey: "agent:main:ready",
      coalesceMs: 0,
    });
    const handler = vi.fn().mockResolvedValue({ status: "ran", durationMs: 7 });
    setHandler(handler);
    const later = requestHeartbeatAndWait({
      ...wake,
      sessionKey: "agent:main:later",
      coalesceMs: 5_000,
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(handler.mock.calls.map(([request]) => request.sessionKey)).toEqual(["agent:main:ready"]);

    await vi.advanceTimersByTimeAsync(5_000);
    await expect(later).resolves.toEqual({ status: "ran", durationMs: 7 });
    expect(handler.mock.calls.map(([request]) => request.sessionKey)).toEqual([
      "agent:main:ready",
      "agent:main:later",
    ]);
  });

  it.each(["heartbeat", "session"] as const)(
    "settles coalesced callers through the %s entry point",
    async (entryPoint) => {
      vi.useFakeTimers();
      const handler = vi.fn().mockResolvedValue({ status: "ran", durationMs: 7 });
      const install =
        entryPoint === "session" ? setSessionEventWakeHandler : setHeartbeatWakeHandler;
      const request =
        entryPoint === "session" ? requestSessionEventWakeAndWait : requestHeartbeatAndWait;
      const dispose = install(handler);
      const wake =
        entryPoint === "session"
          ? { source: "cron" as const, intent: "event" as const, sessionKey: "agent:main:main" }
          : { source: "interval" as const, intent: "scheduled" as const, reason: "interval" };
      const settled = vi.fn();
      try {
        const resultA = requestHeartbeatAndWait({ ...wake, agentId: "main", coalesceMs: 100 });
        const resultB = request({ ...wake, agentId: "main", coalesceMs: 100 });
        void resultA.then(settled);
        void resultB.then(settled);
        await vi.advanceTimersByTimeAsync(100);
        expect(handler).toHaveBeenCalledOnce();
        if (entryPoint === "heartbeat") {
          expect(handler).toHaveBeenCalledWith({ ...wake, agentId: "main" });
        }
        expect(settled).toHaveBeenCalledTimes(2);
        expect(settled).toHaveBeenNthCalledWith(1, { status: "ran", durationMs: 7 });
        expect(settled).toHaveBeenNthCalledWith(2, { status: "ran", durationMs: 7 });
        await expect(Promise.all([resultA, resultB])).resolves.toEqual([
          { status: "ran", durationMs: 7 },
          { status: "ran", durationMs: 7 },
        ]);
      } finally {
        dispose();
      }
    },
  );

  it("keeps an awaited cron wake pending across a retryable skip", async () => {
    vi.useFakeTimers();
    const handler = vi
      .fn()
      .mockResolvedValueOnce({ status: "skipped", reason: HEARTBEAT_SKIP_REQUESTS_IN_FLIGHT })
      .mockResolvedValueOnce({ status: "ran", durationMs: 1 });
    setHandler(handler);
    const result = requestHeartbeatAndWait({
      source: "cron",
      intent: "scheduled",
      reason: "interval",
      coalesceMs: 0,
    });
    const settled = vi.fn();
    void result.then(settled);

    await vi.advanceTimersByTimeAsync(1);
    expect(handler).toHaveBeenCalledOnce();
    expect(settled).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(60_000);
    await expect(result).resolves.toEqual({ status: "ran", durationMs: 1 });
    expect(handler).toHaveBeenCalledTimes(2);
  });
});
