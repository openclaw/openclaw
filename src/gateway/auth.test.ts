import { afterEach, describe, expect, it, vi } from "vitest";
import { authorizeGatewayConnect, isLocalDirectRequest } from "./auth.js";
import * as netModule from "./net.js";

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

  it("treats local tailscale serve hostnames as direct", async () => {
    const res = await authorizeGatewayConnect({
      auth: { mode: "token", token: "secret", allowTailscale: true },
      connectAuth: { token: "secret" },
      req: {
        socket: { remoteAddress: "127.0.0.1" },
        headers: { host: "gateway.tailnet-1234.ts.net:443" },
      } as never,
    });

    expect(res.ok).toBe(true);
    expect(res.method).toBe("token");
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

describe("isLocalDirectRequest – Docker gateway verification", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns true when Docker env + client IP matches gateway + Host=localhost", () => {
    vi.spyOn(netModule, "isDockerEnvironment").mockReturnValue(true);
    vi.spyOn(netModule, "readDockerGatewayIp").mockReturnValue("192.168.65.1");

    const result = isLocalDirectRequest({
      socket: { remoteAddress: "192.168.65.1" },
      headers: { host: "localhost:18789" },
    } as never);

    expect(result).toBe(true);
  });

  it("returns false when Docker env + client IP does NOT match gateway (spoofing blocked)", () => {
    vi.spyOn(netModule, "isDockerEnvironment").mockReturnValue(true);
    vi.spyOn(netModule, "readDockerGatewayIp").mockReturnValue("192.168.65.1");

    const result = isLocalDirectRequest({
      socket: { remoteAddress: "172.17.0.3" },
      headers: { host: "localhost:18789" },
    } as never);

    expect(result).toBe(false);
  });

  it("returns false when Docker env + matching gateway IP + Host=remote.host", () => {
    vi.spyOn(netModule, "isDockerEnvironment").mockReturnValue(true);
    vi.spyOn(netModule, "readDockerGatewayIp").mockReturnValue("192.168.65.1");

    const result = isLocalDirectRequest({
      socket: { remoteAddress: "192.168.65.1" },
      headers: { host: "remote.example.com" },
    } as never);

    expect(result).toBe(false);
  });

  it("returns false when Docker env + forwarded headers present", () => {
    vi.spyOn(netModule, "isDockerEnvironment").mockReturnValue(true);
    vi.spyOn(netModule, "readDockerGatewayIp").mockReturnValue("192.168.65.1");

    const result = isLocalDirectRequest({
      socket: { remoteAddress: "192.168.65.1" },
      headers: {
        host: "localhost:18789",
        "x-forwarded-for": "10.0.0.1",
      },
    } as never);

    expect(result).toBe(false);
  });

  it("returns false when Docker env + no gateway IP available", () => {
    vi.spyOn(netModule, "isDockerEnvironment").mockReturnValue(true);
    vi.spyOn(netModule, "readDockerGatewayIp").mockReturnValue(undefined);

    const result = isLocalDirectRequest({
      socket: { remoteAddress: "192.168.65.1" },
      headers: { host: "localhost:18789" },
    } as never);

    expect(result).toBe(false);
  });

  it("returns true for non-Docker loopback requests (original behavior)", () => {
    vi.spyOn(netModule, "isDockerEnvironment").mockReturnValue(false);

    const result = isLocalDirectRequest({
      socket: { remoteAddress: "127.0.0.1" },
      headers: { host: "localhost:18789" },
    } as never);

    expect(result).toBe(true);
  });

  it("handles IPv4-mapped IPv6 gateway addresses", () => {
    vi.spyOn(netModule, "isDockerEnvironment").mockReturnValue(true);
    vi.spyOn(netModule, "readDockerGatewayIp").mockReturnValue("192.168.65.1");

    const result = isLocalDirectRequest({
      socket: { remoteAddress: "::ffff:192.168.65.1" },
      headers: { host: "localhost:18789" },
    } as never);

    expect(result).toBe(true);
  });
});
