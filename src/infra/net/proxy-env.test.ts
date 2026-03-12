import { describe, expect, it } from "vitest";
import { hasEnvHttpProxyConfigured, resolveEnvHttpProxyUrl } from "./proxy-env.js";

describe("resolveEnvHttpProxyUrl", () => {
  it("uses lower-case https_proxy before upper-case HTTPS_PROXY", () => {
    const env = {
      https_proxy: "http://lower.test:8080",
      HTTPS_PROXY: "http://upper.test:8080",
    } as NodeJS.ProcessEnv;

    expect(resolveEnvHttpProxyUrl("https", env)).toBe("http://lower.test:8080");
  });

  it("treats empty lower-case https_proxy as authoritative over upper-case HTTPS_PROXY", () => {
    const env = {
      https_proxy: "",
      HTTPS_PROXY: "http://upper.test:8080",
    } as NodeJS.ProcessEnv;

    expect(resolveEnvHttpProxyUrl("https", env)).toBeUndefined();
    expect(hasEnvHttpProxyConfigured("https", env)).toBe(false);
  });

  it("treats empty lower-case http_proxy as authoritative over upper-case HTTP_PROXY", () => {
    const env = {
      http_proxy: "   ",
      HTTP_PROXY: "http://upper-http.test:8080",
    } as NodeJS.ProcessEnv;

    expect(resolveEnvHttpProxyUrl("http", env)).toBeUndefined();
    expect(hasEnvHttpProxyConfigured("http", env)).toBe(false);
  });

  it("falls back from HTTPS proxy vars to HTTP proxy vars for https requests", () => {
    const env = {
      HTTP_PROXY: "http://upper-http.test:8080",
    } as NodeJS.ProcessEnv;

    expect(resolveEnvHttpProxyUrl("https", env)).toBe("http://upper-http.test:8080");
    expect(hasEnvHttpProxyConfigured("https", env)).toBe(true);
  });
});
