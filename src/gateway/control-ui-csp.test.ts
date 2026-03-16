import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import { buildControlUiCspHeader } from "./control-ui-csp.js";

function fakeReq(headers: Record<string, string>): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
}

describe("buildControlUiCspHeader", () => {
  it("blocks inline scripts while allowing inline styles", () => {
    const csp = buildControlUiCspHeader();
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain("script-src 'self' 'unsafe-inline'");
    expect(csp).toContain("style-src 'self' 'unsafe-inline' https://fonts.googleapis.com");
  });

  it("allows Google Fonts for style and font loading", () => {
    const csp = buildControlUiCspHeader();
    expect(csp).toContain("https://fonts.googleapis.com");
    expect(csp).toContain("font-src 'self' https://fonts.gstatic.com");
  });

  it("defaults to localhost when no request is provided", () => {
    const csp = buildControlUiCspHeader();
    expect(csp).toContain("ws://localhost:*");
    expect(csp).toContain("wss://localhost:*");
  });

  it("derives WebSocket host from Host header", () => {
    const csp = buildControlUiCspHeader(fakeReq({ host: "myserver.local:18789" }));
    expect(csp).toContain("ws://myserver.local:*");
    expect(csp).toContain("wss://myserver.local:*");
    expect(csp).not.toContain("localhost");
  });

  it("prefers X-Forwarded-Host over Host header", () => {
    const csp = buildControlUiCspHeader(
      fakeReq({ "x-forwarded-host": "gateway.example.com", host: "localhost:18789" }),
    );
    expect(csp).toContain("ws://gateway.example.com:*");
    expect(csp).toContain("wss://gateway.example.com:*");
    expect(csp).not.toContain("localhost");
  });

  it("handles X-Forwarded-Host with multiple entries (picks first)", () => {
    const csp = buildControlUiCspHeader(
      fakeReq({ "x-forwarded-host": "proxy.example.com, internal.local" }),
    );
    expect(csp).toContain("ws://proxy.example.com:*");
    expect(csp).toContain("wss://proxy.example.com:*");
  });

  it("handles IP address Host header", () => {
    const csp = buildControlUiCspHeader(fakeReq({ host: "192.168.1.100:18789" }));
    expect(csp).toContain("ws://192.168.1.100:*");
    expect(csp).toContain("wss://192.168.1.100:*");
  });

  it("handles IPv6 Host header", () => {
    const csp = buildControlUiCspHeader(fakeReq({ host: "[::1]:18789" }));
    expect(csp).toContain("ws://[::1]:*");
    expect(csp).toContain("wss://[::1]:*");
  });
});
