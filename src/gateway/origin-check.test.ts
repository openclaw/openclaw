import { describe, expect, it } from "vitest";
import { checkBrowserOrigin } from "./origin-check.js";

describe("checkBrowserOrigin", () => {
  it("accepts same-origin host matches only with legacy host-header fallback", () => {
    const result = checkBrowserOrigin({
      requestHost: "127.0.0.1:18789",
      origin: "http://127.0.0.1:18789",
      allowHostHeaderOriginFallback: true,
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

  it("accepts wildcard allowedOrigins", () => {
    const result = checkBrowserOrigin({
      requestHost: "gateway.example.com:18789",
      origin: "https://any-origin.example.com",
      allowedOrigins: ["*"],
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

  it("accepts all origins when wildcard * is in allowedOrigins", () => {
    const result1 = checkBrowserOrigin({
      requestHost: "gateway.example.com:18789",
      origin: "https://control.example.com",
      allowedOrigins: ["*"],
    });
    expect(result1.ok).toBe(true);

    const result2 = checkBrowserOrigin({
      requestHost: "gateway.example.com:18789",
      origin: "http://192.168.1.100:18789",
      allowedOrigins: ["*"],
    });
    expect(result2.ok).toBe(true);

    const result3 = checkBrowserOrigin({
      requestHost: "gateway.example.com:18789",
      origin: "https://any-origin.example.com:8080",
      allowedOrigins: ["*"],
    });
    expect(result3.ok).toBe(true);
  });

  it("accepts wildcard * even when mixed with specific origins", () => {
    const result = checkBrowserOrigin({
      requestHost: "gateway.example.com:18789",
      origin: "https://other.example.com",
      allowedOrigins: ["https://control.example.com", "*", "https://another.example.com"],
    });
    expect(result.ok).toBe(true);
  });
});
