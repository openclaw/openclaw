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
    it("regression: allowlist still fires first when forwarded-host is present", () => {
      const result = checkBrowserOrigin({
        isTrustedProxy: true,
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

    it("rejects when origin does not match forwarded-host (cross-validation)", () => {
      const result = checkBrowserOrigin({
        isTrustedProxy: true,
        requestHost: "127.0.0.1:18789",
        requestForwardedHost: "gateway.tailnet.ts.net",
        origin: "https://attacker.com",
        allowedOrigins: ["https://gateway.tailnet.ts.net"],
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("origin does not match forwarded host");
      }
    });

    it("rejects forwarded-host not in allowlist even with matching origin", () => {
      const result = checkBrowserOrigin({
        isTrustedProxy: true,
        requestHost: "127.0.0.1:18789",
        requestForwardedHost: "attacker.tailnet.ts.net",
        origin: "https://attacker.tailnet.ts.net",
        allowedOrigins: ["https://gateway.tailnet.ts.net"],
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("origin not allowed");
      }
    });

    it("rejects protocol downgrade (http vs https)", () => {
      const result = checkBrowserOrigin({
        isTrustedProxy: true,
        requestHost: "127.0.0.1:18789",
        requestForwardedHost: "gateway.tailnet.ts.net",
        origin: "http://gateway.tailnet.ts.net",
        allowedOrigins: ["https://gateway.tailnet.ts.net"],
      });
      expect(result.ok).toBe(false);
    });

    it("accepts forwarded-host with fallback flag when not in allowlist", () => {
      const result = checkBrowserOrigin({
        isTrustedProxy: true,
        requestHost: "127.0.0.1:18789",
        requestForwardedHost: "gateway.tailnet.ts.net",
        origin: "https://gateway.tailnet.ts.net",
        allowedOrigins: ["https://other.example.com"],
        allowHostHeaderOriginFallback: true,
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.matchedBy).toBe("host-header-fallback");
      }
    });

    it("accepts http origin via fallback when allowlist is https-only (legacy behavior)", () => {
      // Note: When allowHostHeaderOriginFallback is true, scheme is NOT validated in fallback path.
      // This is legacy behavior for backward compatibility. Users should prefer explicit allowlist.
      const result = checkBrowserOrigin({
        isTrustedProxy: true,
        requestHost: "127.0.0.1:18789",
        requestForwardedHost: "gateway.tailnet.ts.net",
        origin: "http://gateway.tailnet.ts.net",
        allowedOrigins: ["https://gateway.tailnet.ts.net"],
        allowHostHeaderOriginFallback: true,
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.matchedBy).toBe("host-header-fallback");
      }
    });

    it("rejects forwarded-host without fallback flag when not in allowlist", () => {
      const result = checkBrowserOrigin({
        isTrustedProxy: true,
        requestHost: "127.0.0.1:18789",
        requestForwardedHost: "gateway.tailnet.ts.net",
        origin: "https://gateway.tailnet.ts.net",
        allowedOrigins: ["https://other.example.com"],
        allowHostHeaderOriginFallback: false,
      });
      expect(result.ok).toBe(false);
    });

    it("rejects valid forwarded-host if proxy is NOT trusted", () => {
      const result = checkBrowserOrigin({
        isTrustedProxy: false,
        requestForwardedHost: "gateway.tailnet.ts.net",
        origin: "https://gateway.tailnet.ts.net",
        allowedOrigins: ["https://gateway.tailnet.ts.net"],
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("origin not allowed");
      }
    });

    it("accepts forwarded-host when proxy IS trusted", () => {
      const result = checkBrowserOrigin({
        isTrustedProxy: true,
        requestForwardedHost: "gateway.tailnet.ts.net",
        origin: "https://gateway.tailnet.ts.net",
        allowedOrigins: ["https://gateway.tailnet.ts.net"],
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.matchedBy).toBe("allowlist");
      }
    });

    it("works without forwarded-host (direct request still passes)", () => {
      const result = checkBrowserOrigin({
        requestHost: "127.0.0.1:18789",
        origin: "http://localhost:5173",
        allowedOrigins: ["http://localhost:5173", "http://127.0.0.1:18789"],
      });
      expect(result.ok).toBe(true);
    });

    it("prevents CSRF attack via spoofed X-Forwarded-Host", () => {
      // Attacker tries to bypass by spoofing X-Forwarded-Host
      // but Origin doesn't match
      const result = checkBrowserOrigin({
        isTrustedProxy: true,
        requestHost: "127.0.0.1:18789",
        requestForwardedHost: "gateway.tailnet.ts.net",
        origin: "https://evil.com",
        allowedOrigins: ["https://gateway.tailnet.ts.net"],
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("origin does not match forwarded host");
      }
    });

    it("prevents attack even with compromised proxy (scheme mismatch)", () => {
      // Even if attacker controls proxy and sets valid X-Forwarded-Host,
      // the Origin scheme must match
      const result = checkBrowserOrigin({
        isTrustedProxy: true,
        requestHost: "127.0.0.1:18789",
        requestForwardedHost: "gateway.tailnet.ts.net",
        origin: "http://gateway.tailnet.ts.net", // http instead of https
        allowedOrigins: ["https://gateway.tailnet.ts.net"],
      });
      expect(result.ok).toBe(false);
    });

    it("accepts forwarded-host with explicit port (nginx $host:$server_port)", () => {
      // Greptile fix: X-Forwarded-Host with explicit port from nginx should work
      const result = checkBrowserOrigin({
        isTrustedProxy: true,
        requestHost: "127.0.0.1:18789",
        requestForwardedHost: "gateway.tailnet.ts.net:443",
        origin: "https://gateway.tailnet.ts.net",
        allowedOrigins: [],
        allowHostHeaderOriginFallback: true,
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.matchedBy).toBe("host-header-fallback");
      }
    });

    it("accepts forwarded-host with explicit HTTP port 80 (nginx $host:$server_port)", () => {
      // Greptile fix: X-Forwarded-Host with explicit :80 port should work for HTTP
      const result = checkBrowserOrigin({
        isTrustedProxy: true,
        requestHost: "127.0.0.1:18789",
        requestForwardedHost: "gateway.ts.net:80",
        origin: "http://gateway.ts.net",
        allowedOrigins: [],
        allowHostHeaderOriginFallback: true,
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.matchedBy).toBe("host-header-fallback");
      }
    });

    it("accepts forwarded-host with non-standard port", () => {
      const result = checkBrowserOrigin({
        isTrustedProxy: true,
        requestHost: "127.0.0.1:18789",
        requestForwardedHost: "gateway.tailnet.ts.net:8443",
        origin: "https://gateway.tailnet.ts.net:8443",
        allowedOrigins: ["https://gateway.tailnet.ts.net:8443"],
      });
      expect(result.ok).toBe(true);
    });

    it("accepts bracketed IPv6 forwarded-host with default port", () => {
      // IPv6 addresses like [2001:db8::1]:443 need special handling
      const result = checkBrowserOrigin({
        isTrustedProxy: true,
        requestHost: "127.0.0.1:18789",
        requestForwardedHost: "[2001:db8::1]:443",
        origin: "https://[2001:db8::1]",
        allowedOrigins: ["https://[2001:db8::1]"],
      });
      expect(result.ok).toBe(true);
    });
  });
});
