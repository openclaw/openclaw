/**
 * Pre-handshake WebSocket origin gate tests.
 */
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.js";
import { createGatewayVerifyClient } from "./verify-client.js";

function makeReq(opts: { origin?: string; host?: string; remoteAddress?: string } = {}) {
  return {
    socket: { remoteAddress: opts.remoteAddress ?? "127.0.0.1" },
    headers: {
      ...(opts.origin ? { origin: opts.origin } : {}),
      ...(opts.host ? { host: opts.host } : {}),
    },
  } as unknown as import("node:http").IncomingMessage;
}

function makeClient(cfg: Partial<OpenClawConfig> = {}) {
  return createGatewayVerifyClient({
    log: { info: () => {}, warn: () => {} },
    getConfigSnapshot: () => cfg as OpenClawConfig,
  });
}

function verify(
  vc: ReturnType<typeof createGatewayVerifyClient>,
  req: import("node:http").IncomingMessage,
  origin: string,
) {
  return new Promise<boolean>((resolve) => vc({ origin, req }, (ok) => resolve(ok)));
}

describe("createGatewayVerifyClient", () => {
  it("passes clients with no Origin (CLI, native apps)", async () => {
    const ok = await verify(makeClient(), makeReq({}), "");
    expect(ok).toBe(true);
  });

  it("accepts an allowed browser Origin", async () => {
    const vc = makeClient({
      gateway: { controlUi: { allowedOrigins: ["https://app.example.com"] } },
    });
    const ok = await verify(
      vc,
      makeReq({ origin: "https://app.example.com", host: "127.0.0.1:18789" }),
      "https://app.example.com",
    );
    expect(ok).toBe(true);
  });

  it("rejects a disallowed browser Origin", async () => {
    const vc = makeClient({
      gateway: { controlUi: { allowedOrigins: ["https://app.example.com"] } },
    });
    const ok = await verify(
      vc,
      makeReq({ origin: "https://evil.example.com", host: "127.0.0.1:18789" }),
      "https://evil.example.com",
    );
    expect(ok).toBe(false);
  });

  it("rejects a literal null opaque Origin", async () => {
    const ok = await verify(
      makeClient(),
      makeReq({ origin: "null", host: "127.0.0.1:18789", remoteAddress: "127.0.0.1" }),
      "null",
    );
    expect(ok).toBe(false);
  });
});
