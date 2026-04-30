// Integration tests for SSRF policy enforcement at the web-guarded-fetch boundary.
// These tests do NOT mock fetchWithSsrFGuard — they exercise the real guard logic to
// confirm that the policy assigned to each endpoint wrapper produces the expected
// allow/block behaviour for private network addresses.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LookupFn } from "../../infra/net/ssrf.js";
import {
  withSelfHostedWebToolsEndpoint,
  withTrustedWebToolsEndpoint,
} from "./web-guarded-fetch.js";

const PROXY_VARS = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "http_proxy",
  "https_proxy",
  "NO_PROXY",
  "no_proxy",
  "ALL_PROXY",
  "all_proxy",
] as const;

function makeLookup(address: string): LookupFn {
  return vi.fn(async () => [{ address, family: 4 }]) as unknown as LookupFn;
}

describe("web-guarded-fetch SSRF policy integration", () => {
  let savedProxyEnv: Partial<Record<string, string>>;

  beforeEach(() => {
    savedProxyEnv = {};
    for (const key of PROXY_VARS) {
      savedProxyEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of PROXY_VARS) {
      const saved = savedProxyEnv[key];
      if (saved === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = saved;
      }
    }
    vi.clearAllMocks();
  });

  describe("withTrustedWebToolsEndpoint", () => {
    it("blocks requests to private IPv4 literals without calling fetch", async () => {
      const fetchImpl = vi.fn();
      await expect(
        withTrustedWebToolsEndpoint(
          { url: "http://127.0.0.1:8080/internal", fetchImpl },
          async () => undefined,
        ),
      ).rejects.toThrow(/private|internal|blocked/i);
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it("blocks requests to RFC-1918 private IPv4 literals without calling fetch", async () => {
      const fetchImpl = vi.fn();
      await expect(
        withTrustedWebToolsEndpoint(
          { url: "http://192.168.1.1/admin", fetchImpl },
          async () => undefined,
        ),
      ).rejects.toThrow(/private|internal|blocked/i);
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it("blocks requests when DNS resolves a hostname to a private address", async () => {
      const fetchImpl = vi.fn();
      const lookupFn = makeLookup("10.0.0.1");
      await expect(
        withTrustedWebToolsEndpoint(
          { url: "https://internal.corp/api", fetchImpl, lookupFn },
          async () => undefined,
        ),
      ).rejects.toThrow(/private|internal|blocked/i);
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it("blocks redirect chains that hop to private hosts", async () => {
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(
          new Response(null, { status: 302, headers: { location: "http://127.0.0.1:6379/" } }),
        );
      const lookupFn = makeLookup("93.184.216.34");
      await expect(
        withTrustedWebToolsEndpoint(
          { url: "https://public.example/start", fetchImpl, lookupFn },
          async () => undefined,
        ),
      ).rejects.toThrow(/private|internal|blocked/i);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it("allows requests to public cloud API endpoints", async () => {
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({ results: [] }), { status: 200 }));
      const lookupFn = makeLookup("93.184.216.34");
      const result = await withTrustedWebToolsEndpoint(
        { url: "https://api.search.example/v1/search", fetchImpl, lookupFn },
        async (res) => res.response.status,
      );
      expect(result).toBe(200);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });
  });

  describe("withSelfHostedWebToolsEndpoint", () => {
    it("allows requests to private IPv4 literals (self-hosted services)", async () => {
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({ results: [] }), { status: 200 }));
      const result = await withSelfHostedWebToolsEndpoint(
        { url: "http://192.168.1.100:8888/search", fetchImpl },
        async (res) => res.response.status,
      );
      expect(result).toBe(200);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it("allows requests to loopback addresses (self-hosted services)", async () => {
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({ results: [] }), { status: 200 }));
      const result = await withSelfHostedWebToolsEndpoint(
        { url: "http://127.0.0.1:8080/search", fetchImpl },
        async (res) => res.response.status,
      );
      expect(result).toBe(200);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it("allows requests when DNS resolves a hostname to a private LAN address", async () => {
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({ results: [] }), { status: 200 }));
      const lookupFn = makeLookup("10.0.0.50");
      const result = await withSelfHostedWebToolsEndpoint(
        { url: "http://searxng.internal/search", fetchImpl, lookupFn },
        async (res) => res.response.status,
      );
      expect(result).toBe(200);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it("still allows requests to public endpoints", async () => {
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({ results: [] }), { status: 200 }));
      const lookupFn = makeLookup("93.184.216.34");
      const result = await withSelfHostedWebToolsEndpoint(
        { url: "https://public.example/search", fetchImpl, lookupFn },
        async (res) => res.response.status,
      );
      expect(result).toBe(200);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });
  });
});
