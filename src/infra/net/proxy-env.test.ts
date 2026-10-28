import { expect, it } from "vitest";
import {
  hasEnvHttpProxyConfigured,
  hasEnvHttpProxyAgentConfigured,
  hasProxyEnvConfigured,
  matchesNoProxy,
  resolveEnvHttpProxyAgentOptions,
  resolveEnvHttpProxyUrl,
  shouldUseEnvHttpProxyForUrl,
} from "./proxy-env.js";

it("ignores blank proxy values", () => {
  expect(hasProxyEnvConfigured({ HTTP_PROXY: "   ", all_proxy: "" })).toBe(false);
});
it("treats empty lower-case https_proxy as authoritative over upper-case HTTPS_PROXY", () => {
  const env = {
    https_proxy: "",
    HTTPS_PROXY: "http://upper.test:8080",
  };
  expect(resolveEnvHttpProxyUrl("https", env)).toBeUndefined();
  expect(hasEnvHttpProxyConfigured("https", env)).toBe(false);
});
it.each([
  [
    { ALL_PROXY: "socks5://all-proxy.test:1080" },
    {
      httpProxy: "socks5://all-proxy.test:1080",
      httpsProxy: "socks5://all-proxy.test:1080",
    },
  ],
  [{ all_proxy: "", ALL_PROXY: "socks5://upper-all-proxy.test:1080" }, undefined],
] as const)("resolves proxy-agent options for %j", (env, expected) => {
  expect(resolveEnvHttpProxyAgentOptions(env)).toEqual(expected);
  expect(hasEnvHttpProxyAgentConfigured(env)).toBe(expected !== undefined);
});
it.each([
  ["https://api.openai.com/v1/chat", "*", true],
  ["https://notopenai.com/v1", "openai.com", false],
  ["https://api.openai.com", "localhost, 127.0.0.1\tapi.openai.com", true],
  ["http://[::1]:8080/health", "[::1]:8080", true],
  ["http://0.0.0.0/", "0.*", true],
  ["http://255.128.64.32/", "255.*.64.32", true],
  ["http://255.128.64.32/", "0.0.0.0/0", true],
  ["http://255.128.64.32/", "255.128.64.32/32", true],
  ["http://8.1.2.3:8990/v1/messages", "8.*.8.8", false],
  ["not-a-url", "*", false],
])("matchesNoProxy(%s, %s) = %s", (url, noProxy, expected) => {
  expect(matchesNoProxy(url, { NO_PROXY: noProxy })).toBe(expected);
});
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
  ["http://api.example.com/v1", { HTTP_PROXY: "http://proxy.test:8080" }, true],
  ["file:///tmp/input.txt", { HTTPS_PROXY: "http://proxy.test:8080" }, false],
] as const)("uses the env proxy for %s: %s → %s", (url, env, expected) => {
  expect(shouldUseEnvHttpProxyForUrl(url, env)).toBe(expected);
});
