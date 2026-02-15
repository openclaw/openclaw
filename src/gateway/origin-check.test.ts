import { describe, expect, it } from "vitest";
import { checkBrowserOrigin } from "./origin-check.js";

describe("checkBrowserOrigin", () => {
  it("accepts same-origin host matches", () => {
    const result = checkBrowserOrigin({
      requestHost: "127.0.0.1:18789",
      origin: "http://127.0.0.1:18789",
    });
    expect(result.ok).toBe(true);
  });

  it("accepts same-origin with HTTPS", () => {
    const result = checkBrowserOrigin({
      requestHost: "localhost:8443",
      origin: "https://localhost:8443",
    });
    expect(result.ok).toBe(true);
  });

  it("accepts allowlisted origins", () => {
    const result = checkBrowserOrigin({
      requestHost: "gateway.example.com:18789",
      origin: "https://control.example.com",
      allowedOrigins: ["https://control.example.com"],
    });
    expect(result.ok).toBe(true);
  });

  it("accepts allowlisted local origins", () => {
    const result = checkBrowserOrigin({
      requestHost: "127.0.0.1:18789",
      origin: "http://localhost:5173",
      allowedOrigins: ["http://localhost:5173"],
    });
    expect(result.ok).toBe(true);
  });

  it("rejects loopback cross-origin without allowlist", () => {
    const result = checkBrowserOrigin({
      requestHost: "127.0.0.1:18789",
      origin: "http://localhost:5173",
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("allowedOrigins");
  });

  it("rejects different loopback ports without allowlist", () => {
    const result = checkBrowserOrigin({
      requestHost: "localhost:18789",
      origin: "http://localhost:3000",
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("allowedOrigins");
  });

  it("rejects localhost to 127.0.0.1 cross-origin without allowlist", () => {
    const result = checkBrowserOrigin({
      requestHost: "127.0.0.1:18789",
      origin: "http://localhost:8080",
    });
    expect(result.ok).toBe(false);
  });

  it("rejects missing origin", () => {
    const result = checkBrowserOrigin({
      requestHost: "gateway.example.com:18789",
      origin: "",
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("origin missing or invalid");
  });

  it("rejects mismatched origins", () => {
    const result = checkBrowserOrigin({
      requestHost: "gateway.example.com:18789",
      origin: "https://attacker.example.com",
    });
    expect(result.ok).toBe(false);
  });

  it("rejects null origin", () => {
    const result = checkBrowserOrigin({
      requestHost: "gateway.example.com:18789",
      origin: "null",
    });
    expect(result.ok).toBe(false);
  });

  it("handles case-insensitive host comparison", () => {
    const result = checkBrowserOrigin({
      requestHost: "LOCALHOST:8080",
      origin: "http://localhost:8080",
    });
    expect(result.ok).toBe(true);
  });

  it("handles IPv6 bracket notation", () => {
    const result = checkBrowserOrigin({
      requestHost: "[::1]:8080",
      origin: "http://[::1]:8080",
    });
    expect(result.ok).toBe(true);
  });

  it("handles default HTTP port", () => {
    const result = checkBrowserOrigin({
      requestHost: "example.com:80",
      origin: "http://example.com",
    });
    expect(result.ok).toBe(true);
  });

  it("handles default HTTPS port", () => {
    const result = checkBrowserOrigin({
      requestHost: "example.com:443",
      origin: "https://example.com",
    });
    expect(result.ok).toBe(true);
  });
});
