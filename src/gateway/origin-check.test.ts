import { describe, expect, it } from "vitest";
import { checkBrowserOrigin, checkBrowserRequestHost } from "./origin-check.js";

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
});

describe("checkBrowserRequestHost", () => {
  it.each([
    {
      name: "accepts explicit allowlist host matches",
      input: {
        requestHost: "control.example.com",
        allowedOrigins: ["https://control.example.com"],
      },
      expected: { ok: true as const, matchedBy: "allowlist" as const },
    },
    {
      name: "does not treat implicit default ports as equivalent allowlist matches",
      input: {
        requestHost: "control.example.com:443",
        allowedOrigins: ["https://control.example.com"],
      },
      expected: { ok: false as const, reason: "host not allowed" },
    },
    {
      name: "accepts loopback hosts without an allowlist",
      input: {
        requestHost: "127.0.0.1:18789",
      },
      expected: { ok: true as const, matchedBy: "local-loopback" as const },
    },
    {
      name: "rejects non-loopback hosts when no allowlist is configured",
      input: {
        requestHost: "gateway.example.com:18789",
      },
      expected: { ok: false as const, reason: "host not allowed" },
    },
    {
      name: "accepts any host when host-header fallback is explicitly enabled",
      input: {
        requestHost: "gateway.internal:18789",
        allowHostHeaderOriginFallback: true,
      },
      expected: { ok: true as const, matchedBy: "host-header-fallback" as const },
    },
    {
      name: "rejects disallowed non-loopback hosts",
      input: {
        requestHost: "evil.example",
        allowedOrigins: ["https://control.example.com"],
      },
      expected: { ok: false as const, reason: "host not allowed" },
    },
    {
      name: "rejects missing host headers",
      input: {
        requestHost: "",
        allowedOrigins: ["https://control.example.com"],
      },
      expected: { ok: false as const, reason: "host missing or invalid" },
    },
    {
      name: "rejects undefined host headers",
      input: {
        requestHost: undefined,
        allowedOrigins: ["https://control.example.com"],
      },
      expected: { ok: false as const, reason: "host missing or invalid" },
    },
  ])("$name", ({ input, expected }) => {
    expect(checkBrowserRequestHost(input)).toEqual(expected);
  });
});
