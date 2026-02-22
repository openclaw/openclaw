import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodePairingSetupCode, resolvePairingSetupFromConfig } from "./setup-code.js";

describe("pairing setup code", () => {
  beforeEach(() => {
    vi.stubEnv("OPENCLAW_GATEWAY_TOKEN", "");
    vi.stubEnv("CLAWDBOT_GATEWAY_TOKEN", "");
    vi.stubEnv("OPENCLAW_GATEWAY_PASSWORD", "");
    vi.stubEnv("CLAWDBOT_GATEWAY_PASSWORD", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("encodes payload as base64url JSON", () => {
    const code = encodePairingSetupCode({
      url: "wss://gateway.example.com:443",
      token: "abc",
    });

    expect(code).toBe("eyJ1cmwiOiJ3c3M6Ly9nYXRld2F5LmV4YW1wbGUuY29tOjQ0MyIsInRva2VuIjoiYWJjIn0");
  });

  it("resolves custom bind + token auth", async () => {
    const resolved = await resolvePairingSetupFromConfig({
      gateway: {
        bind: "custom",
        customBindHost: "gateway.local",
        port: 19001,
        tls: { enabled: true },
        auth: { mode: "token", token: "tok_123" },
      },
    });

    expect(resolved).toEqual({
      ok: true,
      payload: {
        url: "wss://gateway.local:19001",
        token: "tok_123",
        password: undefined,
      },
      authLabel: "token",
      urlSource: "gateway.bind=custom",
    });
  });

  it("honors env token override", async () => {
    const resolved = await resolvePairingSetupFromConfig(
      {
        gateway: {
          bind: "custom",
          customBindHost: "gateway.local",
          tls: { enabled: true },
          auth: { mode: "token", token: "old" },
        },
      },
      {
        env: {
          OPENCLAW_GATEWAY_TOKEN: "new-token",
        },
      },
    );

    expect(resolved.ok).toBe(true);
    if (!resolved.ok) {
      throw new Error("expected setup resolution to succeed");
    }
    expect(resolved.payload.token).toBe("new-token");
  });

  it("errors when gateway is loopback only", async () => {
    const resolved = await resolvePairingSetupFromConfig({
      gateway: {
        bind: "loopback",
        auth: { mode: "token", token: "tok" },
      },
    });

    expect(resolved.ok).toBe(false);
    if (resolved.ok) {
      throw new Error("expected setup resolution to fail");
    }
    expect(resolved.error).toContain("only bound to loopback");
  });

  it("uses tailscale serve DNS when available", async () => {
    const runCommandWithTimeout = vi.fn(async () => ({
      code: 0,
      stdout: '{"Self":{"DNSName":"mb-server.tailnet.ts.net."}}',
      stderr: "",
    }));

    const resolved = await resolvePairingSetupFromConfig(
      {
        gateway: {
          tailscale: { mode: "serve" },
          auth: { mode: "password", password: "secret" },
        },
      },
      {
        runCommandWithTimeout,
      },
    );

    expect(resolved).toEqual({
      ok: true,
      payload: {
        url: "wss://mb-server.tailnet.ts.net",
        token: undefined,
        password: "secret",
      },
      authLabel: "password",
      urlSource: "gateway.tailscale.mode=serve",
    });
  });

  it("prefers gateway.remote.url over tailscale when requested", async () => {
    const runCommandWithTimeout = vi.fn(async () => ({
      code: 0,
      stdout: '{"Self":{"DNSName":"mb-server.tailnet.ts.net."}}',
      stderr: "",
    }));

    const resolved = await resolvePairingSetupFromConfig(
      {
        gateway: {
          tailscale: { mode: "serve" },
          remote: { url: "wss://remote.example.com:444" },
          auth: { mode: "token", token: "tok_123" },
        },
      },
      {
        preferRemoteUrl: true,
        runCommandWithTimeout,
      },
    );

    expect(resolved).toEqual({
      ok: true,
      payload: {
        url: "wss://remote.example.com:444",
        token: "tok_123",
        password: undefined,
      },
      authLabel: "token",
      urlSource: "gateway.remote.url",
    });
    expect(runCommandWithTimeout).not.toHaveBeenCalled();
  });

  it("rejects insecure remote ws:// URLs", async () => {
    const resolved = await resolvePairingSetupFromConfig(
      {
        gateway: {
          remote: { url: "ws://attacker.example:18789" },
          auth: { mode: "token", token: "tok_123" },
        },
      },
      { preferRemoteUrl: true },
    );

    expect(resolved.ok).toBe(false);
    if (resolved.ok) {
      throw new Error("expected setup resolution to fail");
    }
    expect(resolved.error).toContain("insecure ws://");
  });

  it("allows loopback ws:// URLs for local development", async () => {
    const resolved = await resolvePairingSetupFromConfig({
      gateway: {
        remote: { url: "ws://127.0.0.1:18789" },
        auth: { mode: "token", token: "tok_123" },
      },
    });

    expect(resolved).toEqual({
      ok: true,
      payload: {
        url: "ws://127.0.0.1:18789",
        token: "tok_123",
        password: undefined,
      },
      authLabel: "token",
      urlSource: "gateway.remote.url",
    });
  });

  it("allows IPv6 loopback ws:// URLs", async () => {
    const resolved = await resolvePairingSetupFromConfig({
      gateway: {
        remote: { url: "ws://[0:0:0:0:0:0:0:1]:18789" },
        auth: { mode: "token", token: "tok_123" },
      },
    });

    expect(resolved).toEqual({
      ok: true,
      payload: {
        url: "ws://[::1]:18789",
        token: "tok_123",
        password: undefined,
      },
      authLabel: "token",
      urlSource: "gateway.remote.url",
    });
  });
});
