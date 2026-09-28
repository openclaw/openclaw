import { expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { callGateway as CallGateway, formatGatewayTransportErrorJson } from "./call.js";
import { isGatewayTransportError } from "./transport-error.js";

// Reuse the call owner fixture without growing its oversized test file or duplicating mocks.
export function registerGatewayCallDeadlineTests(
  setup: (mode: "silent" | "hello") => {
    call: typeof CallGateway;
    formatError: typeof formatGatewayTransportErrorJson;
    setRequest: (request: () => Promise<unknown>) => void;
    setStop: (stop: () => Promise<void>) => void;
    startCalls: () => number;
    hello: () => void;
  },
): void {
  it.each(["silent", "hello", "delayed-hello"] as const)(
    "preserves the original deadline, cleanup, and timeout details (%s)",
    async (mode) => {
      const harness = setup(mode === "delayed-hello" ? "silent" : mode);
      const request = vi.fn(() => createDeferred<unknown>().promise);
      harness.setRequest(request);
      const teardown = createDeferred();
      const stop = vi.fn(() => teardown.promise);
      harness.setStop(stop);
      const controller = new AbortController();
      let settled = false;
      vi.useFakeTimers();
      const result = harness
        .call({ method: "health", timeoutMs: 5, signal: controller.signal })
        .catch((error: unknown) => {
          settled = true;
          return error;
        });
      await vi.advanceTimersByTimeAsync(4);
      expect(harness.startCalls()).toBe(1);
      expect(stop).not.toHaveBeenCalled();
      if (mode === "delayed-hello") {
        harness.hello();
      }
      const dispatched = mode !== "silent";
      expect(request).toHaveBeenCalledTimes(dispatched ? 1 : 0);
      await vi.advanceTimersByTimeAsync(1);
      // Hello must not renew the budget. Deadline failure joins teardown before settling.
      expect(stop).toHaveBeenCalledOnce();
      expect(settled).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
      controller.abort();
      harness.hello();
      expect(request).toHaveBeenCalledTimes(dispatched ? 1 : 0);
      expect(stop).toHaveBeenCalledOnce();
      teardown.resolve();
      const error = await result;
      if (!isGatewayTransportError(error)) {
        throw new Error("Expected a Gateway timeout");
      }
      expect(error).toMatchObject({
        name: "GatewayTransportError",
        kind: "timeout",
        timeoutMs: 5,
      });
      expect(error.message).toContain("gateway timeout after 5ms");
      expect(error.message).toContain("Gateway target: ws://127.0.0.1:18789");
      expect(error.message).toContain("Source: local loopback");
      expect(error.message).toContain("Bind: loopback");
      expect(error.message.includes("outcome is unknown")).toBe(dispatched);
      expect(error.message.includes("Verify the current state")).toBe(dispatched);
      expect(harness.formatError(error)?.error.message).toBe("gateway timeout after 5ms");
    },
  );
}
