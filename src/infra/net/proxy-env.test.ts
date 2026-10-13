// Proxy environment tests cover env precedence, EnvHttpProxyAgent options, and
// NO_PROXY host/port/CIDR matching.
import { describe, expect, it } from "vitest";
import {
  hasEnvHttpProxyConfigured,
  hasEnvHttpProxyAgentConfigured,
  hasProxyEnvConfigured,
  matchesNoProxy,
  resolveEnvHttpProxyAgentOptions,
  resolveEnvHttpProxyUrl,
  shouldUseEnvHttpProxyForUrl,
} from "./proxy-env.js";

describe("hasProxyEnvConfigured", () => {
  it.each([
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
      name: "treats empty lower-case https_proxy as authoritative over upper-case HTTPS_PROXY",
      protocol: "https" as const,
      env: {
        https_proxy: "",
        HTTPS_PROXY: "http://upper.test:8080",
      } as NodeJS.ProcessEnv,
      expectedUrl: undefined,
      expectedConfigured: false,
    },
  ])("$name", ({ protocol, env, expectedUrl, expectedConfigured }) => {
    expect(resolveEnvHttpProxyUrl(protocol, env)).toBe(expectedUrl);
    expect(hasEnvHttpProxyConfigured(protocol, env)).toBe(expectedConfigured);
  });
});

describe("resolveEnvHttpProxyAgentOptions", () => {
  it.each([
    {
      name: "uses ALL_PROXY for both protocols",
      env: { ALL_PROXY: "socks5://all-proxy.test:1080" } as NodeJS.ProcessEnv,
      expected: {
        httpProxy: "socks5://all-proxy.test:1080",
        httpsProxy: "socks5://all-proxy.test:1080",
      },
    },
    {
      name: "treats empty lower-case all_proxy as authoritative over upper-case ALL_PROXY",
      env: {
        all_proxy: "",
        ALL_PROXY: "socks5://upper-all-proxy.test:1080",
      } as NodeJS.ProcessEnv,
      expected: undefined,
    },
  ])("$name", ({ env, expected }) => {
    expect(resolveEnvHttpProxyAgentOptions(env)).toEqual(expected);
    expect(hasEnvHttpProxyAgentConfigured(env)).toBe(expected !== undefined);
  });
});

describe("matchesNoProxy", () => {
  it.each([
    {
      name: "matches wildcard",
      url: "https://api.openai.com/v1/chat",
      env: { NO_PROXY: "*" } as NodeJS.ProcessEnv,
      expected: true,
    },
    {
      name: "does not match when suffix is not a domain boundary",
      url: "https://notopenai.com/v1",
      env: { NO_PROXY: "openai.com" } as NodeJS.ProcessEnv,
      expected: false,
    },
    {
      name: "parses mixed comma-and-whitespace list",
      url: "https://api.openai.com",
      env: { NO_PROXY: "localhost, 127.0.0.1\tapi.openai.com" } as NodeJS.ProcessEnv,
      expected: true,
    },
    {
      name: "matches bracketed IPv6 literal",
      url: "http://[::1]:8080/health",
      env: { NO_PROXY: "[::1]:8080" } as NodeJS.ProcessEnv,
      expected: true,
    },
    {
      name: "matches zero-valued IPv4 addresses",
      url: "http://0.0.0.0/",
      env: { NO_PROXY: "0.*" } as NodeJS.ProcessEnv,
      expected: true,
    },
    {
      name: "matches high-bit IPv4 wildcard octets",
      url: "http://255.128.64.32/",
      env: { NO_PROXY: "255.*.64.32" } as NodeJS.ProcessEnv,
      expected: true,
    },
    {
      name: "matches IPv4 CIDR with a zero-length prefix",
      url: "http://255.128.64.32/",
      env: { NO_PROXY: "0.0.0.0/0" } as NodeJS.ProcessEnv,
      expected: true,
    },
    {
      name: "matches IPv4 CIDR with a full-length prefix",
      url: "http://255.128.64.32/",
      env: { NO_PROXY: "255.128.64.32/32" } as NodeJS.ProcessEnv,
      expected: true,
    },
    {
      name: "does not let non-final IPv4 wildcards ignore remaining octets",
      url: "http://8.1.2.3:8990/v1/messages",
      env: { NO_PROXY: "8.*.8.8" } as NodeJS.ProcessEnv,
      expected: false,
    },
    {
      name: "returns false for malformed target URL",
      url: "not-a-url",
      env: { NO_PROXY: "*" } as NodeJS.ProcessEnv,
      expected: false,
    },
  ])("$name", ({ url, env, expected }) => {
    expect(matchesNoProxy(url, env)).toBe(expected);
  });
});

describe("shouldUseEnvHttpProxyForUrl", () => {
  it.each([
    ["https://api.example.:8443/v1", "*.example.:8443", false],
    ["https://api.example.:8443/v1", "*.example.:443", true],
    ["https://api.example./v1", ".", true],
  ])("keeps NO_PROXY DNS-dot routing aligned for %s and %s", (url, noProxy, expected) => {
    expect(
      shouldUseEnvHttpProxyForUrl(url, {
        HTTPS_PROXY: "http://proxy.test:8080",
        NO_PROXY: noProxy,
      }),
    ).toBe(expected);
  });

  it.each([
    {
      name: "uses HTTP_PROXY for http URLs",
      url: "http://api.example.com/v1",
      env: { HTTP_PROXY: "http://proxy.test:8080" } as NodeJS.ProcessEnv,
      expected: true,
    },
    {
      name: "keeps strict mode for non-http URLs",
      url: "file:///tmp/input.txt",
      env: { HTTPS_PROXY: "http://proxy.test:8080" } as NodeJS.ProcessEnv,
      expected: false,
    },
  ])("$name", ({ url, env, expected }) => {
    expect(shouldUseEnvHttpProxyForUrl(url, env)).toBe(expected);
  });
});
