import { describe, expect, it, vi } from "vitest";

const { connectSpy, agentConstructorSpy, fakeSocket } = vi.hoisted(() => {
  const fakeSocket = { destroyed: false, writable: true };
  const connectSpy = vi.fn(async () => fakeSocket);
  return {
    fakeSocket,
    connectSpy,
    agentConstructorSpy: vi.fn(function HttpsProxyAgent(this: { connect: typeof connectSpy }) {
      this.connect = connectSpy;
    }),
  };
});

vi.mock("https-proxy-agent", () => ({
  HttpsProxyAgent: agentConstructorSpy,
}));

describe("openHttpConnectTunnel", () => {
  it("delegates CONNECT tunneling to https-proxy-agent with APNs TLS options", async () => {
    const { openHttpConnectTunnel } = await import("./http-connect-tunnel.js");

    const result = await openHttpConnectTunnel({
      proxyUrl: "http://proxy.example:8080",
      targetHost: "api.push.apple.com",
      targetPort: 443,
      timeoutMs: 10_000,
    });

    expect(result).toBe(fakeSocket);
    expect(agentConstructorSpy).toHaveBeenCalledWith("http://proxy.example:8080", {
      keepAlive: true,
    });
    expect(connectSpy).toHaveBeenCalledWith(expect.any(Object), {
      host: "api.push.apple.com",
      port: 443,
      secureEndpoint: true,
      servername: "api.push.apple.com",
      ALPNProtocols: ["h2"],
    });
  });

  it("supports https proxy URLs through https-proxy-agent", async () => {
    const { openHttpConnectTunnel } = await import("./http-connect-tunnel.js");

    await openHttpConnectTunnel({
      proxyUrl: "https://proxy.example:8443",
      targetHost: "api.sandbox.push.apple.com",
      targetPort: 443,
    });

    expect(agentConstructorSpy).toHaveBeenCalledWith("https://proxy.example:8443", {
      keepAlive: true,
    });
  });

  it("redacts proxy credentials in dependency failures", async () => {
    connectSpy.mockRejectedValueOnce(new Error("407 Proxy Authentication Required"));
    const { openHttpConnectTunnel } = await import("./http-connect-tunnel.js");

    await expect(
      openHttpConnectTunnel({
        proxyUrl: "http://user:secret@proxy.example:8080",
        targetHost: "api.push.apple.com",
        targetPort: 443,
      }),
    ).rejects.toThrow(
      "Proxy CONNECT failed via http://proxy.example:8080: 407 Proxy Authentication Required",
    );
  });
});
