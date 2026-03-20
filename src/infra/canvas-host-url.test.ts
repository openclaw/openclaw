import { describe, expect, it } from "vitest";
import { resolveCanvasHostUrl } from "./canvas-host-url.js";

describe("resolveCanvasHostUrl", () => {
  it("returns undefined when no canvas port or usable host is available", () => {
    expect(resolveCanvasHostUrl({})).toBeUndefined();
    expect(resolveCanvasHostUrl({ canvasPort: 3000, hostOverride: "127.0.0.1" })).toBeUndefined();
  });

  it("prefers non-loopback host overrides and preserves explicit ports", () => {
    expect(
      resolveCanvasHostUrl({
        canvasPort: 3000,
        hostOverride: " canvas.openclaw.ai ",
        requestHost: "gateway.local:9000",
        localAddress: "192.168.1.10",
      }),
    ).toBe("http://canvas.openclaw.ai:3000");
  });

  it("falls back from rejected loopback overrides to request hosts", () => {
    expect(
      resolveCanvasHostUrl({
        canvasPort: 3000,
        hostOverride: "127.0.0.1",
        requestHost: "example.com:8443",
      }),
    ).toBe("http://example.com:3000");
  });

  it("maps proxied default gateway ports to request-host ports or scheme defaults", () => {
    expect(
      resolveCanvasHostUrl({
        canvasPort: 18789,
        requestHost: "gateway.example.com:9443",
        forwardedProto: "https",
      }),
    ).toBe("https://gateway.example.com:9443");
    expect(
      resolveCanvasHostUrl({
        canvasPort: 18789,
        requestHost: "gateway.example.com",
        forwardedProto: ["https", "http"],
      }),
    ).toBe("https://gateway.example.com:443");
    expect(
      resolveCanvasHostUrl({
        canvasPort: 18789,
        requestHost: "gateway.example.com",
      }),
    ).toBe("http://gateway.example.com:80");
  });

  it("brackets ipv6 hosts and can fall back to local addresses", () => {
    expect(
      resolveCanvasHostUrl({
        canvasPort: 3000,
        requestHost: "not a host",
        localAddress: "2001:db8::1",
        scheme: "https",
      }),
    ).toBe("https://[2001:db8::1]:3000");
  });
});
