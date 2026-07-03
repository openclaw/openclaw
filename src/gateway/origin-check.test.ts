// Browser origin tests document same-origin, private-network, loopback, forwarded
// host, and explicit allowlist decisions for gateway browser surfaces.
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
      name: "accepts same-origin private LAN host without dangerous fallback",
      input: {
        requestHost: "192.168.0.202:18789",
        origin: "http://192.168.0.202:18789",
      },
      expected: { ok: true as const, matchedBy: "private-same-origin" as const },
    },
    {
      name: "accepts same-origin tailnet host without dangerous fallback",
      input: {
        requestHost: "peters-mac-studio-1.example.ts.net:18789",
        origin: "http://peters-mac-studio-1.example.ts.net:18789",
      },
      expected: { ok: true as const, matchedBy: "private-same-origin" as const },
    },
    {
      name: "accepts same-origin loopback host for local clients",
      input: {
        requestHost: "127.0.0.1:18789",
        origin: "http://127.0.0.1:18789",
        isLocalClient: true,
      },
      expected: { ok: true as const, matchedBy: "private-same-origin" as const },
    },
    {
      name: "rejects same-origin loopback host for non-local clients",
      input: {
        requestHost: "127.0.0.1:18789",
        origin: "http://127.0.0.1:18789",
        isLocalClient: false,
      },
      expected: { ok: false as const, reason: "origin not allowed" },
    },
    {
      name: "rejects same-origin public host without dangerous fallback",
      input: {
        requestHost: "attacker.example.com:18789",
        origin: "http://attacker.example.com:18789",
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
      name: "rejects same-origin loopback host matches for non-local clients",
      input: {
        requestHost: "127.0.0.1:18789",
        origin: "http://127.0.0.1:18789",
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

  describe("allowedOriginPatterns", () => {
    it.each([
      {
        name: "accepts http://127.0.0.1:* with random port",
        input: {
          requestHost: "gateway.example.com:18789",
          origin: "http://127.0.0.1:40313",
          allowedOriginPatterns: ["http://127.0.0.1:*"],
        },
        expected: {
          ok: true as const,
          matchedBy: "origin-pattern" as const,
          matchedPattern: "http://127.0.0.1:*",
        },
      },
      {
        name: "accepts http://localhost:* with random port",
        input: {
          requestHost: "gateway.example.com:18789",
          origin: "http://localhost:5173",
          allowedOriginPatterns: ["http://localhost:*"],
        },
        expected: {
          ok: true as const,
          matchedBy: "origin-pattern" as const,
          matchedPattern: "http://localhost:*",
        },
      },
      {
        name: "accepts http://[::1]:* with random port",
        input: {
          requestHost: "gateway.example.com:18789",
          origin: "http://[::1]:8080",
          allowedOriginPatterns: ["http://[::1]:*"],
        },
        expected: {
          ok: true as const,
          matchedBy: "origin-pattern" as const,
          matchedPattern: "http://[::1]:*",
        },
      },
      {
        name: "accepts https://127.0.0.1:* with random port",
        input: {
          requestHost: "gateway.example.com:18789",
          origin: "https://127.0.0.1:9000",
          allowedOriginPatterns: ["https://127.0.0.1:*"],
        },
        expected: {
          ok: true as const,
          matchedBy: "origin-pattern" as const,
          matchedPattern: "https://127.0.0.1:*",
        },
      },
      {
        name: "accepts default port (origin without explicit port)",
        input: {
          requestHost: "gateway.example.com:18789",
          origin: "http://127.0.0.1",
          allowedOriginPatterns: ["http://127.0.0.1:*"],
        },
        expected: {
          ok: true as const,
          matchedBy: "origin-pattern" as const,
          matchedPattern: "http://127.0.0.1:*",
        },
      },
      {
        name: "rejects non-loopback hostname",
        input: {
          requestHost: "gateway.example.com:18789",
          origin: "http://attacker.example.com:8080",
          allowedOriginPatterns: ["http://attacker.example.com:*"],
        },
        expected: { ok: false as const, reason: "origin not allowed" },
      },
      {
        name: "rejects protocol mismatch",
        input: {
          requestHost: "gateway.example.com:18789",
          origin: "https://127.0.0.1:8080",
          allowedOriginPatterns: ["http://127.0.0.1:*"],
        },
        expected: { ok: false as const, reason: "origin not allowed" },
      },
      {
        name: "rejects hostname mismatch (localhost vs 127.0.0.1)",
        input: {
          requestHost: "gateway.example.com:18789",
          origin: "http://localhost:8080",
          allowedOriginPatterns: ["http://127.0.0.1:*"],
        },
        expected: { ok: false as const, reason: "origin not allowed" },
      },
      {
        name: "rejects non-loopback hostname even with pattern",
        input: {
          requestHost: "gateway.example.com:18789",
          origin: "http://public.example.com:8080",
          allowedOriginPatterns: ["http://127.0.0.1:*"],
        },
        expected: { ok: false as const, reason: "origin not allowed" },
      },
      {
        name: "rejects non-loopback hostname as pattern target",
        input: {
          requestHost: "gateway.example.com:18789",
          origin: "http://192.168.1.1:8080",
          allowedOriginPatterns: ["http://192.168.1.1:*"],
        },
        expected: { ok: false as const, reason: "origin not allowed" },
      },
      {
        name: "empty patterns array does not affect existing behavior",
        input: {
          requestHost: "gateway.example.com:18789",
          origin: "https://attacker.example.com",
          allowedOriginPatterns: [],
        },
        expected: { ok: false as const, reason: "origin not allowed" },
      },
      {
        name: "exact allowlist match still takes priority over patterns",
        input: {
          requestHost: "gateway.example.com:18789",
          origin: "https://specific.example.com",
          allowedOrigins: ["https://specific.example.com"],
          allowedOriginPatterns: ["http://127.0.0.1:*"],
        },
        expected: { ok: true as const, matchedBy: "allowlist" as const },
      },
      {
        name: "first matching pattern wins and records matchedPattern",
        input: {
          requestHost: "gateway.example.com:18789",
          origin: "http://127.0.0.1:9999",
          allowedOriginPatterns: ["http://localhost:*", "http://127.0.0.1:*", "http://[::1]:*"],
        },
        expected: {
          ok: true as const,
          matchedBy: "origin-pattern" as const,
          matchedPattern: "http://127.0.0.1:*",
        },
      },
      {
        name: "accepts localhost. with trailing dot in origin",
        input: {
          requestHost: "gateway.example.com:18789",
          origin: "http://localhost.:40313",
          allowedOriginPatterns: ["http://localhost:*"],
        },
        expected: {
          ok: true as const,
          matchedBy: "origin-pattern" as const,
          matchedPattern: "http://localhost:*",
        },
      },
      {
        name: "accepts trailing dot in pattern (localhost.:* matches localhost.:port)",
        input: {
          requestHost: "gateway.example.com:18789",
          origin: "http://localhost.:40313",
          allowedOriginPatterns: ["http://localhost.:*"],
        },
        expected: {
          ok: true as const,
          matchedBy: "origin-pattern" as const,
          matchedPattern: "http://localhost.:*",
        },
      },
      {
        name: "accepts trailing dot in pattern (localhost.:* matches localhost:port)",
        input: {
          requestHost: "gateway.example.com:18789",
          origin: "http://localhost:40313",
          allowedOriginPatterns: ["http://localhost.:*"],
        },
        expected: {
          ok: true as const,
          matchedBy: "origin-pattern" as const,
          matchedPattern: "http://localhost.:*",
        },
      },
      // HTTP trusted-proxy path tests — simulate the browserOriginPolicy
      // shape that authorizeTrustedProxyBrowserOrigin passes to checkBrowserOrigin.
      {
        name: "HTTP trusted-proxy: loopback pattern via browserOriginPolicy",
        input: {
          requestHost: "gateway.example.com:18789",
          origin: "http://127.0.0.1:40313",
          allowedOriginPatterns: ["http://127.0.0.1:*"],
          allowHostHeaderOriginFallback: false,
          isLocalClient: false,
        },
        expected: {
          ok: true as const,
          matchedBy: "origin-pattern" as const,
          matchedPattern: "http://127.0.0.1:*",
        },
      },
      {
        name: "HTTP trusted-proxy: non-loopback origin rejected via browserOriginPolicy",
        input: {
          requestHost: "gateway.example.com:18789",
          origin: "https://evil.example.com",
          allowedOriginPatterns: ["http://127.0.0.1:*"],
          allowHostHeaderOriginFallback: false,
          isLocalClient: false,
        },
        expected: { ok: false as const, reason: "origin not allowed" },
      },
    ])("$name", ({ input, expected }) => {
      // matchedPattern is included in the comparison when expected has it
      const result = checkBrowserOrigin(input);
      if (expected.ok && "matchedPattern" in expected) {
        expect(result).toMatchObject(expected);
      } else {
        expect(result).toEqual(expected);
      }
    });
  });
});
