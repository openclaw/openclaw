import { describe, expect, it } from "vitest";
import {
  hasEnvHttpProxyRouteForUrl,
  hasEnvHttpProxyConfigured,
  hasProxyEnvConfigured,
  resolveEnvHttpProxyUrl,
} from "./proxy-env.js";

describe("hasProxyEnvConfigured", () => {
  it.each([
    {
      name: "detects upper-case HTTP proxy values",
      env: { HTTP_PROXY: "http://upper-http.test:8080" } as NodeJS.ProcessEnv,
      expected: true,
    },
    {
      name: "detects lower-case all_proxy values",
      env: { all_proxy: "socks5://proxy.test:1080" } as NodeJS.ProcessEnv,
      expected: true,
    },
    {
      name: "ignores blank proxy values",
      env: { HTTP_PROXY: "   ", all_proxy: "" } as NodeJS.ProcessEnv,
      expected: false,
    },
  ])("$name", ({ env, expected }) => {
    expect(hasProxyEnvConfigured(env)).toBe(expected);
  });
});

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

  it("does not use ALL_PROXY for EnvHttpProxyAgent-style resolution", () => {
    const env = {
      ALL_PROXY: "http://all-proxy.test:8080",
      all_proxy: "http://lower-all-proxy.test:8080",
    } as NodeJS.ProcessEnv;

    expect(resolveEnvHttpProxyUrl("https", env)).toBeUndefined();
    expect(resolveEnvHttpProxyUrl("http", env)).toBeUndefined();
    expect(hasEnvHttpProxyConfigured("https", env)).toBe(false);
  });

  it("returns only HTTP proxies for http requests", () => {
    const env = {
      https_proxy: "http://lower-https.test:8080",
      http_proxy: "http://lower-http.test:8080",
    } as NodeJS.ProcessEnv;

    expect(resolveEnvHttpProxyUrl("http", env)).toBe("http://lower-http.test:8080");
  });
});

describe("hasEnvHttpProxyRouteForUrl", () => {
  it("returns true when HTTPS env proxy is configured and target is not bypassed", () => {
    const env = {
      HTTPS_PROXY: "http://proxy.test:8080",
    } as NodeJS.ProcessEnv;
    expect(hasEnvHttpProxyRouteForUrl("https://public.example/resource", env)).toBe(true);
  });

  it("returns false when only ALL_PROXY is configured", () => {
    const env = {
      ALL_PROXY: "http://proxy.test:8080",
    } as NodeJS.ProcessEnv;
    expect(hasEnvHttpProxyRouteForUrl("https://public.example/resource", env)).toBe(false);
  });

  it("returns false when NO_PROXY bypasses the target hostname", () => {
    const env = {
      HTTPS_PROXY: "http://proxy.test:8080",
      NO_PROXY: "public.example",
    } as NodeJS.ProcessEnv;
    expect(hasEnvHttpProxyRouteForUrl("https://public.example/resource", env)).toBe(false);
  });

  it("treats lower-case no_proxy as authoritative over upper-case NO_PROXY", () => {
    const env = {
      HTTPS_PROXY: "http://proxy.test:8080",
      no_proxy: "",
      NO_PROXY: "public.example",
    } as NodeJS.ProcessEnv;
    expect(hasEnvHttpProxyRouteForUrl("https://public.example/resource", env)).toBe(true);
  });

  it("honors NO_PROXY host:port entries", () => {
    const env = {
      HTTPS_PROXY: "http://proxy.test:8080",
      NO_PROXY: "public.example:8443",
    } as NodeJS.ProcessEnv;
    expect(hasEnvHttpProxyRouteForUrl("https://public.example/resource", env)).toBe(true);
    expect(hasEnvHttpProxyRouteForUrl("https://public.example:8443/resource", env)).toBe(false);
  });

  it("does not treat URL-shaped NO_PROXY tokens as hostname bypass entries", () => {
    const env = {
      HTTPS_PROXY: "http://proxy.test:8080",
      NO_PROXY: "https://public.example",
    } as NodeJS.ProcessEnv;
    expect(hasEnvHttpProxyRouteForUrl("https://public.example/resource", env)).toBe(true);
  });

  it("treats wildcard bypass as global only when NO_PROXY is exactly '*'", () => {
    const env = {
      HTTPS_PROXY: "http://proxy.test:8080",
      NO_PROXY: "*,public.example",
    } as NodeJS.ProcessEnv;
    expect(hasEnvHttpProxyRouteForUrl("https://unrelated.example/resource", env)).toBe(true);
  });
});
