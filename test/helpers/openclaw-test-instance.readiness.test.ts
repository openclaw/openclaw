import { EventEmitter } from "node:events";
import { expect, it, vi } from "vitest";
import { testing } from "./openclaw-test-instance.js";

it.each([20, 30, undefined])(
  "classifies the final readiness backoff with child exit at %s ms",
  async (exitAt) => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const child = Object.assign(new EventEmitter(), {
      pid: 12345,
      exitCode: null as number | null,
      signalCode: null,
    });
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      throw new TypeError("fetch failed");
    });
    const record = vi.fn();
    const completion = testing
      .waitForGatewayReady(child, [], [], 12345, 30, fetchImpl, undefined, record)
      .catch((error: unknown) => error);
    if (exitAt !== undefined) {
      setTimeout(() => {
        child.exitCode = 1;
        child.emit("exit", 1, null);
      }, exitAt);
    }
    try {
      await vi.advanceTimersByTimeAsync(30);
      const error = await completion;
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(
        exitAt === undefined
          ? "timeout waiting for gateway readiness"
          : "gateway exited before readiness",
      );
      expect(record).toHaveBeenCalledWith(
        expect.objectContaining({
          outcome: exitAt === undefined ? "timeout" : "child-exit",
          elapsedMs: 30,
          attempts: 2,
          child: { pid: 12345, exitCode: exitAt === undefined ? null : 1, signalCode: null },
        }),
      );
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(child.listenerCount("exit")).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await vi.runAllTimersAsync();
      await completion;
      vi.useRealTimers();
    }
  },
);
