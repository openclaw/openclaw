import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { trackAsyncWork } from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import type { Deferred } from "../shared/deferred.js";
import { dispatchGatewayRequestInProcessRaw } from "./server-in-process-dispatch.js";
import type * as GatewayMethods from "./server-methods.js";
import type { GatewayRequestContext, GatewayRequestOptions } from "./server-methods/types.js";

const handleGatewayRequest = vi.hoisted(() => vi.fn());
vi.mock("./server-methods.js", async (importOriginal) => ({
  ...(await importOriginal<typeof GatewayMethods>()),
  handleGatewayRequest,
}));

describe("dispatchGatewayRequestInProcessRaw deadline clock", () => {
  let perfSpy: ReturnType<typeof vi.spyOn>;
  let dateSpy: ReturnType<typeof vi.spyOn>;
  let monotonicMs: number;
  let wallMs: number;
  const heldGates: Deferred[] = [];

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    monotonicMs = 0;
    wallMs = 1_000_000;
    perfSpy = vi.spyOn(performance, "now").mockImplementation(() => monotonicMs);
    dateSpy = vi.spyOn(Date, "now").mockImplementation(() => wallMs);
  });

  afterEach(() => {
    for (const gate of heldGates.splice(0)) {
      gate.resolve();
    }
    perfSpy.mockRestore();
    dateSpy.mockRestore();
    vi.useRealTimers();
    handleGatewayRequest.mockReset();
  });

  it.each([-10_000, 10_000])(
    "preserves the elapsed budget after a %i ms wall-clock step",
    async (step) => {
      const entered = createDeferredCore();
      const handlerDone = createDeferredCore();
      heldGates.push(handlerDone);
      handleGatewayRequest.mockImplementation(async (options: GatewayRequestOptions) => {
        wallMs += step;
        entered.resolve();
        await handlerDone.promise;
        options.respond(true, { status: "ok" });
      });

      let timedOut = false;
      const dispatchPromise = dispatchGatewayRequestInProcessRaw(
        "test.method",
        {},
        {
          client: null,
          context: { trackExecution: trackAsyncWork } as GatewayRequestContext,
          timeoutMs: 2_000,
        },
      );
      void dispatchPromise.catch(() => {
        timedOut = true;
      });
      await entered.promise;
      await vi.advanceTimersByTimeAsync(0);
      monotonicMs += 1_000;
      await vi.advanceTimersByTimeAsync(1_000);
      expect(timedOut).toBe(false);
      monotonicMs += 1_000;
      await vi.advanceTimersByTimeAsync(1_000);
      expect(timedOut).toBe(true);
      await expect(dispatchPromise).rejects.toThrow("gateway request timeout for test.method");
    },
  );
});
