import { describe, expect, it } from "vitest";
import { resolveCanvasHostUrl } from "./canvas-host-url.js";

describe("resolveCanvasHostUrl", () => {
  // Regression test: When connecting via reverse proxy (e.g., Tailscale Serve 443 → 18789),
  // the gateway must use the port from the Host header (443), not the internal canvasPort (18789).
  // Otherwise, mobile apps fail to load A2UI because the internal port isn't externally accessible.
  it("uses port from Host header when present (Tailscale Serve case)", () => {
    const result = resolveCanvasHostUrl({
      canvasPort: 18789,
      requestHost: "node.tailnet:443",
      forwardedProto: "https",
    });
    expect(result).toBe("https://node.tailnet:443");
  });

  it("falls back to canvasPort when Host header has no port", () => {
    const result = resolveCanvasHostUrl({
      canvasPort: 18789,
      requestHost: "node.tailnet",
      forwardedProto: "https",
    });
    expect(result).toBe("https://node.tailnet:18789");
  });

  it("handles direct connection with explicit port", () => {
    const result = resolveCanvasHostUrl({
      canvasPort: 18789,
      requestHost: "192.168.1.100:18789",
    });
    expect(result).toBe("http://192.168.1.100:18789");
  });

  it("handles IPv6 with port", () => {
    // Use documentation-reserved IPv6 address (not loopback)
    const result = resolveCanvasHostUrl({
      canvasPort: 18789,
      requestHost: "[2001:db8::1]:8080",
    });
    expect(result).toBe("http://[2001:db8::1]:8080");
  });

  it("handles default HTTPS port 443 explicitly specified", () => {
    const result = resolveCanvasHostUrl({
      canvasPort: 18789,
      requestHost: "node.tailnet:443",
      forwardedProto: "https",
    });
    expect(result).toBe("https://node.tailnet:443");
  });

  it("handles default HTTP port 80 explicitly specified", () => {
    const result = resolveCanvasHostUrl({
      canvasPort: 18789,
      requestHost: "example.com:80",
    });
    expect(result).toBe("http://example.com:80");
  });

  it("returns undefined when no canvasPort and no Host port", () => {
    const result = resolveCanvasHostUrl({
      requestHost: "node.tailnet",
    });
    expect(result).toBeUndefined();
  });

  it("returns undefined when no host available", () => {
    const result = resolveCanvasHostUrl({
      canvasPort: 18789,
    });
    expect(result).toBeUndefined();
  });

  it("uses localAddress when requestHost is not available", () => {
    const result = resolveCanvasHostUrl({
      canvasPort: 18789,
      localAddress: "192.168.1.50",
    });
    expect(result).toBe("http://192.168.1.50:18789");
  });

  it("prefers hostOverride over requestHost (no port in override)", () => {
    const result = resolveCanvasHostUrl({
      canvasPort: 18789,
      hostOverride: "custom.host.com",
      requestHost: "node.tailnet:443",
    });
    // hostOverride takes precedence for hostname; port falls back to Host header
    expect(result).toBe("http://custom.host.com:443");
  });

  it("uses port from hostOverride when specified", () => {
    const result = resolveCanvasHostUrl({
      canvasPort: 18789,
      hostOverride: "custom.host.com:8080",
      requestHost: "node.tailnet:443",
    });
    // Port priority: overridePort → hostHeaderPort → canvasPort
    expect(result).toBe("http://custom.host.com:8080");
  });

  it("falls back to canvasPort when hostOverride has no port and no Host header", () => {
    const result = resolveCanvasHostUrl({
      canvasPort: 18789,
      hostOverride: "custom.host.com",
    });
    expect(result).toBe("http://custom.host.com:18789");
  });

  it("rejects out-of-range port (above 65535)", () => {
    const result = resolveCanvasHostUrl({
      canvasPort: 18789,
      requestHost: "example.com:99999",
    });
    // Falls back to canvasPort since 99999 is invalid
    expect(result).toBe("http://example.com:18789");
  });

  it("rejects port 0", () => {
    const result = resolveCanvasHostUrl({
      canvasPort: 18789,
      requestHost: "example.com:0",
    });
    // Falls back to canvasPort since 0 is invalid
    expect(result).toBe("http://example.com:18789");
  });

  it("rejects port 65536 (just above max)", () => {
    const result = resolveCanvasHostUrl({
      canvasPort: 18789,
      requestHost: "example.com:65536",
    });
    // Falls back to canvasPort since 65536 is invalid
    expect(result).toBe("http://example.com:18789");
  });

  it("accepts port 65535 (max valid)", () => {
    const result = resolveCanvasHostUrl({
      canvasPort: 18789,
      requestHost: "example.com:65535",
    });
    expect(result).toBe("http://example.com:65535");
  });

  it("accepts port 1 (min valid)", () => {
    const result = resolveCanvasHostUrl({
      canvasPort: 18789,
      requestHost: "example.com:1",
    });
    expect(result).toBe("http://example.com:1");
  });

  it("rejects invalid port in hostOverride", () => {
    const result = resolveCanvasHostUrl({
      canvasPort: 18789,
      hostOverride: "custom.host.com:99999",
      requestHost: "node.tailnet:443",
    });
    // Invalid override port falls back to Host header port
    expect(result).toBe("http://custom.host.com:443");
  });

  it("hostOverride port takes precedence over all other ports", () => {
    const result = resolveCanvasHostUrl({
      canvasPort: 18789,
      hostOverride: "custom.host.com:9000",
      requestHost: "node.tailnet:443",
    });
    // Override port (9000) wins over Host header port (443) and canvasPort (18789)
    expect(result).toBe("http://custom.host.com:9000");
  });

  it("handles invalid Host header gracefully", () => {
    const result = resolveCanvasHostUrl({
      canvasPort: 18789,
      requestHost: "not a valid host!!!",
      localAddress: "192.168.1.50",
    });
    // Falls back to localAddress and canvasPort
    expect(result).toBe("http://192.168.1.50:18789");
  });
});
