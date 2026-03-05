import { describe, expect, it } from "vitest";
import { checkBrowserOrigin } from "./origin-check.js";

describe("checkBrowserOrigin", () => {
  it("accepts same-origin host matches only with legacy host-header fallback for local clients", () => {
    const result = checkBrowserOrigin({
      requestHost: "127.0.0.1:18789",
      origin: "http://127.0.0.1:18789",
      allowHostHeaderOriginFallback: true,
      isLocalClient: true,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.matchedBy).toBe("host-header-fallback");
    }
  });

  it("rejects same-origin host matches when legacy host-header fallback is disabled", () => {
    const result = checkBrowserOrigin({
      requestHost: "gateway.example.com:18789",
      origin: "https://gateway.example.com:18789",
    });
    expect(result.ok).toBe(false);
  });

  it("accepts loopback host mismatches for dev", () => {
    const result = checkBrowserOrigin({
      requestHost: "127.0.0.1:18789",
      origin: "http://localhost:5173",
      isLocalClient: true,
    });
    expect(result.ok).toBe(true);
  });

  it("rejects loopback origin mismatches when request is not local", () => {
    const result = checkBrowserOrigin({
      requestHost: "127.0.0.1:18789",
      origin: "http://localhost:5173",
      isLocalClient: false,
    });
    expect(result.ok).toBe(false);
  });

  it("accepts allowlisted origins", () => {
    const result = checkBrowserOrigin({
      requestHost: "gateway.example.com:18789",
      origin: "https://control.example.com",
      allowedOrigins: ["https://control.example.com"],
    });
    expect(result.ok).toBe(true);
  });

  it("accepts wildcard allowedOrigins for local clients only", () => {
    const result = checkBrowserOrigin({
      requestHost: "gateway.example.com:18789",
      origin: "https://any-origin.example.com",
      allowedOrigins: ["*"],
      isLocalClient: true,
    });
    expect(result.ok).toBe(true);
  });

  it("rejects wildcard allowedOrigins for remote clients (security)", () => {
    const result = checkBrowserOrigin({
      requestHost: "gateway.example.com:18789",
      origin: "https://any-origin.example.com",
      allowedOrigins: ["*"],
      isLocalClient: false,
    });
    expect(result.ok).toBe(false);
  });

  it("rejects missing origin", () => {
    const result = checkBrowserOrigin({
      requestHost: "gateway.example.com:18789",
      origin: "",
    });
    expect(result.ok).toBe(false);
  });

  it("rejects mismatched origins", () => {
    const result = checkBrowserOrigin({
      requestHost: "gateway.example.com:18789",
      origin: "https://attacker.example.com",
    });
    expect(result.ok).toBe(false);
  });

  it('accepts any origin when allowedOrigins includes "*" for local clients only (regression: #30990)', () => {
    const result = checkBrowserOrigin({
      requestHost: "100.86.79.37:18789",
      origin: "https://100.86.79.37:18789",
      allowedOrigins: ["*"],
      isLocalClient: true,
    });
    expect(result.ok).toBe(true);
  });

  it('accepts any origin when allowedOrigins includes "*" alongside specific entries for local clients', () => {
    const result = checkBrowserOrigin({
      requestHost: "gateway.tailnet.ts.net:18789",
      origin: "https://gateway.tailnet.ts.net:18789",
      allowedOrigins: ["https://control.example.com", "*"],
      isLocalClient: true,
    });
    expect(result.ok).toBe(true);
  });

  it("accepts wildcard entries with surrounding whitespace for local clients", () => {
    const result = checkBrowserOrigin({
      requestHost: "100.86.79.37:18789",
      origin: "https://100.86.79.37:18789",
      allowedOrigins: [" * "],
      isLocalClient: true,
    });
    expect(result.ok).toBe(true);
  });
});
