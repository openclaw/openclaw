// Covers proxy schema parsing and validation behavior.
import { describe, it, expect } from "vitest";
import { ProxyConfigSchema } from "./zod-schema.proxy.js";

function expectProxyConfigFailure(value: unknown) {
  const result = ProxyConfigSchema.safeParse(value);
  expect(result.success).toBe(false);
  if (result.success) {
    throw new Error("Expected proxy config to fail schema validation.");
  }
  return result.error.issues;
}

describe("ProxyConfigSchema", () => {
  it("accepts undefined (optional)", () => {
    expect(ProxyConfigSchema.parse(undefined)).toBeUndefined();
  });

  it("accepts an empty object", () => {
    expect(ProxyConfigSchema.parse({})).toStrictEqual({});
  });

  it("accepts a full valid config", () => {
    const config = {
      enabled: false,
      proxyUrl: "http://127.0.0.1:3128",
      tls: {
        caFile: "/etc/openclaw/proxy-ca.pem",
      },
      loopbackMode: "gateway-only",
    };
    expect(ProxyConfigSchema.parse(config)).toEqual(config);
  });

  it("accepts loopbackMode policy values", () => {
    expect(ProxyConfigSchema.parse({ loopbackMode: "gateway-only" })?.loopbackMode).toBe(
      "gateway-only",
    );
    expect(ProxyConfigSchema.parse({ loopbackMode: "proxy" })?.loopbackMode).toBe("proxy");
    expect(ProxyConfigSchema.parse({ loopbackMode: "block" })?.loopbackMode).toBe("block");
  });

  it("rejects unknown loopbackMode values", () => {
    const issues = expectProxyConfigFailure({ loopbackMode: "bypass" });
    expect(issues.map((issue) => issue.path.join("."))).toContain("loopbackMode");
  });

  it("accepts HTTPS proxy URLs for TLS-to-proxy endpoints", () => {
    const result = ProxyConfigSchema.parse({
      proxyUrl: "https://proxy.example.com:8443",
    });

    expect(result?.proxyUrl).toBe("https://proxy.example.com:8443");
  });

  it("rejects proxyUrl values that are not HTTP forward proxies", () => {
    const socksIssues = expectProxyConfigFailure({
      proxyUrl: "socks5://127.0.0.1",
    });
    const invalidUrlIssues = expectProxyConfigFailure({ proxyUrl: "not-a-url" });
    expect(socksIssues.map((issue) => issue.path.join("."))).toContain("proxyUrl");
    expect(invalidUrlIssues.map((issue) => issue.path.join("."))).toContain("proxyUrl");
  });

  it("rejects unknown keys (strict)", () => {
    const issues = expectProxyConfigFailure({ binaryPath: "/tmp/proxy" });
    expect(issues[0]?.code).toBe("unrecognized_keys");
  });

  it("rejects unknown proxy TLS keys", () => {
    expect(() =>
      ProxyConfigSchema.parse({
        proxyUrl: "https://proxy.example.com:8443",
        tls: {
          ca: "/etc/openclaw/proxy-ca.pem",
        },
      }),
    ).toThrow();
  });
});
