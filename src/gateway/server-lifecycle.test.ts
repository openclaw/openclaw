import { describe, expect, it, vi } from "vitest";
import {
  runGatewayCleanupSequence,
  stopRegisteredGatewaySidecars,
  stopRegisteredPostReadySidecars,
} from "./server-lifecycle.js";

describe("gateway cleanup sequence", () => {
  it("runs later cleanup after sidecar failure and rethrows the first error last", async () => {
    const sidecarFailure = new Error("sidecar stop failed");
    const laterFailure = new Error("gateway close failed");
    const order: string[] = [];
    const log = { warn: vi.fn() };

    await expect(
      runGatewayCleanupSequence(
        [
          [
            "registered sidecars",
            async () => {
              order.push("sidecars");
              throw sidecarFailure;
            },
          ],
          ["close prelude", () => order.push("prelude")],
          [
            "gateway close",
            async () => {
              order.push("close");
              throw laterFailure;
            },
          ],
          ["fallback context", () => order.push("fallback")],
        ],
        log,
      ),
    ).rejects.toBe(sidecarFailure);

    expect(order).toEqual(["sidecars", "prelude", "close", "fallback"]);
    expect(log.warn).toHaveBeenCalledTimes(2);
  });
});

describe("gateway registered sidecar cleanup", () => {
  it("transfers both groups, drains every sidecar, and rethrows the first failure", async () => {
    const firstFailure = new Error("first lifetime stop failed");
    const secondFailure = new Error("second lifetime stop failed");
    const postReadyFailure = new Error("post-ready stop failed");
    const stopOrder: string[] = [];
    const runtimeState = {
      gatewayLifetimeSidecars: [] as Array<{ stop: () => void | Promise<void> }>,
      postReadySidecars: [] as Array<{ stop: () => void | Promise<void> }>,
    };
    runtimeState.gatewayLifetimeSidecars = [
      {
        stop: vi.fn(async () => {
          expect(runtimeState.gatewayLifetimeSidecars).toEqual([]);
          expect(runtimeState.postReadySidecars).toEqual([]);
          stopOrder.push("lifetime:first");
          throw firstFailure;
        }),
      },
      {
        stop: vi.fn(() => {
          stopOrder.push("lifetime:second");
          throw secondFailure;
        }),
      },
    ];
    runtimeState.postReadySidecars = [
      {
        stop: vi.fn(async () => {
          stopOrder.push("post-ready:first");
          throw postReadyFailure;
        }),
      },
      {
        stop: vi.fn(() => {
          stopOrder.push("post-ready:second");
        }),
      },
    ];
    const stops = [...runtimeState.gatewayLifetimeSidecars, ...runtimeState.postReadySidecars].map(
      (sidecar) => sidecar.stop,
    );
    const log = { warn: vi.fn() };

    await expect(stopRegisteredGatewaySidecars(runtimeState, log)).rejects.toBe(firstFailure);

    expect(stopOrder).toEqual([
      "lifetime:first",
      "lifetime:second",
      "post-ready:first",
      "post-ready:second",
    ]);
    expect(log.warn).toHaveBeenCalledTimes(3);
    expect(stops.every((stop) => stop.mock.calls.length === 1)).toBe(true);

    await stopRegisteredGatewaySidecars(runtimeState, log);
    expect(stops.every((stop) => stop.mock.calls.length === 1)).toBe(true);
  });

  it("leaves gateway-lifetime sidecars running during Gmail reload cleanup", async () => {
    const firstFailure = new Error("first post-ready stop failed");
    const lifetimeStop = vi.fn();
    const firstPostReadyStop = vi.fn(async () => {
      throw firstFailure;
    });
    const secondPostReadyStop = vi.fn(() => {
      throw new Error("second post-ready stop failed");
    });
    const runtimeState = {
      gatewayLifetimeSidecars: [{ stop: lifetimeStop }],
      postReadySidecars: [{ stop: firstPostReadyStop }, { stop: secondPostReadyStop }],
    };
    const log = { warn: vi.fn() };

    await expect(stopRegisteredPostReadySidecars(runtimeState, log)).rejects.toBe(firstFailure);

    expect(firstPostReadyStop).toHaveBeenCalledOnce();
    expect(secondPostReadyStop).toHaveBeenCalledOnce();
    expect(log.warn).toHaveBeenCalledTimes(2);
    expect(runtimeState.postReadySidecars).toEqual([]);
    expect(lifetimeStop).not.toHaveBeenCalled();
    expect(runtimeState.gatewayLifetimeSidecars).toHaveLength(1);
  });
});
