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

  it('accepts any origin when allowedOrigins includes "*" (regression: #30990)', () => {
    const result = checkBrowserOrigin({
      requestHost: "100.86.79.37:18789",
      origin: "https://100.86.79.37:18789",
      allowedOrigins: ["*"],
    });
    expect(result.ok).toBe(true);
  });

  it('accepts any origin when allowedOrigins includes "*" alongside specific entries', () => {
    const result = checkBrowserOrigin({
      requestHost: "gateway.tailnet.ts.net:18789",
      origin: "https://gateway.tailnet.ts.net:18789",
      allowedOrigins: ["https://control.example.com", "*"],
    });
    expect(result.ok).toBe(true);
  });

  it("accepts wildcard entries with surrounding whitespace", () => {
    const result = checkBrowserOrigin({
      requestHost: "100.86.79.37:18789",
      origin: "https://100.86.79.37:18789",
      allowedOrigins: [" * "],
    });
    expect(result.ok).toBe(true);
  });
  describe("Tailscale Serve (x-forwarded-host)", () => {
    it("accepts forwarded-host when it matches allowlist", () => {
      const result = checkBrowserOrigin({
        requestHost: "127.0.0.1:18789",
        requestForwardedHost: "gateway.tailnet.ts.net",
        origin: "https://gateway.tailnet.ts.net",
        allowedOrigins: ["https://gateway.tailnet.ts.net"],
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.matchedBy).toBe("allowlist");
      }
    });

    it("accepts forwarded-host even without host-header fallback enabled", () => {
      const result = checkBrowserOrigin({
        requestHost: "127.0.0.1:18789",
        requestForwardedHost: "gateway.tailnet.ts.net",
        origin: "https://gateway.tailnet.ts.net",
        allowedOrigins: ["https://gateway.tailnet.ts.net"],
        allowHostHeaderOriginFallback: false,
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.matchedBy).toBe("allowlist");
      }
    });

    it("rejects forwarded-host not in allowlist", () => {
      const result = checkBrowserOrigin({
        requestHost: "127.0.0.1:18789",
        requestForwardedHost: "attacker.tailnet.ts.net",
        origin: "https://attacker.tailnet.ts.net",
        allowedOrigins: ["https://gateway.tailnet.ts.net"],
      });
      expect(result.ok).toBe(false);
      expect(result.reason).toBe("origin not allowed");
    });

    it("accepts forwarded-host with full URL in allowlist and host-only origin", () => {
      const result = checkBrowserOrigin({
        requestHost: "127.0.0.1:18789",
        requestForwardedHost: "gateway.tailnet.ts.net",
        origin: "https://gateway.tailnet.ts.net",
        allowedOrigins: ["https://gateway.tailnet.ts.net"],
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.matchedBy).toBe("allowlist");
      }
    });

    it("rejects forwarded-host partial match (host part only)", () => {
      const result = checkBrowserOrigin({
        requestHost: "127.0.0.1:18789",
        requestForwardedHost: "evilhost.com:8443",
        origin: "https://evilhost.com:8443",
        allowedOrigins: ["https://gateway.tailnet.ts.net"],
      });
      expect(result.ok).toBe(false);
      expect(result.reason).toBe("origin not allowed");
    });

    it("works without forwarded-host (direct request still passes)", () => {
      const result = checkBrowserOrigin({
        requestHost: "127.0.0.1:18789",
        origin: "http://localhost:5173",
        allowedOrigins: ["http://localhost:5173", "http://127.0.0.1:18789"],
      });
      expect(result.ok).toBe(true);
    });

    it("non-Tailscale proxy headers don't bypass allowlist", () => {
      const result = checkBrowserOrigin({
        requestHost: "127.0.0.1:18789",
        requestForwardedHost: "attacker.tailnet.ts.net",
        origin: "https://attacker.tailnet.ts.net",
        allowedOrigins: ["https://allowed.com"],
      });
      expect(result.ok).toBe(false);
      expect(result.reason).toBe("origin not allowed");
    });
  });
});
