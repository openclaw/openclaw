import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { waitForGatewayReady } from "../../scripts/measure-rpc-rtt.mjs";

describe("scripts/measure-rpc-rtt.mjs", () => {
  it("bounds readiness probes and keeps polling after a stalled response", async () => {
    const child = new EventEmitter();
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new DOMException("request timed out", "TimeoutError"))
      .mockResolvedValueOnce({ ok: true });

    await waitForGatewayReady({
      child,
      fetchImpl,
      port: 12345,
      probeTimeoutMs: 7,
      readyTimeoutMs: 50,
      sleepMs: 1,
      stderrPath: "/no/such/stderr.log",
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      "http://127.0.0.1:12345/readyz",
      expect.objectContaining({
        signal: expect.any(AbortSignal),
      }),
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      "http://127.0.0.1:12345/healthz",
      expect.objectContaining({
        signal: expect.any(AbortSignal),
      }),
    );
  });
});
