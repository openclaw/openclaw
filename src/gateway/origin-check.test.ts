import { describe, expect, it } from "vitest";
import { checkBrowserOrigin } from "./origin-check.js";

describe("checkBrowserOrigin", () => {
  it.each([
    {
      name: "accepts host-header fallback when explicitly enabled",
      input: {
        requestHost: "127.0.0.1:18789",
        origin: "http://127.0.0.1:18789",
        allowHostHeaderOriginFallback: true,
      },
      expected: { ok: true as const, matchedBy: "host-header-fallback" as const },
    },
    {
      name: "rejects same-origin host matches when fallback is disabled",
      input: {
        requestHost: "gateway.example.com:18789",
        origin: "https://gateway.example.com:18789",
      },
      expected: { ok: false as const, reason: "origin not allowed" },
    },
    {
      name: "accepts local loopback mismatches for local clients",
      input: {
        requestHost: "127.0.0.1:18789",
        origin: "http://localhost:5173",
        isLocalClient: true,
      },
      expected: { ok: true as const, matchedBy: "local-loopback" as const },
    },
    {
      name: "rejects loopback mismatches for non-local clients",
      input: {
        requestHost: "127.0.0.1:18789",
        origin: "http://localhost:5173",
        isLocalClient: false,
      },
      expected: { ok: false as const, reason: "origin not allowed" },
    },
    {
      name: "accepts trimmed lowercase-normalized allowlist matches",
      input: {
        requestHost: "gateway.example.com:18789",
        origin: "https://CONTROL.example.com",
        allowedOrigins: [" https://control.example.com "],
      },
      expected: { ok: true as const, matchedBy: "allowlist" as const },
    },
    {
      name: "accepts wildcard allowlists even alongside specific entries",
      input: {
        requestHost: "gateway.tailnet.ts.net:18789",
        origin: "https://any-origin.example.com",
        allowedOrigins: ["https://control.example.com", " * "],
      },
      expected: { ok: true as const, matchedBy: "allowlist" as const },
    },
    {
      name: "rejects missing origin",
      input: {
        requestHost: "gateway.example.com:18789",
        origin: "",
      },
      expected: { ok: false as const, reason: "origin missing or invalid" },
    },
    {
      name: 'rejects literal "null" origin',
      input: {
        requestHost: "gateway.example.com:18789",
        origin: "null",
      },
      expected: { ok: false as const, reason: "origin missing or invalid" },
    },
    {
      name: "rejects malformed origin URLs",
      input: {
        requestHost: "gateway.example.com:18789",
        origin: "not a url",
      },
      expected: { ok: false as const, reason: "origin missing or invalid" },
    },
    {
      name: "rejects mismatched origins",
      input: {
        requestHost: "gateway.example.com:18789",
        origin: "https://attacker.example.com",
      },
      expected: { ok: false as const, reason: "origin not allowed" },
    },
  ])("$name", ({ input, expected }) => {
    expect(checkBrowserOrigin(input)).toEqual(expected);
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
  });
});
