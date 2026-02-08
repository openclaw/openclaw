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

  it("accepts loopback host mismatches for dev", () => {
    const result = checkBrowserOrigin({
      requestHost: "127.0.0.1:18789",
      origin: "http://localhost:5173",
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

  it("rejects cross-origin attack on localhost gateway", () => {
    // A malicious page at evil.com opens a WebSocket to the local gateway.
    // The browser sends Origin: https://evil.com — this must be rejected
    // even though the gateway host is loopback.
    const result = checkBrowserOrigin({
      requestHost: "127.0.0.1:18789",
      origin: "https://evil.com",
    });
    expect(result.ok).toBe(false);
  });

  it("rejects 'null' origin string", () => {
    // Sandboxed iframes and redirects send Origin: null
    const result = checkBrowserOrigin({
      requestHost: "127.0.0.1:18789",
      origin: "null",
    });
    expect(result.ok).toBe(false);
  });
});
