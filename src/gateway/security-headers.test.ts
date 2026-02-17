import { describe, expect, it } from "vitest";
import { applySecurityHeaders } from "./security-headers.js";

function createMockResponse() {
  const headers = new Map<string, string>();
  return {
    setHeader(name: string, value: string) {
      headers.set(name.toLowerCase(), value);
    },
    getHeader(name: string) {
      return headers.get(name.toLowerCase());
    },
    headers,
  };
}

describe("security-headers", () => {
  it("sets X-Content-Type-Options on all responses", () => {
    const res = createMockResponse();
    applySecurityHeaders(res as never, "/");
    expect(res.getHeader("x-content-type-options")).toBe("nosniff");
  });

  it("sets X-Frame-Options DENY on all responses", () => {
    const res = createMockResponse();
    applySecurityHeaders(res as never, "/");
    expect(res.getHeader("x-frame-options")).toBe("DENY");
  });

  it("sets Referrer-Policy on all responses", () => {
    const res = createMockResponse();
    applySecurityHeaders(res as never, "/");
    expect(res.getHeader("referrer-policy")).toBe("strict-origin-when-cross-origin");
  });

  it("sets HSTS when TLS is enabled", () => {
    const res = createMockResponse();
    applySecurityHeaders(res as never, "/", { tlsEnabled: true });
    expect(res.getHeader("strict-transport-security")).toBe("max-age=31536000; includeSubDomains");
  });

  it("does not set HSTS when TLS is disabled", () => {
    const res = createMockResponse();
    applySecurityHeaders(res as never, "/", { tlsEnabled: false });
    expect(res.getHeader("strict-transport-security")).toBeUndefined();
  });

  it("does not set HSTS when config is omitted", () => {
    const res = createMockResponse();
    applySecurityHeaders(res as never, "/");
    expect(res.getHeader("strict-transport-security")).toBeUndefined();
  });

  it("sets Cache-Control no-store on /api/ paths", () => {
    const res = createMockResponse();
    applySecurityHeaders(res as never, "/api/sessions");
    expect(res.getHeader("cache-control")).toBe("no-store, no-cache, must-revalidate");
    expect(res.getHeader("pragma")).toBe("no-cache");
  });

  it("sets Cache-Control no-store on /hooks/ paths", () => {
    const res = createMockResponse();
    applySecurityHeaders(res as never, "/hooks/gmail");
    expect(res.getHeader("cache-control")).toBe("no-store, no-cache, must-revalidate");
  });

  it("sets Cache-Control no-store on /v1/ paths", () => {
    const res = createMockResponse();
    applySecurityHeaders(res as never, "/v1/chat/completions");
    expect(res.getHeader("cache-control")).toBe("no-store, no-cache, must-revalidate");
  });

  it("does not set Cache-Control no-store on static paths", () => {
    const res = createMockResponse();
    applySecurityHeaders(res as never, "/control-ui/index.html");
    expect(res.getHeader("cache-control")).toBeUndefined();
  });
});
