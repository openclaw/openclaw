import type http2 from "node:http2";
import { describe, expect, it, vi } from "vitest";

const { connectSpy, tlsConnectSpy, tunnelSpy, fakeSession, fakeTlsSocket } = vi.hoisted(() => {
  const fakeSession = { close: vi.fn(), destroy: vi.fn() };
  const fakeTlsSocket = { encrypted: true };
  return {
    fakeSession,
    fakeTlsSocket,
    connectSpy: vi.fn(() => fakeSession),
    tlsConnectSpy: vi.fn(() => fakeTlsSocket),
    tunnelSpy: vi.fn(async () => ({ tunneled: true })),
  };
});

vi.mock("node:http2", () => ({
  default: { connect: connectSpy },
  connect: connectSpy,
}));

vi.mock("node:tls", () => ({
  default: { connect: tlsConnectSpy },
  connect: tlsConnectSpy,
}));

vi.mock("./net/http-connect-tunnel.js", () => ({
  openHttpConnectTunnel: tunnelSpy,
}));

describe("connectApnsHttp2Session", () => {
  it("uses direct http2.connect when no HTTPS proxy is configured", async () => {
    const { connectApnsHttp2Session } = await import("./push-apns-http2.js");

    const session = await connectApnsHttp2Session({
      authority: "https://api.sandbox.push.apple.com",
      timeoutMs: 10_000,
      env: {},
    });

    expect(session).toBe(fakeSession);
    expect(tunnelSpy).not.toHaveBeenCalled();
    expect(connectSpy).toHaveBeenCalledWith("https://api.sandbox.push.apple.com");
  });

  it("uses an HTTP CONNECT tunnel and disables direct fallback when HTTPS proxy is configured", async () => {
    const { connectApnsHttp2Session } = await import("./push-apns-http2.js");

    const session = await connectApnsHttp2Session({
      authority: "https://api.push.apple.com",
      timeoutMs: 10_000,
      env: { HTTPS_PROXY: "http://proxy.example:8080" },
    });

    expect(session).toBe(fakeSession);
    expect(tunnelSpy).toHaveBeenCalledWith({
      proxyUrl: "http://proxy.example:8080",
      targetHost: "api.push.apple.com",
      targetPort: 443,
      timeoutMs: 10_000,
    });
    expect(tlsConnectSpy).toHaveBeenCalledWith({
      socket: { tunneled: true },
      servername: "api.push.apple.com",
      ALPNProtocols: ["h2"],
    });
    expect(connectSpy).toHaveBeenCalledWith("https://api.push.apple.com", {
      createConnection: expect.any(Function),
    });
    const connectCall = connectSpy.mock.calls.at(-1) as
      | [string, http2.ClientSessionOptions]
      | undefined;
    const createConnection = connectCall?.[1].createConnection;
    expect(createConnection?.(new URL("https://api.push.apple.com"), {})).toBe(fakeTlsSocket);
  });

  it("rejects non-APNs authorities", async () => {
    const { connectApnsHttp2Session } = await import("./push-apns-http2.js");

    await expect(
      connectApnsHttp2Session({
        authority: "https://example.com",
        timeoutMs: 10_000,
        env: { HTTPS_PROXY: "http://proxy.example:8080" },
      }),
    ).rejects.toThrow("Unsupported APNs authority");
  });
});
