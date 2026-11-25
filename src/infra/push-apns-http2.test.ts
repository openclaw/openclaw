import type http2 from "node:http2";
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  registerActiveManagedProxyUrl,
  stopActiveManagedProxyRegistration,
} from "./net/proxy/active-proxy-state.js";
import { connectApnsHttp2Session, probeApnsHttp2ReachabilityViaProxy } from "./push-apns-http2.js";

type ProxyConnectTunnelParams = Parameters<
  typeof import("@openclaw/proxyline").openProxyConnectTunnel
>[0];

const {
  connectSpy,
  tunnelSpy,
  tlsConnectSpy,
  setTargetTlsEvent,
  fakeProxySocket,
  fakeRequest,
  fakeSession,
  fakeTlsSocket,
} = await vi.hoisted(async () => {
  const { EventEmitter } = await import("node:events");

  const fakeRequestLocal = Object.assign(new EventEmitter(), {
    setEncoding: vi.fn(),
    end: vi.fn(() => {
      queueMicrotask(() => {
        const responseBody = Buffer.from(
          '{"reason":"InvalidProviderToken","detail":"split 🚀 response"}',
        );
        const emojiOffset = responseBody.indexOf(Buffer.from("🚀"));
        fakeRequestLocal.emit("response", { ":status": 403 });
        fakeRequestLocal.emit("data", responseBody.subarray(0, emojiOffset + 2));
        fakeRequestLocal.emit("data", responseBody.subarray(emojiOffset + 2));
        fakeRequestLocal.emit("end");
      });
    }),
  });
  const fakeSessionLocal = Object.assign(new EventEmitter(), {
    closed: false,
    destroyed: false,
    close: vi.fn(() => {
      fakeSessionLocal.closed = true;
    }),
    destroy: vi.fn(() => {
      fakeSessionLocal.destroyed = true;
    }),
    request: vi.fn(() => fakeRequestLocal),
  });
  const fakeProxySocketLocal = { destroy: vi.fn() };
  const fakeTlsSocketLocal = Object.assign(new EventEmitter(), {
    alpnProtocol: "h2" as string | false,
    destroy: vi.fn(),
  });
  let targetTlsEvent: "secureConnect" | undefined = "secureConnect";
  return {
    fakeProxySocket: fakeProxySocketLocal,
    fakeRequest: fakeRequestLocal,
    fakeSession: fakeSessionLocal,
    fakeTlsSocket: fakeTlsSocketLocal,
    connectSpy: vi.fn(
      (_authority: string, _options?: http2.ClientSessionOptions) => fakeSessionLocal,
    ),
    tunnelSpy: vi.fn(async (_params: ProxyConnectTunnelParams) => fakeProxySocketLocal),
    tlsConnectSpy: vi.fn(() => {
      const event = targetTlsEvent;
      if (event) {
        queueMicrotask(() => {
          fakeTlsSocketLocal.emit(event);
        });
      }
      return fakeTlsSocketLocal;
    }),
    setTargetTlsEvent: (event: typeof targetTlsEvent) => {
      targetTlsEvent = event;
    },
  };
});

vi.mock("node:http2", () => ({
  default: { connect: connectSpy, constants: { NGHTTP2_CANCEL: 8 } },
  connect: connectSpy,
  constants: { NGHTTP2_CANCEL: 8 },
}));

vi.mock("node:tls", () => ({
  default: { connect: tlsConnectSpy },
  connect: tlsConnectSpy,
}));

vi.mock("@openclaw/proxyline", () => ({
  openProxyConnectTunnel: tunnelSpy,
}));

function connect(overrides: Partial<Parameters<typeof connectApnsHttp2Session>[0]> = {}) {
  return connectApnsHttp2Session({
    authority: "https://api.push.apple.com",
    timeoutMs: 10_000,
    ...overrides,
  });
}

function probe(overrides: Partial<Parameters<typeof probeApnsHttp2ReachabilityViaProxy>[0]> = {}) {
  return probeApnsHttp2ReachabilityViaProxy({
    authority: "https://api.sandbox.push.apple.com",
    proxyUrl: "http://proxy.example:8080",
    timeoutMs: 10_000,
    ...overrides,
  });
}

function expectTunnelDestroyed() {
  expect(fakeTlsSocket.destroy).toHaveBeenCalledOnce();
  expect(fakeProxySocket.destroy).toHaveBeenCalledOnce();
}

