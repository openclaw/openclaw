import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

class FakeSocket extends EventEmitter {
  public readonly writes: string[] = [];
  public readonly unshifted: Buffer[] = [];
  public destroyed = false;

  constructor(private readonly response: string) {
    super();
  }

  write(data: string): void {
    this.writes.push(data);
    queueMicrotask(() => this.emit("data", Buffer.from(this.response, "latin1")));
  }

  destroy(): void {
    this.destroyed = true;
  }

  unshift(data: Buffer): void {
    this.unshifted.push(data);
  }
}

const { connectSpy, nextSocket } = vi.hoisted(() => {
  let nextSocket: FakeSocket | undefined;
  return {
    connectSpy: vi.fn(() => {
      if (!nextSocket) {
        throw new Error("nextSocket not set");
      }
      const socket = nextSocket;
      queueMicrotask(() => socket.emit("connect"));
      return socket;
    }),
    nextSocket: (socket: FakeSocket) => {
      nextSocket = socket;
    },
  };
});

vi.mock("node:net", () => ({
  connect: connectSpy,
}));

describe("openHttpConnectTunnel", () => {
  it("opens an HTTP CONNECT tunnel through the configured proxy", async () => {
    const socket = new FakeSocket("HTTP/1.1 200 Connection Established\r\n\r\n");
    nextSocket(socket);

    const { openHttpConnectTunnel } = await import("./http-connect-tunnel.js");

    const result = await openHttpConnectTunnel({
      proxyUrl: "http://proxy.example:8080",
      targetHost: "api.push.apple.com",
      targetPort: 443,
    });

    expect(result).toBe(socket);
    expect(connectSpy).toHaveBeenCalledWith({ host: "proxy.example", port: 8080 });
    expect(socket.writes[0]).toBe(
      [
        "CONNECT api.push.apple.com:443 HTTP/1.1",
        "Host: api.push.apple.com:443",
        "Proxy-Connection: Keep-Alive",
        "",
        "",
      ].join("\r\n"),
    );
  });

  it("sends basic proxy authorization for proxy URLs with credentials", async () => {
    const socket = new FakeSocket("HTTP/1.1 200 Connection Established\r\n\r\n");
    nextSocket(socket);

    const { openHttpConnectTunnel } = await import("./http-connect-tunnel.js");

    await openHttpConnectTunnel({
      proxyUrl: "http://user:pass@proxy.example:8080",
      targetHost: "api.push.apple.com",
      targetPort: 443,
    });

    expect(socket.writes[0]).toContain(
      `Proxy-Authorization: Basic ${Buffer.from("user:pass").toString("base64")}`,
    );
  });

  it("destroys the socket and redacts credentials when CONNECT fails", async () => {
    const socket = new FakeSocket("HTTP/1.1 407 Proxy Authentication Required\r\n\r\n");
    nextSocket(socket);

    const { openHttpConnectTunnel } = await import("./http-connect-tunnel.js");

    await expect(
      openHttpConnectTunnel({
        proxyUrl: "http://user:secret@proxy.example:8080",
        targetHost: "api.push.apple.com",
        targetPort: 443,
      }),
    ).rejects.toThrow("Proxy CONNECT failed via http://proxy.example:8080: HTTP/1.1 407");
    expect(socket.destroyed).toBe(true);
  });
});
