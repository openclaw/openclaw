import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_PROXY_VALIDATION_ALLOWED_URLS,
  DEFAULT_PROXY_VALIDATION_DENIED_URLS,
  resolveProxyValidationConfig,
  runProxyValidation,
} from "./proxy-validation.js";

describe("proxy validation", () => {
  it("resolves proxy URL overrides before config and OPENCLAW_PROXY_URL", () => {
    const result = resolveProxyValidationConfig({
      proxyUrlOverride: "http://override-proxy.example:3128",
      config: {
        enabled: true,
        proxyUrl: "http://config-proxy.example:3128",
      },
      env: {
        OPENCLAW_PROXY_URL: "http://env-proxy.example:3128",
      },
    });

    expect(result).toEqual({
      enabled: true,
      proxyUrl: "http://override-proxy.example:3128",
      source: "override",
      errors: [],
    });
  });

  it("resolves config proxy URLs before OPENCLAW_PROXY_URL", () => {
    const result = resolveProxyValidationConfig({
      config: {
        enabled: true,
        proxyUrl: "http://config-proxy.example:3128",
      },
      env: {
        OPENCLAW_PROXY_URL: "http://env-proxy.example:3128",
      },
    });

    expect(result).toEqual({
      enabled: true,
      proxyUrl: "http://config-proxy.example:3128",
      source: "config",
      errors: [],
    });
  });

  it("uses OPENCLAW_PROXY_URL when enabled config has no URL", () => {
    const result = resolveProxyValidationConfig({
      config: { enabled: true },
      env: {
        OPENCLAW_PROXY_URL: "http://env-proxy.example:3128",
      },
    });

    expect(result).toEqual({
      enabled: true,
      proxyUrl: "http://env-proxy.example:3128",
      source: "env",
      errors: [],
    });
  });

  it("reports disabled proxy config when a config URL is present but proxy routing is disabled", async () => {
    const fetchCheck = vi.fn();

    const result = await runProxyValidation({
      config: {
        enabled: false,
        proxyUrl: "http://config-proxy.example:3128",
      },
      env: {},
      fetchCheck,
    });

    expect(fetchCheck).not.toHaveBeenCalled();
    expect(result).toEqual({
      ok: false,
      config: {
        enabled: false,
        proxyUrl: "http://config-proxy.example:3128",
        source: "config",
        errors: ["proxy validation requires proxy.enabled to be true for configured proxy URLs"],
      },
      checks: [],
    });
  });

  it("reports disabled proxy config when only OPENCLAW_PROXY_URL is present", async () => {
    const fetchCheck = vi.fn();

    const result = await runProxyValidation({
      config: {},
      env: {
        OPENCLAW_PROXY_URL: "http://env-proxy.example:3128",
      },
      fetchCheck,
    });

    expect(fetchCheck).not.toHaveBeenCalled();
    expect(result).toEqual({
      ok: false,
      config: {
        enabled: false,
        proxyUrl: "http://env-proxy.example:3128",
        source: "env",
        errors: ["proxy validation requires proxy.enabled to be true for OPENCLAW_PROXY_URL"],
      },
      checks: [],
    });
  });

  it("allows explicit proxy URL overrides even when config proxy routing is disabled", async () => {
    const fetchCheck = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 200 })
      .mockRejectedValueOnce(new Error("blocked"));

    const result = await runProxyValidation({
      proxyUrlOverride: "http://override-proxy.example:3128",
      config: {
        enabled: false,
        proxyUrl: "http://config-proxy.example:3128",
      },
      env: {},
      allowedUrls: ["https://example.com/"],
      deniedUrls: ["http://127.0.0.1/"],
      fetchCheck,
    });

    expect(result.ok).toBe(true);
    expect(fetchCheck).toHaveBeenCalled();
  });

  it("reports missing URL when proxy validation is enabled without an effective URL", () => {
    const result = resolveProxyValidationConfig({
      config: { enabled: true },
      env: {},
    });

    expect(result.enabled).toBe(true);
    expect(result.proxyUrl).toBeUndefined();
    expect(result.source).toBe("missing");
    expect(result.errors).toEqual([
      "proxy validation requires proxy.proxyUrl, --proxy-url, or OPENCLAW_PROXY_URL",
    ]);
  });

  it("reports disabled proxy config as an actionable validation problem", async () => {
    const fetchCheck = vi.fn();

    const result = await runProxyValidation({
      config: {},
      env: {},
      fetchCheck,
    });

    expect(fetchCheck).not.toHaveBeenCalled();
    expect(result).toEqual({
      ok: false,
      config: {
        enabled: false,
        source: "disabled",
        errors: [
          "proxy validation requires proxy.enabled=true with proxy.proxyUrl or OPENCLAW_PROXY_URL, or --proxy-url",
        ],
      },
      checks: [],
    });
  });

  it("rejects non-http proxy URLs", () => {
    const result = resolveProxyValidationConfig({
      config: {
        enabled: true,
        proxyUrl: "https://proxy.example:3128",
      },
      env: {},
    });

    expect(result.errors).toEqual(["proxyUrl must use http://"]);
  });

  it("checks default allowed and denied destinations through the proxy", async () => {
    const fetchCheck = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 200 })
      .mockRejectedValueOnce(new Error("loopback blocked"))
      .mockRejectedValueOnce(new Error("metadata blocked"));

    const result = await runProxyValidation({
      config: {
        enabled: true,
        proxyUrl: "http://127.0.0.1:3128",
      },
      env: {},
      fetchCheck,
    });

    expect(fetchCheck).toHaveBeenCalledTimes(3);
    expect(fetchCheck).toHaveBeenNthCalledWith(1, {
      proxyUrl: "http://127.0.0.1:3128",
      targetUrl: DEFAULT_PROXY_VALIDATION_ALLOWED_URLS[0],
      timeoutMs: 5000,
    });
    expect(result.ok).toBe(true);
    expect(result.checks.map((check) => [check.kind, check.url, check.ok])).toEqual([
      ["allowed", DEFAULT_PROXY_VALIDATION_ALLOWED_URLS[0], true],
      ["denied", DEFAULT_PROXY_VALIDATION_DENIED_URLS[0], true],
      ["denied", DEFAULT_PROXY_VALIDATION_DENIED_URLS[1], true],
    ]);
  });

  it("passes denied checks when the proxy returns an explicit deny HTTP status", async () => {
    const result = await runProxyValidation({
      config: {
        enabled: true,
        proxyUrl: "http://127.0.0.1:3128",
      },
      env: {},
      allowedUrls: [],
      deniedUrls: ["http://127.0.0.1/"],
      fetchCheck: vi.fn().mockResolvedValue({ ok: false, status: 403 }),
    });

    expect(result.ok).toBe(true);
    expect(result.checks).toEqual([
      {
        kind: "denied",
        url: "http://127.0.0.1/",
        ok: true,
        status: 403,
      },
    ]);
  });

  it("fails denied checks when the destination returns a non-2xx HTTP status", async () => {
    const result = await runProxyValidation({
      config: {
        enabled: true,
        proxyUrl: "http://127.0.0.1:3128",
      },
      env: {},
      allowedUrls: [],
      deniedUrls: ["https://example.com/not-found"],
      fetchCheck: vi.fn().mockResolvedValue({ ok: false, status: 404 }),
    });

    expect(result.ok).toBe(false);
    expect(result.checks).toEqual([
      {
        kind: "denied",
        url: "https://example.com/not-found",
        ok: false,
        status: 404,
        error: "Denied destination returned HTTP 404; expected the proxy to block the connection",
      },
    ]);
  });

  it("fails invalid custom denied URLs before probing", async () => {
    const fetchCheck = vi.fn();

    const result = await runProxyValidation({
      config: {
        enabled: true,
        proxyUrl: "http://127.0.0.1:3128",
      },
      env: {},
      allowedUrls: [],
      deniedUrls: ["not a url"],
      fetchCheck,
    });

    expect(fetchCheck).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(result.checks).toEqual([
      {
        kind: "denied",
        url: "not a url",
        ok: false,
        error: "Invalid denied destination URL",
      },
    ]);
  });

  it("fails invalid custom allowed URLs before probing", async () => {
    const fetchCheck = vi.fn();

    const result = await runProxyValidation({
      config: {
        enabled: true,
        proxyUrl: "http://127.0.0.1:3128",
      },
      env: {},
      allowedUrls: ["not a url"],
      deniedUrls: [],
      fetchCheck,
    });

    expect(fetchCheck).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(result.checks).toEqual([
      {
        kind: "allowed",
        url: "not a url",
        ok: false,
        error: "Invalid allowed destination URL",
      },
    ]);
  });

  it("fails validation when a denied destination succeeds", async () => {
    const result = await runProxyValidation({
      config: {
        enabled: true,
        proxyUrl: "http://127.0.0.1:3128",
      },
      env: {},
      allowedUrls: ["https://example.com/"],
      deniedUrls: ["http://127.0.0.1/"],
      fetchCheck: vi.fn().mockResolvedValue({ ok: true, status: 200 }),
    });

    expect(result.ok).toBe(false);
    expect(result.checks).toEqual([
      {
        kind: "allowed",
        url: "https://example.com/",
        ok: true,
        status: 200,
      },
      {
        kind: "denied",
        url: "http://127.0.0.1/",
        ok: false,
        status: 200,
        error: "Denied destination returned HTTP 200; expected the proxy to block the connection",
      },
    ]);
  });
});
