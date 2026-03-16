import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { checkBrowserOrigin, verifySignedOriginToken } from "./origin-check.js";

describe("checkBrowserOrigin", () => {
  it.each([
    {
      name: "accepts host-header fallback when explicitly enabled",
      input: {
        requestHost: "127.0.0.1:18789",
        origin: "http://127.0.0.1:18789",
        allowHostHeaderOriginFallback: true,
      },
      expected: {
        ok: true as const,
        matchedBy: "host-header-fallback" as const,
        wildcardMatched: false,
      },
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
      expected: {
        ok: true as const,
        matchedBy: "local-loopback" as const,
        wildcardMatched: false,
      },
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
      expected: {
        ok: true as const,
        matchedBy: "allowlist" as const,
        wildcardMatched: false,
      },
    },
    {
      name: "accepts wildcard allowlists even alongside specific entries",
      input: {
        requestHost: "gateway.tailnet.ts.net:18789",
        origin: "https://any-origin.example.com",
        allowedOrigins: ["https://control.example.com", " * "],
      },
      expected: {
        ok: true as const,
        matchedBy: "allowlist" as const,
        wildcardMatched: true,
      },
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

  describe("protocol validation (Forwarded header)", () => {
    it("accepts when origin proto matches Forwarded header proto", () => {
      const result = checkBrowserOrigin({
        isTrustedProxy: true,
        requestHost: "127.0.0.1:18789",
        requestForwardedHost: "gateway.tailnet.ts.net",
        origin: "https://gateway.tailnet.ts.net",
        allowedOrigins: ["https://gateway.tailnet.ts.net"],
        forwardedHeader: "for=192.0.2.1;host=gateway.tailnet.ts.net;proto=https",
      });
      expect(result.ok).toBe(true);
    });

    it("rejects when origin proto mismatches Forwarded header proto", () => {
      const result = checkBrowserOrigin({
        isTrustedProxy: true,
        requestHost: "127.0.0.1:18789",
        requestForwardedHost: "gateway.tailnet.ts.net",
        origin: "http://gateway.tailnet.ts.net",
        allowedOrigins: ["https://gateway.tailnet.ts.net"],
        forwardedHeader: "for=192.0.2.1;host=gateway.tailnet.ts.net;proto=https",
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toContain("does not match Forwarded proto");
      }
    });

    it("accepts HTTP origin when Forwarded header proto is http", () => {
      const result = checkBrowserOrigin({
        isTrustedProxy: true,
        requestHost: "127.0.0.1:18789",
        requestForwardedHost: "gateway.internal",
        origin: "http://gateway.internal",
        allowedOrigins: ["http://gateway.internal"],
        forwardedHeader: "for=192.0.2.1;host=gateway.internal;proto=http",
      });
      expect(result.ok).toBe(true);
    });

    it("rejects HTTPS origin when Forwarded header proto is http", () => {
      const result = checkBrowserOrigin({
        isTrustedProxy: true,
        requestHost: "127.0.0.1:18789",
        requestForwardedHost: "gateway.internal",
        origin: "https://gateway.internal",
        allowedOrigins: ["https://gateway.internal"],
        forwardedHeader: "for=192.0.2.1;host=gateway.internal;proto=http",
      });
      expect(result.ok).toBe(false);
    });

    it("handles quoted Forwarded header proto values", () => {
      const result = checkBrowserOrigin({
        isTrustedProxy: true,
        requestHost: "127.0.0.1:18789",
        requestForwardedHost: "gateway.tailnet.ts.net",
        origin: "https://gateway.tailnet.ts.net",
        allowedOrigins: ["https://gateway.tailnet.ts.net"],
        forwardedHeader: 'for=192.0.2.1;host="gateway.tailnet.ts.net";proto="https"',
      });
      expect(result.ok).toBe(true);
    });
  });

  describe("protocol validation (X-Forwarded-Proto header)", () => {
    it("accepts when origin proto matches X-Forwarded-Proto", () => {
      const result = checkBrowserOrigin({
        isTrustedProxy: true,
        requestHost: "127.0.0.1:18789",
        requestForwardedHost: "gateway.tailnet.ts.net",
        origin: "https://gateway.tailnet.ts.net",
        allowedOrigins: ["https://gateway.tailnet.ts.net"],
        requestForwardedProto: "https",
      });
      expect(result.ok).toBe(true);
    });

    it("rejects when origin proto mismatches X-Forwarded-Proto", () => {
      const result = checkBrowserOrigin({
        isTrustedProxy: true,
        requestHost: "127.0.0.1:18789",
        requestForwardedHost: "gateway.tailnet.ts.net",
        origin: "http://gateway.tailnet.ts.net",
        allowedOrigins: ["https://gateway.tailnet.ts.net"],
        requestForwardedProto: "https",
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toContain("does not match X-Forwarded-Proto");
      }
    });

    it("accepts HTTP origin when X-Forwarded-Proto is http", () => {
      const result = checkBrowserOrigin({
        isTrustedProxy: true,
        requestHost: "127.0.0.1:18789",
        requestForwardedHost: "gateway.internal",
        origin: "http://gateway.internal",
        allowedOrigins: ["http://gateway.internal"],
        requestForwardedProto: "http",
      });
      expect(result.ok).toBe(true);
    });

    it("rejects HTTPS origin when X-Forwarded-Proto is http", () => {
      const result = checkBrowserOrigin({
        isTrustedProxy: true,
        requestHost: "127.0.0.1:18789",
        requestForwardedHost: "gateway.internal",
        origin: "https://gateway.internal",
        allowedOrigins: ["https://gateway.internal"],
        requestForwardedProto: "http",
      });
      expect(result.ok).toBe(false);
    });

    it("handles case-insensitive X-Forwarded-Proto", () => {
      const result = checkBrowserOrigin({
        isTrustedProxy: true,
        requestHost: "127.0.0.1:18789",
        requestForwardedHost: "gateway.tailnet.ts.net",
        origin: "https://gateway.tailnet.ts.net",
        allowedOrigins: ["https://gateway.tailnet.ts.net"],
        requestForwardedProto: "HTTPS",
      });
      expect(result.ok).toBe(true);
    });
  });

  describe("protocol validation (both headers)", () => {
    it("rejects when origin proto mismatches Forwarded header even if X-Forwarded-Proto matches", () => {
      const result = checkBrowserOrigin({
        isTrustedProxy: true,
        requestHost: "127.0.0.1:18789",
        requestForwardedHost: "gateway.tailnet.ts.net",
        origin: "http://gateway.tailnet.ts.net",
        allowedOrigins: ["https://gateway.tailnet.ts.net"],
        forwardedHeader: "for=192.0.2.1;host=gateway.tailnet.ts.net;proto=https",
        requestForwardedProto: "http",
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toContain("does not match Forwarded proto");
      }
    });

    it("rejects when origin proto mismatches X-Forwarded-Proto even if Forwarded header matches", () => {
      const result = checkBrowserOrigin({
        isTrustedProxy: true,
        requestHost: "127.0.0.1:18789",
        requestForwardedHost: "gateway.tailnet.ts.net",
        origin: "http://gateway.tailnet.ts.net",
        allowedOrigins: ["https://gateway.tailnet.ts.net"],
        forwardedHeader: "for=192.0.2.1;host=gateway.tailnet.ts.net;proto=http",
        requestForwardedProto: "https",
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toContain("does not match X-Forwarded-Proto");
      }
    });

    it("accepts when origin proto matches both Forwarded and X-Forwarded-Proto", () => {
      const result = checkBrowserOrigin({
        isTrustedProxy: true,
        requestHost: "127.0.0.1:18789",
        requestForwardedHost: "gateway.tailnet.ts.net",
        origin: "https://gateway.tailnet.ts.net",
        allowedOrigins: ["https://gateway.tailnet.ts.net"],
        forwardedHeader: "for=192.0.2.1;host=gateway.tailnet.ts.net;proto=https",
        requestForwardedProto: "https",
      });
      expect(result.ok).toBe(true);
    });
  });

  describe("protocol validation edge cases", () => {
    it("bypasses protocol validation when strictProtoValidation is false", () => {
      const result = checkBrowserOrigin({
        isTrustedProxy: true,
        requestHost: "127.0.0.1:18789",
        requestForwardedHost: "gateway.tailnet.ts.net",
        origin: "http://gateway.tailnet.ts.net",
        allowedOrigins: ["https://gateway.tailnet.ts.net"],
        allowHostHeaderOriginFallback: true,
        forwardedHeader: "for=192.0.2.1;host=gateway.tailnet.ts.net;proto=https",
        requestForwardedProto: "https",
        strictProtoValidation: false,
      });
      expect(result.ok).toBe(true);
    });

    it("bypasses protocol validation when not behind trusted proxy", () => {
      const result = checkBrowserOrigin({
        isTrustedProxy: false,
        requestHost: "127.0.0.1:18789",
        requestForwardedHost: "gateway.tailnet.ts.net",
        origin: "http://gateway.tailnet.ts.net",
        allowedOrigins: ["https://gateway.tailnet.ts.net"],
        forwardedHeader: "for=192.0.2.1;host=gateway.tailnet.ts.net;proto=https",
        requestForwardedProto: "https",
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("origin not allowed");
      }
    });

    it("accepts when no forwarded headers are present (direct connection)", () => {
      const result = checkBrowserOrigin({
        isTrustedProxy: false,
        requestHost: "127.0.0.1:18789",
        origin: "http://127.0.0.1:18789",
        allowedOrigins: ["http://127.0.0.1:18789"],
      });
      expect(result.ok).toBe(true);
    });
  });

  describe("port normalization for allowlist matching", () => {
    it("accepts origin with default HTTPS port when allowlist omits port", () => {
      const result = checkBrowserOrigin({
        requestHost: "example.com:443",
        origin: "https://example.com:443",
        allowedOrigins: ["https://example.com"],
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.matchedBy).toBe("allowlist");
      }
    });

    it("accepts origin without default HTTPS port when allowlist includes port", () => {
      const result = checkBrowserOrigin({
        requestHost: "example.com:443",
        origin: "https://example.com",
        allowedOrigins: ["https://example.com:443"],
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.matchedBy).toBe("allowlist");
      }
    });

    it("accepts origin with default HTTP port when allowlist omits port", () => {
      const result = checkBrowserOrigin({
        requestHost: "example.com:80",
        origin: "http://example.com:80",
        allowedOrigins: ["http://example.com"],
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.matchedBy).toBe("allowlist");
      }
    });

    it("accepts origin without default HTTP port when allowlist includes port", () => {
      const result = checkBrowserOrigin({
        requestHost: "example.com:80",
        origin: "http://example.com",
        allowedOrigins: ["http://example.com:80"],
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.matchedBy).toBe("allowlist");
      }
    });

    it("preserves non-standard port matching", () => {
      const result = checkBrowserOrigin({
        requestHost: "example.com:8443",
        origin: "https://example.com:8443",
        allowedOrigins: ["https://example.com:8443"],
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.matchedBy).toBe("allowlist");
      }
    });

    it("rejects non-standard port when allowlist has standard port", () => {
      const result = checkBrowserOrigin({
        requestHost: "example.com:8443",
        origin: "https://example.com:8443",
        allowedOrigins: ["https://example.com:443"],
      });
      expect(result.ok).toBe(false);
    });

    it("handles mixed port representations in allowlist", () => {
      const result = checkBrowserOrigin({
        requestHost: "example.com:443",
        origin: "https://example.com:443",
        allowedOrigins: ["https://example.com", "https://example.com:443"],
      });
      expect(result.ok).toBe(true);
    });

    it("normalizes both origin and allowlist consistently", () => {
      const result = checkBrowserOrigin({
        requestHost: "example.com:443",
        origin: "HTTPS://EXAMPLE.COM:443",
        allowedOrigins: ["https://example.com"],
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.matchedBy).toBe("allowlist");
      }
    });
  });

  describe("host header validation", () => {
    it("accepts when host matches origin (default port normalization)", () => {
      const result = checkBrowserOrigin({
        requestHost: "example.com",
        origin: "https://example.com",
        allowedOrigins: ["https://example.com"],
        validateHostHeader: true,
      });
      expect(result.ok).toBe(true);
    });

    it("accepts when host has explicit port that normalizes to origin", () => {
      const result = checkBrowserOrigin({
        requestHost: "example.com:443",
        origin: "https://example.com",
        allowedOrigins: ["https://example.com"],
        validateHostHeader: true,
      });
      expect(result.ok).toBe(true);
    });

    it("accepts when host matches origin with port", () => {
      const result = checkBrowserOrigin({
        requestHost: "example.com:443",
        origin: "https://example.com:443",
        allowedOrigins: ["https://example.com:443"],
        validateHostHeader: true,
      });
      expect(result.ok).toBe(true);
    });

    it("rejects when host does not match origin and not in allowlist", () => {
      const result = checkBrowserOrigin({
        requestHost: "attacker.com",
        origin: "https://example.com",
        allowedOrigins: ["https://example.com"],
        validateHostHeader: true,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("host header does not match origin or allowlist");
      }
    });

    it("accepts when host is in allowlist even if different from origin host", () => {
      const result = checkBrowserOrigin({
        requestHost: "example.com",
        origin: "https://other.com",
        allowedOrigins: ["https://example.com", "https://other.com"],
        validateHostHeader: true,
      });
      expect(result.ok).toBe(true);
    });

    it("allows bypass when validateHostHeader is false", () => {
      const result = checkBrowserOrigin({
        requestHost: "attacker.com",
        origin: "https://example.com",
        allowedOrigins: ["https://example.com"],
        validateHostHeader: false,
      });
      expect(result.ok).toBe(true);
    });

    it("does not validate host by default (backward compatible)", () => {
      const result = checkBrowserOrigin({
        requestHost: "attacker.com",
        origin: "https://example.com",
        allowedOrigins: ["https://example.com"],
      });
      expect(result.ok).toBe(true);
    });

    it("skips validation when host header is missing", () => {
      const result = checkBrowserOrigin({
        requestHost: undefined,
        origin: "https://example.com",
        allowedOrigins: ["https://example.com"],
        validateHostHeader: true,
      });
      expect(result.ok).toBe(true);
    });

    it("validates host with non-standard port against allowlist with same port", () => {
      const result = checkBrowserOrigin({
        requestHost: "example.com:8443",
        origin: "https://example.com:8443",
        allowedOrigins: ["https://example.com:8443"],
        validateHostHeader: true,
      });
      expect(result.ok).toBe(true);
    });

    it("rejects host with non-standard port that differs from origin port", () => {
      const result = checkBrowserOrigin({
        requestHost: "example.com:8443",
        origin: "https://example.com:443",
        allowedOrigins: ["https://example.com:443"],
        validateHostHeader: true,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("host header does not match origin or allowlist");
      }
    });
  });
});

describe("verifySignedOriginToken", () => {
  const secret = "test-secret-key";

  it("accepts valid token", () => {
    const now = Math.floor(Date.now() / 1000);
    const payload = {
      sub: "user@example.com",
      origin: "https://example.com",
      iat: now,
      exp: now + 300,
      nonce: "abc123",
    };
    const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const sig = createHmac("sha256", secret).update(payloadB64).digest("base64url");
    const token = `${payloadB64}.${sig}`;

    const result = verifySignedOriginToken(token, secret, "https://example.com");
    if (!result.ok) {
      console.log("FAIL:", result.reason);
    }
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.user).toBe("user@example.com");
    }
  });

  it("rejects invalid signature", () => {
    const payload = {
      sub: "user@example.com",
      origin: "https://example.com",
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 300,
      nonce: "abc123",
    };
    const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const token = `${payloadB64}.invalid-signature`;

    const result = verifySignedOriginToken(token, secret, "https://example.com");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("invalid signature");
    }
  });

  it("rejects origin mismatch", () => {
    const payload = {
      sub: "user@example.com",
      origin: "https://evil.com",
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 300,
      nonce: "abc123",
    };
    const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const sig = createHmac("sha256", secret).update(payloadB64).digest("base64url");
    const token = `${payloadB64}.${sig}`;

    const result = verifySignedOriginToken(token, secret, "https://example.com");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("origin mismatch");
    }
  });

  it("rejects expired token", () => {
    const payload = {
      sub: "user@example.com",
      origin: "https://example.com",
      iat: Math.floor(Date.now() / 1000) - 600,
      exp: Math.floor(Date.now() / 1000) - 300,
      nonce: "abc123",
    };
    const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const sig = createHmac("sha256", secret).update(payloadB64).digest("base64url");
    const token = `${payloadB64}.${sig}`;

    const result = verifySignedOriginToken(token, secret, "https://example.com");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/token expired|not yet valid/);
    }
  });

  it("rejects malformed token", () => {
    const result = verifySignedOriginToken("not-a-valid-token", secret, "https://example.com");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("invalid token format");
    }
  });

  it("rejects missing token", () => {
    const result = verifySignedOriginToken("", secret, "https://example.com");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("missing token or secret");
    }
  });
});
