import { describe, expect, it } from "vitest";
import { authorizeGatewayConnect, isLocalDirectRequest } from "./auth.js";

describe("gateway auth", () => {
  it("does not throw when req is missing socket", async () => {
    const res = await authorizeGatewayConnect({
      auth: { mode: "token", token: "secret", allowTailscale: false },
      connectAuth: { token: "secret" },
      // Regression: avoid crashing on req.socket.remoteAddress when callers pass a non-IncomingMessage.
      req: {} as never,
    });
    expect(res.ok).toBe(true);
  });

  it("reports missing and mismatched token reasons", async () => {
    const missing = await authorizeGatewayConnect({
      auth: { mode: "token", token: "secret", allowTailscale: false },
      connectAuth: null,
    });
    expect(missing.ok).toBe(false);
    expect(missing.reason).toBe("token_missing");

    const mismatch = await authorizeGatewayConnect({
      auth: { mode: "token", token: "secret", allowTailscale: false },
      connectAuth: { token: "wrong" },
    });
    expect(mismatch.ok).toBe(false);
    expect(mismatch.reason).toBe("token_mismatch");
  });

  it("reports missing token config reason", async () => {
    const res = await authorizeGatewayConnect({
      auth: { mode: "token", allowTailscale: false },
      connectAuth: { token: "anything" },
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("token_missing_config");
  });

  it("reports missing and mismatched password reasons", async () => {
    const missing = await authorizeGatewayConnect({
      auth: { mode: "password", password: "secret", allowTailscale: false },
      connectAuth: null,
    });
    expect(missing.ok).toBe(false);
    expect(missing.reason).toBe("password_missing");

    const mismatch = await authorizeGatewayConnect({
      auth: { mode: "password", password: "secret", allowTailscale: false },
      connectAuth: { password: "wrong" },
    });
    expect(mismatch.ok).toBe(false);
    expect(mismatch.reason).toBe("password_mismatch");
  });

  it("reports missing password config reason", async () => {
    const res = await authorizeGatewayConnect({
      auth: { mode: "password", allowTailscale: false },
      connectAuth: { password: "secret" },
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("password_missing_config");
  });

  it("does not treat .ts.net hostnames as local direct requests", async () => {
    // After the security fix, .ts.net hostnames should not bypass auth.
    // They should go through the Tailscale whois auth flow instead.
    const res = await authorizeGatewayConnect({
      auth: { mode: "token", token: "secret", allowTailscale: false },
      connectAuth: null,
      req: {
        socket: { remoteAddress: "127.0.0.1" },
        headers: { host: "gateway.tailnet-1234.ts.net:443" },
      } as never,
    });

    // Without tailscale auth enabled and no token provided, should fail.
    expect(res.ok).toBe(false);
  });

  it("rejects tailscale login with invalid characters", async () => {
    const res = await authorizeGatewayConnect({
      auth: { mode: "token", token: "secret", allowTailscale: true },
      connectAuth: null,
      tailscaleWhois: async () => ({ login: "peter", name: "Peter" }),
      req: {
        socket: { remoteAddress: "127.0.0.1" },
        headers: {
          host: "gateway.local",
          "x-forwarded-for": "100.64.0.1",
          "x-forwarded-proto": "https",
          "x-forwarded-host": "ai-hub.bone-egret.ts.net",
          "tailscale-user-login": "peter\x00injected",
          "tailscale-user-name": "Peter",
        },
      } as never,
    });
    // Invalid login should cause tailscale auth to fail
    expect(res.ok).toBe(false);
  });

  it("rejects tailscale login exceeding max length", async () => {
    const res = await authorizeGatewayConnect({
      auth: { mode: "token", token: "secret", allowTailscale: true },
      connectAuth: null,
      tailscaleWhois: async () => ({ login: "peter", name: "Peter" }),
      req: {
        socket: { remoteAddress: "127.0.0.1" },
        headers: {
          host: "gateway.local",
          "x-forwarded-for": "100.64.0.1",
          "x-forwarded-proto": "https",
          "x-forwarded-host": "ai-hub.bone-egret.ts.net",
          "tailscale-user-login": "a".repeat(300),
          "tailscale-user-name": "Peter",
        },
      } as never,
    });
    expect(res.ok).toBe(false);
  });

  it("allows tailscale identity to satisfy token mode auth", async () => {
    const res = await authorizeGatewayConnect({
      auth: { mode: "token", token: "secret", allowTailscale: true },
      connectAuth: null,
      tailscaleWhois: async () => ({ login: "peter", name: "Peter" }),
      req: {
        socket: { remoteAddress: "127.0.0.1" },
        headers: {
          host: "gateway.local",
          "x-forwarded-for": "100.64.0.1",
          "x-forwarded-proto": "https",
          "x-forwarded-host": "ai-hub.bone-egret.ts.net",
          "tailscale-user-login": "peter",
          "tailscale-user-name": "Peter",
        },
      } as never,
    });

    expect(res.ok).toBe(true);
    expect(res.method).toBe("tailscale");
    expect(res.user).toBe("peter");
  });
});

describe("isLocalDirectRequest", () => {
  it("returns true for localhost requests", () => {
    const result = isLocalDirectRequest({
      socket: { remoteAddress: "127.0.0.1" },
      headers: { host: "localhost:3000" },
    } as never);
    expect(result).toBe(true);
  });

  it("returns false for .ts.net hostname", () => {
    // After the security fix, .ts.net should NOT be treated as local.
    const result = isLocalDirectRequest({
      socket: { remoteAddress: "127.0.0.1" },
      headers: { host: "gateway.tailnet-1234.ts.net:443" },
    } as never);
    expect(result).toBe(false);
  });

  it("returns false for non-loopback addresses", () => {
    const result = isLocalDirectRequest({
      socket: { remoteAddress: "192.168.1.100" },
      headers: { host: "localhost" },
    } as never);
    expect(result).toBe(false);
  });

  it("returns true for ::1 loopback", () => {
    const result = isLocalDirectRequest({
      socket: { remoteAddress: "::1" },
      headers: { host: "127.0.0.1:8080" },
    } as never);
    expect(result).toBe(true);
  });
});
