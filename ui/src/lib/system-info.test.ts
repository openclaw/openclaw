// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { ApplicationGatewaySnapshot } from "../app/gateway.ts";
import { createApplicationGateway } from "../test-helpers/application-context.ts";
import { deviceSystemInfo } from "../test-helpers/devices-fixtures.ts";
import { gatewayHelloForMethods } from "../test-helpers/gateway-methods.ts";
import { readSystemInfo } from "./system-info.ts";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function source(request: GatewayBrowserClient["request"]) {
  return createApplicationGateway({
    phase: "connected",
    client: { request } as GatewayBrowserClient,
    hello: gatewayHelloForMethods(["system.info"]),
  } as ApplicationGatewaySnapshot);
}

describe("shared system information reads", () => {
  it("defers hidden reads until a visible consumer returns", async () => {
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    const request = vi.fn().mockResolvedValue(deviceSystemInfo);
    const { gateway } = source(request);
    await expect(readSystemInfo(gateway)).rejects.toMatchObject({ name: "AbortError" });
    expect(request).not.toHaveBeenCalled();
    visibility.mockReturnValue("visible");
    expect((await readSystemInfo(gateway)).value).toEqual(deviceSystemInfo);
    expect(request).toHaveBeenCalledOnce();
  });

  it.each(["client", "hello", "credentials"] as const)(
    "retires a fresh cached sample when the %s generation changes",
    async (change) => {
      vi.useFakeTimers();
      const request = vi
        .fn()
        .mockResolvedValueOnce(deviceSystemInfo)
        .mockResolvedValue({ ...deviceSystemInfo, machineName: "New host" });
      const current = source(request);
      const signal = new AbortController().signal;
      expect((await readSystemInfo(current.gateway, signal)).value).toEqual(deviceSystemInfo);
      if (change === "credentials") {
        Object.assign(current.gateway, { connectionRevision: 1 });
      } else {
        current.publish({
          ...current.gateway.snapshot,
          ...(change === "client"
            ? { client: source(request).gateway.snapshot.client }
            : { hello: gatewayHelloForMethods(["system.info"]) }),
        });
      }
      expect((await readSystemInfo(current.gateway, signal)).value.machineName).toBe("New host");
      expect(request).toHaveBeenCalledTimes(2);
    },
  );

  it("shares pending manual reads, preserves sample metadata, and refreshes only settled results", async () => {
    vi.useFakeTimers();
    const pending = createDeferred<typeof deviceSystemInfo>();
    const request = vi.fn().mockReturnValue(pending.promise);
    const { gateway } = source(request);
    const leaving = new AbortController();
    const remaining = new AbortController();
    const first = readSystemInfo(gateway, leaving.signal);
    const firstRejected = expect(first).rejects.toMatchObject({ name: "AbortError" });
    const second = readSystemInfo(gateway, remaining.signal, { fresh: true });
    leaving.abort();
    await firstRejected;
    expect(request.mock.calls[0]?.[2].signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(72);
    pending.resolve(deviceSystemInfo);
    const sample = await second;
    expect(sample.roundTripMs).toBe(72);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await readSystemInfo(gateway, remaining.signal)).toEqual(sample);
    expect(request).toHaveBeenCalledOnce();
    const refreshed = { ...deviceSystemInfo, machineName: "Refreshed host" };
    request.mockResolvedValueOnce(refreshed);
    expect((await readSystemInfo(gateway, remaining.signal, { fresh: true })).value).toEqual(
      refreshed,
    );
    expect((await readSystemInfo(gateway, remaining.signal)).value).toEqual(refreshed);
    expect(request).toHaveBeenCalledTimes(2);
  });
});
