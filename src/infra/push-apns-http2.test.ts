import type http2 from "node:http2";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetActiveManagedProxyStateForTests,
  registerActiveManagedProxyUrl,
  stopActiveManagedProxyRegistration,
} from "./net/proxy/active-proxy-state.js";

const { connectSpy, tunnelSpy, fakeRequest, fakeSession, fakeTlsSocket } = vi.hoisted(() => {
  class FakeEmitter {
    private readonly handlers = new Map<string, Array<(...args: unknown[]) => void>>();

    on(event: string, handler: (...args: unknown[]) => void): this {
      this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
      return this;
    }

    once(event: string, handler: (...args: unknown[]) => void): this {
      const wrapped = (...args: unknown[]) => {
        this.off(event, wrapped);
        handler(...args);
      };
      return this.on(event, wrapped);
    }

    off(event: string, handler: (...args: unknown[]) => void): this {
      this.handlers.set(
        event,
        (this.handlers.get(event) ?? []).filter((candidate) => candidate !== handler),
      );
      return this;
    }

    emit(event: string, ...args: unknown[]): void {
      for (const handler of this.handlers.get(event) ?? []) {
        handler(...args);
      }
    }

    reset(): void {
      this.handlers.clear();
    }
  }

  const fakeRequest = Object.assign(new FakeEmitter(), {
    setEncoding: vi.fn(),
    end: vi.fn(() => {
      queueMicrotask(() => {
        fakeRequest.emit("response", { ":status": 403 });
        fakeRequest.emit("data", '{"reason":"InvalidProviderToken"}');
        fakeRequest.emit("end");
      });
    }),
  });
  const fakeSession = Object.assign(new FakeEmitter(), {
    closed: false,
    destroyed: false,
    close: vi.fn(() => {
      fakeSession.closed = true;
    }),
    destroy: vi.fn(() => {
      fakeSession.destroyed = true;
    }),
    request: vi.fn(() => fakeRequest),
  });
  const fakeTlsSocket = { encrypted: true };
  return {
    fakeRequest,
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
    fakeRequest.reset();
    fakeRequest.setEncoding.mockClear();
    fakeRequest.end.mockClear();
    fakeSession.reset();
    fakeSession.closed = false;
    fakeSession.destroyed = false;
    fakeSession.close.mockClear();
    fakeSession.destroy.mockClear();
    fakeSession.request.mockClear();
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

  it("probes APNs reachability through an explicit proxy", async () => {
    const { probeApnsHttp2ReachabilityViaProxy } = await import("./push-apns-http2.js");

    const result = await probeApnsHttp2ReachabilityViaProxy({
      authority: "https://api.sandbox.push.apple.com",
      proxyUrl: "http://proxy.example:8080",
      timeoutMs: 10_000,
    });

    expect(result).toEqual({ status: 403, body: '{"reason":"InvalidProviderToken"}' });
    expect(tunnelSpy).toHaveBeenCalledWith({
      proxyUrl: "http://proxy.example:8080",
      targetHost: "api.sandbox.push.apple.com",
      targetPort: 443,
      timeoutMs: 10_000,
    });
    expect(fakeSession.request).toHaveBeenCalledWith({
      ":method": "POST",
      ":path": `/3/device/${"0".repeat(64)}`,
      authorization: "bearer intentionally.invalid.openclaw.proxy.validation",
      "apns-topic": "ai.openclaw.ios",
      "apns-push-type": "alert",
      "apns-priority": "10",
    });
    expect(fakeSession.close).toHaveBeenCalledOnce();
  });

  it("rejects non-APNs authorities", async () => {
    const { connectApnsHttp2Session, probeApnsHttp2ReachabilityViaProxy } =
      await import("./push-apns-http2.js");

    await expect(
      connectApnsHttp2Session({
        authority: "https://example.com",
        timeoutMs: 10_000,
      }),
    ).rejects.toThrow("Unsupported APNs authority");
    await expect(
      probeApnsHttp2ReachabilityViaProxy({
        authority: "https://example.com",
        proxyUrl: "http://proxy.example:8080",
        timeoutMs: 10_000,
      }),
    ).rejects.toThrow("Unsupported APNs authority");
  });
});
