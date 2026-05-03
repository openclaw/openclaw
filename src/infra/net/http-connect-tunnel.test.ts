import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

class FakeSocket extends EventEmitter {
  public readonly writes: string[] = [];
  public readonly unshifted: Buffer[] = [];
  public destroyed = false;
  public writable = true;

  constructor(private readonly response?: string) {
    super();
  }

  write(data: string): void {
    this.writes.push(data);
    const response = this.response;
    if (response !== undefined) {
      queueMicrotask(() => this.emit("data", Buffer.from(response, "latin1")));
    }
  }

  destroy(): void {
    this.destroyed = true;
    this.writable = false;
    this.emit("close");
  }

  unshift(data: Buffer): void {
    this.unshifted.push(data);
  }
}

const {
  netConnectSpy,
  tlsConnectSpy,
  setNextNetSocket,
  setNextProxyTlsSocket,
  setNextTargetTlsSocket,
} = vi.hoisted(() => {
  let nextNetSocket: FakeSocket | undefined;
  let nextProxyTlsSocket: FakeSocket | undefined;
  let nextTargetTlsSocket: FakeSocket | undefined;

  return {
    setNextNetSocket: (socket: FakeSocket) => {
      nextNetSocket = socket;
    },
    setNextProxyTlsSocket: (socket: FakeSocket) => {
      nextProxyTlsSocket = socket;
    },
    setNextTargetTlsSocket: (socket: FakeSocket) => {
      nextTargetTlsSocket = socket;
    },
    netConnectSpy: vi.fn(() => {
      if (!nextNetSocket) {
        throw new Error("nextNetSocket not set");
      }
      const socket = nextNetSocket;
      queueMicrotask(() => socket.emit("connect"));
      return socket;
    }),
    tlsConnectSpy: vi.fn((options: { socket?: FakeSocket }) => {
      if (options.socket) {
        if (!nextTargetTlsSocket) {
          throw new Error("nextTargetTlsSocket not set");
        }
        return nextTargetTlsSocket;
      }
      if (!nextProxyTlsSocket) {
        throw new Error("nextProxyTlsSocket not set");
      }
      const socket = nextProxyTlsSocket;
      queueMicrotask(() => socket.emit("secureConnect"));
      return socket;
    }),
  };
});

vi.mock("node:net", () => ({
  connect: netConnectSpy,
}));

vi.mock("node:tls", () => ({
  connect: tlsConnectSpy,
}));

describe("openHttpConnectTunnel", () => {
  beforeEach(() => {
    vi.useRealTimers();
    netConnectSpy.mockClear();
    tlsConnectSpy.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("opens an HTTP CONNECT tunnel through the configured proxy", async () => {
    const proxySocket = new FakeSocket("HTTP/1.1 200 Connection Established\r\n\r\n");
    const targetTlsSocket = new FakeSocket();
    setNextNetSocket(proxySocket);
    setNextTargetTlsSocket(targetTlsSocket);
    const { openHttpConnectTunnel } = await import("./http-connect-tunnel.js");

    const result = await openHttpConnectTunnel({
      proxyUrl: "http://proxy.example:8080",
      targetHost: "api.push.apple.com",
      targetPort: 443,
      timeoutMs: 10_000,
    });

    expect(result).toBe(targetTlsSocket);
    expect(netConnectSpy).toHaveBeenCalledWith({ host: "proxy.example", port: 8080 });
    expect(proxySocket.writes[0]).toBe(
      [
        "CONNECT api.push.apple.com:443 HTTP/1.1",
        "Host: api.push.apple.com:443",
        "Proxy-Connection: Keep-Alive",
        "",
        "",
      ].join("\r\n"),
    );
    expect(tlsConnectSpy).toHaveBeenLastCalledWith({
      socket: proxySocket,
      servername: "api.push.apple.com",
      ALPNProtocols: ["h2"],
    });
  });

  it("supports HTTPS proxy URLs", async () => {
    const proxySocket = new FakeSocket("HTTP/1.1 200 Connection Established\r\n\r\n");
    const targetTlsSocket = new FakeSocket();
    setNextProxyTlsSocket(proxySocket);
    setNextTargetTlsSocket(targetTlsSocket);
    const { openHttpConnectTunnel } = await import("./http-connect-tunnel.js");

    await openHttpConnectTunnel({
      proxyUrl: "https://proxy.example:8443",
      targetHost: "api.sandbox.push.apple.com",
      targetPort: 443,
    });

    expect(tlsConnectSpy.mock.calls[0]?.[0]).toEqual({
      host: "proxy.example",
      port: 8443,
      servername: "proxy.example",
      ALPNProtocols: ["http/1.1"],
    });
    expect(tlsConnectSpy).toHaveBeenLastCalledWith({
      socket: proxySocket,
      servername: "api.sandbox.push.apple.com",
      ALPNProtocols: ["h2"],
    });
  });

  it("sends basic proxy authorization and redacts credentials when CONNECT fails", async () => {
    const proxySocket = new FakeSocket("HTTP/1.1 407 Proxy Authentication Required\r\n\r\n");
    setNextNetSocket(proxySocket);
    const { openHttpConnectTunnel } = await import("./http-connect-tunnel.js");

    await expect(
      openHttpConnectTunnel({
        proxyUrl: "http://user:secret@proxy.example:8080",
        targetHost: "api.push.apple.com",
        targetPort: 443,
      }),
    ).rejects.toThrow(
      "Proxy CONNECT failed via http://proxy.example:8080: HTTP/1.1 407 Proxy Authentication Required",
    );
    expect(proxySocket.writes[0]).toContain(
      `Proxy-Authorization: Basic ${Buffer.from("user:secret").toString("base64")}`,
    );
    expect(proxySocket.destroyed).toBe(true);
  });

  it("rejects and destroys the proxy socket when CONNECT times out", async () => {
    const proxySocket = new FakeSocket();
    setNextNetSocket(proxySocket);
    const { openHttpConnectTunnel } = await import("./http-connect-tunnel.js");

    await expect(
      openHttpConnectTunnel({
        proxyUrl: "http://proxy.example:8080",
        targetHost: "api.push.apple.com",
        targetPort: 443,
        timeoutMs: 1,
      }),
    ).rejects.toThrow(
      "Proxy CONNECT failed via http://proxy.example:8080: Proxy CONNECT timed out after 1ms",
    );
    expect(proxySocket.destroyed).toBe(true);
  });
});
