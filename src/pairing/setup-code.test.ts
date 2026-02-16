import { describe, expect, it, vi } from "vitest";
import { encodePairingSetupCode, resolvePairingSetupFromConfig } from "./setup-code.js";

describe("pairing setup code", () => {
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
        auth: { mode: "token", token: "tok_123" },
      },
    });

    expect(resolved).toEqual({
      ok: true,
      payload: {
        url: "ws://gateway.local:19001",
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
});
