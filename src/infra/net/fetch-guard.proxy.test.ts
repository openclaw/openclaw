import { afterEach, describe, expect, it } from "vitest";
import { resolveProxyUrl, shouldBypassProxy } from "./fetch-guard.js";

describe("shouldBypassProxy", () => {
  afterEach(() => {
    delete process.env.NO_PROXY;
    delete process.env.no_proxy;
  });

  it("returns false when NO_PROXY is not set", () => {
    expect(shouldBypassProxy("example.com")).toBe(false);
  });

  it("matches exact hostname", () => {
    process.env.NO_PROXY = "example.com";
    expect(shouldBypassProxy("example.com")).toBe(true);
    expect(shouldBypassProxy("other.com")).toBe(false);
  });

  it("matches case-insensitively", () => {
    process.env.NO_PROXY = "Example.COM";
    expect(shouldBypassProxy("example.com")).toBe(true);
    expect(shouldBypassProxy("EXAMPLE.COM")).toBe(true);
  });

  it("matches dot-prefixed suffix (.example.com)", () => {
    process.env.NO_PROXY = ".example.com";
    expect(shouldBypassProxy("sub.example.com")).toBe(true);
    expect(shouldBypassProxy("deep.sub.example.com")).toBe(true);
    expect(shouldBypassProxy("example.com")).toBe(false);
    expect(shouldBypassProxy("notexample.com")).toBe(false);
  });

  it("matches bare suffix (example.com matches sub.example.com)", () => {
    process.env.NO_PROXY = "example.com";
    expect(shouldBypassProxy("sub.example.com")).toBe(true);
    expect(shouldBypassProxy("notexample.com")).toBe(false);
  });

  it("matches wildcard *", () => {
    process.env.NO_PROXY = "*";
    expect(shouldBypassProxy("anything.example.com")).toBe(true);
  });

  it("handles comma-separated entries", () => {
    process.env.NO_PROXY = "localhost, .internal.corp, api.example.com";
    expect(shouldBypassProxy("localhost")).toBe(true);
    expect(shouldBypassProxy("svc.internal.corp")).toBe(true);
    expect(shouldBypassProxy("api.example.com")).toBe(true);
    expect(shouldBypassProxy("external.com")).toBe(false);
  });

  it("ignores empty entries", () => {
    process.env.NO_PROXY = "localhost,,example.com,";
    expect(shouldBypassProxy("localhost")).toBe(true);
    expect(shouldBypassProxy("example.com")).toBe(true);
    expect(shouldBypassProxy("other.com")).toBe(false);
  });

  it("reads no_proxy (lowercase) as fallback", () => {
    process.env.no_proxy = "example.com";
    expect(shouldBypassProxy("example.com")).toBe(true);
  });

  it("prefers NO_PROXY over no_proxy", () => {
    process.env.NO_PROXY = "preferred.com";
    process.env.no_proxy = "fallback.com";
    expect(shouldBypassProxy("preferred.com")).toBe(true);
    expect(shouldBypassProxy("fallback.com")).toBe(false);
  });
});

describe("resolveProxyUrl", () => {
  afterEach(() => {
    delete process.env.HTTP_PROXY;
    delete process.env.http_proxy;
    delete process.env.HTTPS_PROXY;
    delete process.env.https_proxy;
    delete process.env.NO_PROXY;
    delete process.env.no_proxy;
  });

  it("returns undefined when skipProxy is true", () => {
    process.env.HTTPS_PROXY = "http://proxy:8080";
    expect(resolveProxyUrl({ skipProxy: true, protocol: "https:" })).toBeUndefined();
  });

  it("returns explicit proxyUrl regardless of env", () => {
    process.env.HTTPS_PROXY = "http://env-proxy:8080";
    expect(resolveProxyUrl({ proxyUrl: "http://explicit:9090", protocol: "https:" })).toBe(
      "http://explicit:9090",
    );
  });

  it("explicit proxyUrl bypasses NO_PROXY", () => {
    process.env.NO_PROXY = "*";
    expect(
      resolveProxyUrl({
        proxyUrl: "http://explicit:9090",
        protocol: "https:",
        hostname: "anything.com",
      }),
    ).toBe("http://explicit:9090");
  });

  it("returns undefined when hostname matches NO_PROXY", () => {
    process.env.HTTPS_PROXY = "http://proxy:8080";
    process.env.NO_PROXY = "example.com";
    expect(resolveProxyUrl({ protocol: "https:", hostname: "example.com" })).toBeUndefined();
  });

  it("returns HTTPS_PROXY for https: protocol", () => {
    process.env.HTTPS_PROXY = "http://https-proxy:8080";
    expect(resolveProxyUrl({ protocol: "https:" })).toBe("http://https-proxy:8080");
  });

  it("falls back from HTTPS_PROXY to HTTP_PROXY for https:", () => {
    process.env.HTTP_PROXY = "http://http-proxy:8080";
    expect(resolveProxyUrl({ protocol: "https:" })).toBe("http://http-proxy:8080");
  });

  it("returns HTTP_PROXY for http: protocol", () => {
    process.env.HTTP_PROXY = "http://http-proxy:8080";
    expect(resolveProxyUrl({ protocol: "http:" })).toBe("http://http-proxy:8080");
  });

  it("falls back from HTTP_PROXY to HTTPS_PROXY for http:", () => {
    process.env.HTTPS_PROXY = "http://https-proxy:8080";
    expect(resolveProxyUrl({ protocol: "http:" })).toBe("http://https-proxy:8080");
  });

  it("reads lowercase env vars", () => {
    process.env.https_proxy = "http://lower:8080";
    expect(resolveProxyUrl({ protocol: "https:" })).toBe("http://lower:8080");
  });

  it("prefers uppercase over lowercase env vars", () => {
    process.env.HTTPS_PROXY = "http://upper:8080";
    process.env.https_proxy = "http://lower:8080";
    expect(resolveProxyUrl({ protocol: "https:" })).toBe("http://upper:8080");
  });

  it("returns undefined when no proxy is configured", () => {
    expect(resolveProxyUrl({ protocol: "https:" })).toBeUndefined();
  });
});
