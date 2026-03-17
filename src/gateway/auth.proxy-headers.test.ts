import type { IncomingMessage } from "node:http";
import { describe, it, expect } from "vitest";
import { authorizeHttpGatewayConnect, type ResolvedGatewayAuth } from "./auth.js";

function createMockRequest(options: {
  remoteAddress?: string;
  headers?: Record<string, string | undefined>;
}): IncomingMessage {
  return {
    socket: {
      remoteAddress: options.remoteAddress,
    } as unknown as IncomingMessage["socket"],
    headers: options.headers || {},
  } as unknown as IncomingMessage;
}

describe("Proxy Header Enforcement", () => {
  const trustedProxyIP = "10.0.0.5";
  const untrustedIP = "1.2.3.4";
  const trustedProxies = [trustedProxyIP];

  const authNone: ResolvedGatewayAuth = {
    mode: "none",
    allowTailscale: false,
  };

  describe("requests without proxy headers", () => {
    it("should allow requests without any proxy headers from any IP", async () => {
      const req = createMockRequest({
        remoteAddress: untrustedIP,
        headers: {},
      });

      const result = await authorizeHttpGatewayConnect({
        auth: authNone,
        req,
        trustedProxies,
      });

      expect(result.ok).toBe(true);
      expect(result.method).toBe("none");
    });

    it("should allow requests without proxy headers from trusted proxy IP", async () => {
      const req = createMockRequest({
        remoteAddress: trustedProxyIP,
        headers: {},
      });

      const result = await authorizeHttpGatewayConnect({
        auth: authNone,
        req,
        trustedProxies,
      });

      expect(result.ok).toBe(true);
    });
  });

  describe("requests with X-Forwarded-For header", () => {
    it("should allow requests from trusted proxy with X-Forwarded-For", async () => {
      const req = createMockRequest({
        remoteAddress: trustedProxyIP,
        headers: {
          "x-forwarded-for": "192.168.1.100",
        },
      });

      const result = await authorizeHttpGatewayConnect({
        auth: authNone,
        req,
        trustedProxies,
      });

      expect(result.ok).toBe(true);
    });

    it("should reject requests from untrusted IP with X-Forwarded-For", async () => {
      const req = createMockRequest({
        remoteAddress: untrustedIP,
        headers: {
          "x-forwarded-for": "192.168.1.100",
        },
      });

      const result = await authorizeHttpGatewayConnect({
        auth: authNone,
        req,
        trustedProxies,
      });

      expect(result.ok).toBe(false);
      expect(result.reason).toBe("proxy_headers_from_untrusted_source");
    });

    it("should reject requests from untrusted IP with chained X-Forwarded-For", async () => {
      const req = createMockRequest({
        remoteAddress: untrustedIP,
        headers: {
          "x-forwarded-for": "192.168.1.100, 10.0.0.1",
        },
      });

      const result = await authorizeHttpGatewayConnect({
        auth: authNone,
        req,
        trustedProxies,
      });

      expect(result.ok).toBe(false);
      expect(result.reason).toBe("proxy_headers_from_untrusted_source");
    });
  });

  describe("requests with X-Real-IP header", () => {
    it("should allow requests from trusted proxy with X-Real-IP", async () => {
      const req = createMockRequest({
        remoteAddress: trustedProxyIP,
        headers: {
          "x-real-ip": "192.168.1.100",
        },
      });

      const result = await authorizeHttpGatewayConnect({
        auth: authNone,
        req,
        trustedProxies,
      });

      expect(result.ok).toBe(true);
    });

    it("should reject requests from untrusted IP with X-Real-IP", async () => {
      const req = createMockRequest({
        remoteAddress: untrustedIP,
        headers: {
          "x-real-ip": "192.168.1.100",
        },
      });

      const result = await authorizeHttpGatewayConnect({
        auth: authNone,
        req,
        trustedProxies,
      });

      expect(result.ok).toBe(false);
      expect(result.reason).toBe("proxy_headers_from_untrusted_source");
    });
  });

  describe("requests with X-Forwarded-Host header", () => {
    it("should allow requests from trusted proxy with X-Forwarded-Host", async () => {
      const req = createMockRequest({
        remoteAddress: trustedProxyIP,
        headers: {
          "x-forwarded-host": "example.com",
        },
      });

      const result = await authorizeHttpGatewayConnect({
        auth: authNone,
        req,
        trustedProxies,
      });

      expect(result.ok).toBe(true);
    });

    it("should reject requests from untrusted IP with X-Forwarded-Host", async () => {
      const req = createMockRequest({
        remoteAddress: untrustedIP,
        headers: {
          "x-forwarded-host": "example.com",
        },
      });

      const result = await authorizeHttpGatewayConnect({
        auth: authNone,
        req,
        trustedProxies,
      });

      expect(result.ok).toBe(false);
      expect(result.reason).toBe("proxy_headers_from_untrusted_source");
    });
  });

  describe("requests with X-Forwarded-Proto header", () => {
    it("should allow requests from trusted proxy with X-Forwarded-Proto", async () => {
      const req = createMockRequest({
        remoteAddress: trustedProxyIP,
        headers: {
          "x-forwarded-proto": "https",
        },
      });

      const result = await authorizeHttpGatewayConnect({
        auth: authNone,
        req,
        trustedProxies,
      });

      expect(result.ok).toBe(true);
    });

    it("should reject requests from untrusted IP with X-Forwarded-Proto", async () => {
      const req = createMockRequest({
        remoteAddress: untrustedIP,
        headers: {
          "x-forwarded-proto": "https",
        },
      });

      const result = await authorizeHttpGatewayConnect({
        auth: authNone,
        req,
        trustedProxies,
      });

      expect(result.ok).toBe(false);
      expect(result.reason).toBe("proxy_headers_from_untrusted_source");
    });
  });

  describe("requests with Forwarded header (RFC 7239)", () => {
    it("should allow requests from trusted proxy with Forwarded header", async () => {
      const req = createMockRequest({
        remoteAddress: trustedProxyIP,
        headers: {
          forwarded: "for=192.168.1.100;proto=https",
        },
      });

      const result = await authorizeHttpGatewayConnect({
        auth: authNone,
        req,
        trustedProxies,
      });

      expect(result.ok).toBe(true);
    });

    it("should reject requests from untrusted IP with Forwarded header", async () => {
      const req = createMockRequest({
        remoteAddress: untrustedIP,
        headers: {
          forwarded: "for=192.168.1.100;proto=https",
        },
      });

      const result = await authorizeHttpGatewayConnect({
        auth: authNone,
        req,
        trustedProxies,
      });

      expect(result.ok).toBe(false);
      expect(result.reason).toBe("proxy_headers_from_untrusted_source");
    });
  });

  describe("requests with multiple proxy headers", () => {
    it("should allow requests from trusted proxy with multiple headers", async () => {
      const req = createMockRequest({
        remoteAddress: trustedProxyIP,
        headers: {
          "x-forwarded-for": "192.168.1.100",
          "x-real-ip": "192.168.1.100",
          "x-forwarded-proto": "https",
          "x-forwarded-host": "example.com",
        },
      });

      const result = await authorizeHttpGatewayConnect({
        auth: authNone,
        req,
        trustedProxies,
      });

      expect(result.ok).toBe(true);
    });

    it("should reject requests from untrusted IP with multiple headers", async () => {
      const req = createMockRequest({
        remoteAddress: untrustedIP,
        headers: {
          "x-forwarded-for": "192.168.1.100",
          "x-real-ip": "192.168.1.100",
          "x-forwarded-proto": "https",
          "x-forwarded-host": "example.com",
        },
      });

      const result = await authorizeHttpGatewayConnect({
        auth: authNone,
        req,
        trustedProxies,
      });

      expect(result.ok).toBe(false);
      expect(result.reason).toBe("proxy_headers_from_untrusted_source");
    });
  });

  describe("with no trusted proxies configured", () => {
    it("should allow requests without proxy headers", async () => {
      const req = createMockRequest({
        remoteAddress: untrustedIP,
        headers: {},
      });

      const result = await authorizeHttpGatewayConnect({
        auth: authNone,
        req,
        trustedProxies: [],
      });

      expect(result.ok).toBe(true);
    });

    it("should reject requests with any proxy headers", async () => {
      const req = createMockRequest({
        remoteAddress: untrustedIP,
        headers: {
          "x-forwarded-for": "192.168.1.100",
        },
      });

      const result = await authorizeHttpGatewayConnect({
        auth: authNone,
        req,
        trustedProxies: [],
      });

      expect(result.ok).toBe(false);
      expect(result.reason).toBe("proxy_headers_from_untrusted_source");
    });
  });

  describe("with IP restrictions", () => {
    it("should enforce proxy headers before IP restrictions", async () => {
      // Attacker tries to bypass IP restriction by sending X-Forwarded-For
      const req = createMockRequest({
        remoteAddress: untrustedIP,
        headers: {
          "x-forwarded-for": "192.168.1.100", // Trusted IP
        },
      });

      const result = await authorizeHttpGatewayConnect({
        auth: authNone,
        req,
        trustedProxies,
        ipRestriction: {
          ipAllowlist: ["192.168.1.100"],
        },
      });

      // Should be rejected because of proxy header enforcement, not IP restriction
      expect(result.ok).toBe(false);
      expect(result.reason).toBe("proxy_headers_from_untrusted_source");
    });

    it("should apply IP restrictions after proxy header validation", async () => {
      // Legitimate proxy sends real client IP
      const req = createMockRequest({
        remoteAddress: trustedProxyIP,
        headers: {
          "x-forwarded-for": "1.2.3.4", // Untrusted client IP
        },
      });

      const result = await authorizeHttpGatewayConnect({
        auth: authNone,
        req,
        trustedProxies,
        ipRestriction: {
          ipAllowlist: ["192.168.1.100"],
        },
      });

      // Should pass proxy check but fail IP restriction
      expect(result.ok).toBe(false);
      expect(result.reason).toBe("ip_not_allowed");
    });

    it("should allow legitimate proxy with allowed client IP", async () => {
      const req = createMockRequest({
        remoteAddress: trustedProxyIP,
        headers: {
          "x-forwarded-for": "192.168.1.100",
        },
      });

      const result = await authorizeHttpGatewayConnect({
        auth: authNone,
        req,
        trustedProxies,
        ipRestriction: {
          ipAllowlist: ["192.168.1.100"],
        },
      });

      expect(result.ok).toBe(true);
    });
  });

  describe("edge cases", () => {
    it("should handle lowercase header names (Node.js normalizes headers to lowercase)", async () => {
      // Note: Node.js automatically lowercases all HTTP headers
      // So "X-FORWARDED-FOR" becomes "x-forwarded-for" before reaching our code
      const req = createMockRequest({
        remoteAddress: untrustedIP,
        headers: {
          "x-forwarded-for": "192.168.1.100",
        },
      });

      const result = await authorizeHttpGatewayConnect({
        auth: authNone,
        req,
        trustedProxies,
      });

      expect(result.ok).toBe(false);
      expect(result.reason).toBe("proxy_headers_from_untrusted_source");
    });

    it("should handle empty header values", async () => {
      const req = createMockRequest({
        remoteAddress: untrustedIP,
        headers: {
          "x-forwarded-for": "",
        },
      });

      // Empty header should not trigger proxy header check
      const result = await authorizeHttpGatewayConnect({
        auth: authNone,
        req,
        trustedProxies,
      });

      expect(result.ok).toBe(true);
    });

    it("should handle whitespace-only header values", async () => {
      const req = createMockRequest({
        remoteAddress: untrustedIP,
        headers: {
          "x-forwarded-for": "   ",
        },
      });

      // Whitespace-only header should not trigger proxy header check
      const result = await authorizeHttpGatewayConnect({
        auth: authNone,
        req,
        trustedProxies,
      });

      expect(result.ok).toBe(true);
    });

    it("should handle requests without socket", async () => {
      const req = {
        headers: {
          "x-forwarded-for": "192.168.1.100",
        },
      } as unknown as IncomingMessage;

      const result = await authorizeHttpGatewayConnect({
        auth: authNone,
        req,
        trustedProxies,
      });

      // Should reject because can't verify source
      expect(result.ok).toBe(false);
      expect(result.reason).toBe("proxy_headers_from_untrusted_source");
    });

    it("should handle IPv6 addresses", async () => {
      const ipv6TrustedProxy = "2001:db8::1";
      const req = createMockRequest({
        remoteAddress: ipv6TrustedProxy,
        headers: {
          "x-forwarded-for": "192.168.1.100",
        },
      });

      const result = await authorizeHttpGatewayConnect({
        auth: authNone,
        req,
        trustedProxies: [ipv6TrustedProxy],
      });

      expect(result.ok).toBe(true);
    });

    it("should handle IPv6 addresses with brackets", async () => {
      const req = createMockRequest({
        remoteAddress: `::ffff:${trustedProxyIP}`,
        headers: {
          "x-forwarded-for": "192.168.1.100",
        },
      });

      const result = await authorizeHttpGatewayConnect({
        auth: authNone,
        req,
        trustedProxies: [trustedProxyIP],
      });

      // IPv4-mapped IPv6 addresses should be handled
      expect(result.ok).toBe(true);
    });
  });

  describe("security scenarios", () => {
    it("should prevent header injection attacks", async () => {
      // Attacker tries to inject multiple headers
      const req = createMockRequest({
        remoteAddress: untrustedIP,
        headers: {
          "x-forwarded-for": "192.168.1.100\r\nX-Another: malicious",
        },
      });

      const result = await authorizeHttpGatewayConnect({
        auth: authNone,
        req,
        trustedProxies,
      });

      expect(result.ok).toBe(false);
      expect(result.reason).toBe("proxy_headers_from_untrusted_source");
    });

    it("should prevent bypass attempts with mixed headers", async () => {
      const req = createMockRequest({
        remoteAddress: untrustedIP,
        headers: {
          "x-real-ip": "192.168.1.100",
          // Not sending x-forwarded-for to try to bypass
        },
      });

      const result = await authorizeHttpGatewayConnect({
        auth: authNone,
        req,
        trustedProxies,
      });

      expect(result.ok).toBe(false);
      expect(result.reason).toBe("proxy_headers_from_untrusted_source");
    });

    it("should handle multiple trusted proxies", async () => {
      const multipleTrustedProxies = ["10.0.0.5", "10.0.0.6", "10.0.0.7"];

      for (const proxyIP of multipleTrustedProxies) {
        const req = createMockRequest({
          remoteAddress: proxyIP,
          headers: {
            "x-forwarded-for": "192.168.1.100",
          },
        });

        const result = await authorizeHttpGatewayConnect({
          auth: authNone,
          req,
          trustedProxies: multipleTrustedProxies,
        });

        expect(result.ok).toBe(true);
      }
    });

    it("should handle CIDR ranges in trusted proxies", async () => {
      const req = createMockRequest({
        remoteAddress: "10.0.1.50",
        headers: {
          "x-forwarded-for": "192.168.1.100",
        },
      });

      const result = await authorizeHttpGatewayConnect({
        auth: authNone,
        req,
        trustedProxies: ["10.0.0.0/16"],
      });

      expect(result.ok).toBe(true);
    });
  });
});
