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
  it.each([
    ["session-only", ["operator.sessions.read", "operator.sessions.write"], true],
    ["unadvertised", ["operator.admin"], false],
  ] as const)(
    "does not request unavailable system information for %s connections",
    async (_name, scopes, advertised) => {
      const request = vi.fn().mockResolvedValue(deviceSystemInfo);
      const current = source(request);
      current.publish({
        ...current.gateway.snapshot,
        hello: gatewayHelloForMethods(advertised ? ["system.info"] : [], scopes),
      });
      await expect(readSystemInfo(current.gateway)).rejects.toMatchObject({ name: "AbortError" });
      expect(request).not.toHaveBeenCalled();
    },
  );

  it.each(["scopes", "client", "hello", "credentials"] as const)(
    "retires pending and cached samples after a %s change",
    async (change) => {
      vi.useFakeTimers();
      for (const settled of [false, true]) {
        const pending = createDeferred<typeof deviceSystemInfo>();
        const refreshed = { ...deviceSystemInfo, machineName: "New host" };
        const request = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(refreshed);
        const current = source(request);
        const signal = new AbortController().signal;
        const result = readSystemInfo(current.gateway, signal);
        const rejected = settled
          ? undefined
          : expect(result).rejects.toMatchObject({ name: "AbortError" });
        if (settled) {
          pending.resolve(deviceSystemInfo);
          expect((await result).value).toEqual(deviceSystemInfo);
        }
        if (change === "scopes") {
          current.gateway.snapshot.hello!.auth!.scopes = ["operator.sessions.read"];
        } else if (change === "credentials") {
          Object.assign(current.gateway, { connectionRevision: 1 });
        } else {
          current.publish({
            ...current.gateway.snapshot,
            ...(change === "client"
              ? { client: source(request).gateway.snapshot.client }
              : { hello: gatewayHelloForMethods(["system.info"]) }),
          });
        }
        if (!settled) {
          pending.resolve(deviceSystemInfo);
          await rejected;
          expect(request.mock.calls[0]?.[2].signal.aborted).toBe(true);
        }
        if (change === "scopes") {
          await expect(readSystemInfo(current.gateway)).rejects.toMatchObject({
            name: "AbortError",
          });
          expect(request).toHaveBeenCalledOnce();
          expect(request.mock.calls[0]?.[2].signal.aborted).toBe(true);
          current.gateway.snapshot.hello!.auth!.scopes = ["operator.read"];
        }
        expect((await readSystemInfo(current.gateway, signal)).value).toEqual(refreshed);
        expect(request).toHaveBeenCalledTimes(2);
      }
    },
  );

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
