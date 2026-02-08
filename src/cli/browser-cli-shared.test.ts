import { describe, expect, it, vi } from "vitest";
import { callBrowserRequest, type BrowserParentOpts } from "./browser-cli-shared.js";
import * as gatewayRpc from "./gateway-rpc.js";

describe("browser CLI shared transport", () => {
  it("uses browser.request with a relative path (no hardcoded control URL)", async () => {
    const gatewaySpy = vi.spyOn(gatewayRpc, "callGatewayFromCli").mockResolvedValue({
      running: true,
    });

    const opts: BrowserParentOpts = {
      timeout: "2500",
      token: "token",
      url: "ws://127.0.0.1:29173",
    };

    await callBrowserRequest(
      opts,
      {
        method: "POST",
        path: "/start",
        query: { profile: "openclaw", ignored: undefined },
      },
      { timeoutMs: 1500 },
    );

    expect(gatewaySpy).toHaveBeenCalledTimes(1);
    expect(gatewaySpy).toHaveBeenCalledWith(
      "browser.request",
      expect.objectContaining({
        url: "ws://127.0.0.1:29173",
        token: "token",
        timeout: "1500",
      }),
      expect.objectContaining({
        method: "POST",
        path: "/start",
        query: { profile: "openclaw" },
        timeoutMs: 1500,
      }),
      expect.objectContaining({
        progress: undefined,
      }),
    );

    const payload = gatewaySpy.mock.calls[0]?.[2] as { path: string };
    expect(payload.path).toBe("/start");
    expect(payload.path).not.toContain("18791");
    expect(payload.path).not.toContain("http://");
    expect(payload.path).not.toContain("https://");

    gatewaySpy.mockRestore();
  });
});
