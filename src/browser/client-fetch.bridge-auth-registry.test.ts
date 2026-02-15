import { describe, expect, it, vi } from "vitest";
import { __test } from "./client-fetch.js";

describe("fetchBrowserJson loopback auth (bridge auth registry)", () => {
  it("falls back to per-port bridge auth when config auth is not available", async () => {
    const port = 18765;
    const getBridgeAuthForPort = vi.fn((candidate: number) =>
      candidate === port ? { token: "registry-token" } : undefined,
    );
    const init = __test.withLoopbackBrowserAuth(`http://127.0.0.1:${port}/`, undefined, {
      loadConfig: () => ({}),
      resolveBrowserControlAuth: () => ({}),
      getBridgeAuthForPort,
    });
    const headers = new Headers(init.headers ?? {});
    expect(headers.get("authorization")).toBe("Bearer registry-token");
    expect(getBridgeAuthForPort).toHaveBeenCalledWith(port);
  });
});
