import { describe, expect, it } from "vitest";
import { startGatewayServer } from "../src/gateway/server.js";
import { getDeterministicFreePortBlock } from "../src/test-utils/ports.js";

async function getFreeGatewayPort(): Promise<number> {
  return await getDeterministicFreePortBlock();
}

describe("gateway http security headers", () => {
  it("adds baseline security headers on Control UI responses", async () => {
    const prev = {
      token: process.env.OPENCLAW_GATEWAY_TOKEN,
      skipChannels: process.env.OPENCLAW_SKIP_CHANNELS,
      skipCron: process.env.OPENCLAW_SKIP_CRON,
      skipCanvas: process.env.OPENCLAW_SKIP_CANVAS_HOST,
    };

    const token = "test-token-security-headers";
    process.env.OPENCLAW_GATEWAY_TOKEN = token;
    process.env.OPENCLAW_SKIP_CHANNELS = "1";
    process.env.OPENCLAW_SKIP_CRON = "1";
    process.env.OPENCLAW_SKIP_CANVAS_HOST = "1";

    const port = await getFreeGatewayPort();
    const server = await startGatewayServer(port, {
      bind: "loopback",
      auth: { mode: "token", token },
      controlUiEnabled: true,
    });

    try {
      const res = await fetch(`http://127.0.0.1:${port}/`);
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
      expect(res.headers.get("x-frame-options")).toBe("DENY");
      const permissions = res.headers.get("permissions-policy") ?? "";
      expect(permissions).toContain("camera=()");
      expect(permissions).toContain("microphone=()");
      expect(permissions).toContain("geolocation=()");
    } finally {
      await server.close({ reason: "security headers test complete" });
      if (prev.token === undefined) delete process.env.OPENCLAW_GATEWAY_TOKEN;
      else process.env.OPENCLAW_GATEWAY_TOKEN = prev.token;
      if (prev.skipChannels === undefined) delete process.env.OPENCLAW_SKIP_CHANNELS;
      else process.env.OPENCLAW_SKIP_CHANNELS = prev.skipChannels;
      if (prev.skipCron === undefined) delete process.env.OPENCLAW_SKIP_CRON;
      else process.env.OPENCLAW_SKIP_CRON = prev.skipCron;
      if (prev.skipCanvas === undefined) delete process.env.OPENCLAW_SKIP_CANVAS_HOST;
      else process.env.OPENCLAW_SKIP_CANVAS_HOST = prev.skipCanvas;
    }
  }, 60_000);
});
