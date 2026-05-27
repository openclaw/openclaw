import { describe, expect, it } from "vitest";
import {
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
  it.each([
    {
      name: "uses lower-case https_proxy before upper-case HTTPS_PROXY",
      protocol: "https" as const,
      env: {
        https_proxy: "http://lower.test:8080",
        HTTPS_PROXY: "http://upper.test:8080",
      } as NodeJS.ProcessEnv,
      expectedUrl: "http://lower.test:8080",
      expectedConfigured: true,
    },
    {
      name: "treats empty lower-case https_proxy as authoritative over upper-case HTTPS_PROXY",
      protocol: "https" as const,
      env: {
        https_proxy: "",
        HTTPS_PROXY: "http://upper.test:8080",
      } as NodeJS.ProcessEnv,
      expectedUrl: undefined,
      expectedConfigured: false,
    },
    {
      name: "treats empty lower-case http_proxy as authoritative over upper-case HTTP_PROXY",
      protocol: "http" as const,
      env: {
        http_proxy: "   ",
        HTTP_PROXY: "http://upper-http.test:8080",
      } as NodeJS.ProcessEnv,
      expectedUrl: undefined,
      expectedConfigured: false,
    },
    {
      name: "falls back from HTTPS proxy vars to HTTP proxy vars for https requests",
      protocol: "https" as const,
      env: {
        HTTP_PROXY: "http://upper-http.test:8080",
      } as NodeJS.ProcessEnv,
      expectedUrl: "http://upper-http.test:8080",
      expectedConfigured: true,
    },
    {
      name: "does not use ALL_PROXY for EnvHttpProxyAgent-style resolution",
      protocol: "https" as const,
      env: {
        ALL_PROXY: "http://all-proxy.test:8080",
        all_proxy: "http://lower-all-proxy.test:8080",
      } as NodeJS.ProcessEnv,
      expectedUrl: undefined,
      expectedConfigured: false,
    },
    {
      name: "returns only HTTP proxies for http requests",
      protocol: "http" as const,
      env: {
        https_proxy: "http://lower-https.test:8080",
        http_proxy: "http://lower-http.test:8080",
      } as NodeJS.ProcessEnv,
      expectedUrl: "http://lower-http.test:8080",
      expectedConfigured: true,
    },
  ])("$name", ({ protocol, env, expectedUrl, expectedConfigured }) => {
    expect(resolveEnvHttpProxyUrl(protocol, env)).toBe(expectedUrl);
    expect(hasEnvHttpProxyConfigured(protocol, env)).toBe(expectedConfigured);
  });
});