describe("connectApnsHttp2Session", () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    setTargetTlsEvent("secureConnect");
    fakeRequest.removeAllListeners();
    fakeSession.removeAllListeners();
    fakeSession.closed = false;
    fakeSession.destroyed = false;
    fakeTlsSocket.removeAllListeners();
    fakeTlsSocket.alpnProtocol = "h2";
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("rejects an already invalidated direct APNs setup before opening a session", async () => {
    const controller = new AbortController();
    controller.abort(new Error("pairing removed"));

    await expect(
      connect({ authority: "https://api.sandbox.push.apple.com", signal: controller.signal }),
    ).rejects.toThrow("pairing removed");

    expect(connectSpy).not.toHaveBeenCalled();
  });

  it("rejects APNs authorities with non-origin URL components", async () => {
    await expect(connect({ authority: "https://token@api.push.apple.com" })).rejects.toThrow(
      "Unsupported APNs authority",
    );
    await expect(
      probe({ authority: "https://api.sandbox.push.apple.com/3/device/abc" }),
    ).rejects.toThrow("Unsupported APNs authority");
  });

  it.each([
    [10_000, 10_000],
    [Number.MAX_SAFE_INTEGER, MAX_TIMER_TIMEOUT_MS],
  ])("uses an HTTP CONNECT tunnel with managed timeout %s", async (timeoutMs, expectedTimeout) => {
    const registration = registerActiveManagedProxyUrl(
      new URL("https://user:pass@proxy.example:8443"),
      {
        loopbackMode: "gateway-only",
        proxyTls: { ca: "active-proxy-ca" },
      },
    );

    const controller = new AbortController();
    const session = await connect({ signal: controller.signal, timeoutMs });
    stopActiveManagedProxyRegistration(registration);

    expect(session).toBe(fakeSession);
    const tunnelCall = tunnelSpy.mock.lastCall?.[0];
    expect(tunnelCall).toMatchObject({
      targetHost: "api.push.apple.com",
      targetPort: 443,
      timeoutMs: expectedTimeout,
      proxyTls: { ca: "active-proxy-ca" },
      signal: controller.signal,
    });
    expect(String(tunnelCall?.proxyUrl)).toBe("https://user:pass@proxy.example:8443/");
    expect(tlsConnectSpy).toHaveBeenCalledWith({
      socket: fakeProxySocket,
      servername: "api.push.apple.com",
      ALPNProtocols: ["h2"],
    });
    expect(connectSpy).toHaveBeenCalledTimes(1);
    const [authority, options] = connectSpy.mock.lastCall ?? [];
    expect(authority).toBe("https://api.push.apple.com");
    expect(options?.createConnection?.(new URL("https://api.push.apple.com"), {})).toBe(
      fakeTlsSocket,
    );
  });

  it("rejects a non-h2 target tunnel without exposing proxy URL details", async () => {
    fakeTlsSocket.alpnProtocol = "http/1.1";

    const result = probe({ proxyUrl: "http://proxy.example:8080/private?detail=opaque#fragment" });

    await expect(result).rejects.toThrow(
      "Proxy CONNECT failed via http://proxy.example:8080: APNs TLS tunnel negotiated http/1.1 instead of h2",
    );
    const proxyUrl = tunnelSpy.mock.lastCall?.[0].proxyUrl;
    expect(proxyUrl).toBeInstanceOf(URL);
    expect(proxyUrl).toMatchObject({ pathname: "/", search: "", hash: "" });
    expect(String(await result.catch((error: unknown) => error))).not.toMatch(
      /private|opaque|fragment/,
    );
    expectTunnelDestroyed();
  });

  it("times out the target TLS handshake within the CONNECT deadline", async () => {
    const registration = registerActiveManagedProxyUrl(new URL("http://proxy.example:8080"), {
      loopbackMode: "gateway-only",
    });
    vi.useFakeTimers();
    setTargetTlsEvent(undefined);

    const result = connect({ timeoutMs: 1000 });
    const rejection = expect(result).rejects.toThrow(
      "Proxy CONNECT failed via http://proxy.example:8080: Proxy CONNECT timed out after 1000ms",
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(tlsConnectSpy).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1000);
    await rejection;
    stopActiveManagedProxyRegistration(registration);
    expectTunnelDestroyed();
  });

  it("rejects malformed proxy auth before opening the native tunnel", async () => {
    await expect(probe({ proxyUrl: "http://%E0%A4%A@proxy.example:8080" })).rejects.toThrow(
      "Proxy CONNECT failed via http://proxy.example:8080: URI malformed",
    );
    expect(tunnelSpy).not.toHaveBeenCalled();
  });

  it("ignores ambient proxy env when managed proxy is inactive", async () => {
    vi.stubEnv("HTTPS_PROXY", "http://ambient.example:8080");
    const session = await connect({ authority: "https://api.push.apple.com:443" });
    expect(session).toBe(fakeSession);
    expect(connectSpy).toHaveBeenCalledWith("https://api.push.apple.com");
    expect(tunnelSpy).not.toHaveBeenCalled();
  });

  it.each([
    [10_000, 10_000],
    [Number.MAX_SAFE_INTEGER, MAX_TIMER_TIMEOUT_MS],
  ])(
    "probes APNs reachability with explicit proxy timeout %s",
    async (timeoutMs, expectedTimeout) => {
      const result = await probe({ proxyTls: { ca: "probe-proxy-ca" }, timeoutMs });

      expect(result).toEqual({
        status: 403,
        body: '{"reason":"InvalidProviderToken","detail":"split 🚀 response"}',
        responseHeaders: {},
      });
      expect(fakeRequest.setEncoding).not.toHaveBeenCalled();
      const tunnelCall = tunnelSpy.mock.lastCall?.[0];
      expect(tunnelCall?.proxyUrl).toBeInstanceOf(URL);
      expect(tunnelCall?.proxyUrl).toMatchObject({ href: "http://proxy.example:8080/" });
      expect(tunnelCall).toMatchObject({
        targetHost: "api.sandbox.push.apple.com",
        targetPort: 443,
        timeoutMs: expectedTimeout,
      });
      expect(tunnelCall?.proxyTls).toEqual({ ca: "probe-proxy-ca" });
      expect(fakeSession.request).toHaveBeenCalledWith({
        ":method": "POST",
        ":path": `/3/device/${"0".repeat(64)}`,
        authorization: "bearer intentionally.invalid.openclaw.proxy.validation",
        "apns-topic": "ai.openclaw.ios",
        "apns-push-type": "alert",
        "apns-priority": "10",
      });
      expect(fakeSession.close).toHaveBeenCalledOnce();
    },
  );

  it("rejects non-APNs authorities", async () => {
    await expect(connect({ authority: "https://example.com" })).rejects.toThrow(
      "Unsupported APNs authority",
    );
    await expect(probe({ authority: "https://example.com" })).rejects.toThrow(
      "Unsupported APNs authority",
    );
  });
});
