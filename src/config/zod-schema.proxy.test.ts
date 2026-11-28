import { describe, expect, it } from "vitest";
import { ProxyConfigSchema } from "./zod-schema.proxy.js";

describe("ProxyConfigSchema", () => {
  it("preserves a full HTTP forward proxy config", () => {
    const config = {
      enabled: false,
      proxyUrl: "http://127.0.0.1:3128",
      tls: { caFile: "/etc/openclaw/proxy-ca.pem" },
      loopbackMode: "gateway-only",
    };
    expect(ProxyConfigSchema.parse(config)).toEqual(config);
  });

  it("accepts TLS-to-proxy endpoints", () => {
    const proxyUrl = "https://proxy.example.com:8443";
    expect(ProxyConfigSchema.parse({ proxyUrl })?.proxyUrl).toBe(proxyUrl);
  });

  it.each(["socks5://127.0.0.1", "not-a-url"])("rejects non-HTTP proxy URL %s", (proxyUrl) => {
    const result = ProxyConfigSchema.safeParse({ proxyUrl });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path.join("."))).toContain("proxyUrl");
  });
});
