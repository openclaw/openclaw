import type http2 from "node:http2";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetActiveManagedProxyStateForTests,
  registerActiveManagedProxyUrl,
  stopActiveManagedProxyRegistration,
} from "./net/proxy/active-proxy-state.js";

const { connectSpy, tunnelSpy, fakeSession, fakeTlsSocket } = vi.hoisted(() => {
  const fakeSession = { close: vi.fn(), destroy: vi.fn() };
  const fakeTlsSocket = { encrypted: true };
  return {
    fakeSession,
    fakeTlsSocket,
    connectSpy: vi.fn(() => fakeSession),
    tunnelSpy: vi.fn(async () => fakeTlsSocket),
  };
});

vi.mock("node:http2", () => ({
  default: { connect: connectSpy, constants: { NGHTTP2_CANCEL: 8 } },
  connect: connectSpy,
  constants: { NGHTTP2_CANCEL: 8 },
}));

vi.mock("./net/http-connect-tunnel.js", () => ({
  openHttpConnectTunnel: tunnelSpy,
}));

describe("connectApnsHttp2Session", () => {
  beforeEach(() => {
    connectSpy.mockClear();
    tunnelSpy.mockClear();
    _resetActiveManagedProxyStateForTests();
  });
  it("uses direct http2.connect when managed proxy is inactive", async () => {
    const { connectApnsHttp2Session } = await import("./push-apns-http2.js");

    const session = await connectApnsHttp2Session({
      authority: "https://api.sandbox.push.apple.com",
      timeoutMs: 10_000,
    });

    expect(session).toBe(fakeSession);
    expect(tunnelSpy).not.toHaveBeenCalled();
    expect(connectSpy).toHaveBeenCalledWith("https://api.sandbox.push.apple.com");
  });

  it("uses an HTTP CONNECT tunnel when managed proxy is active", async () => {
    const registration = registerActiveManagedProxyUrl("http://proxy.example:8080");
    const { connectApnsHttp2Session } = await import("./push-apns-http2.js");

    const session = await connectApnsHttp2Session({
      authority: "https://api.push.apple.com",
      timeoutMs: 10_000,
    });
    stopActiveManagedProxyRegistration(registration);

    expect(session).toBe(fakeSession);
    expect(tunnelSpy).toHaveBeenCalledWith({
      proxyUrl: "http://proxy.example:8080",
      targetHost: "api.push.apple.com",
      targetPort: 443,
      timeoutMs: 10_000,
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

  it("ignores ambient proxy env when managed proxy is inactive", async () => {
    const originalHttpsProxy = process.env["HTTPS_PROXY"];
    process.env["HTTPS_PROXY"] = "http://ambient.example:8080";
    try {
      const { connectApnsHttp2Session } = await import("./push-apns-http2.js");

      const session = await connectApnsHttp2Session({
        authority: "https://api.push.apple.com",
        timeoutMs: 10_000,
      });

      expect(session).toBe(fakeSession);
      expect(tunnelSpy).not.toHaveBeenCalled();
    } finally {
      if (originalHttpsProxy === undefined) {
        delete process.env["HTTPS_PROXY"];
      } else {
        process.env["HTTPS_PROXY"] = originalHttpsProxy;
      }
    }
  });

  it("rejects non-APNs authorities", async () => {
    const { connectApnsHttp2Session } = await import("./push-apns-http2.js");

    await expect(
      connectApnsHttp2Session({
        authority: "https://example.com",
        timeoutMs: 10_000,
      }),
    ).rejects.toThrow("Unsupported APNs authority");
  });
});
