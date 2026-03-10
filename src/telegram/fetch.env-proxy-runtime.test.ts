import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const EnvHttpProxyAgent = require("undici/lib/dispatcher/env-http-proxy-agent.js") as {
  new (opts?: Record<string, unknown>): Record<PropertyKey, unknown>;
};
const { kHttpsProxyAgent, kNoProxyAgent } = require("undici/lib/core/symbols.js") as {
  kHttpsProxyAgent: symbol;
  kNoProxyAgent: symbol;
};

function getOwnSymbolValue(
  target: Record<PropertyKey, unknown>,
  description: string,
): Record<string, unknown> | undefined {
  const symbol = Object.getOwnPropertySymbols(target).find(
    (entry) => entry.description === description,
  );
  const value = symbol ? target[symbol] : undefined;
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("undici env proxy semantics", () => {
  it("uses proxyTls rather than connect for proxied HTTPS transport settings", () => {
    vi.stubEnv("HTTPS_PROXY", "http://127.0.0.1:7890");
    const connect = {
      family: 4,
      autoSelectFamily: false,
    };

    const withoutProxyTls = new EnvHttpProxyAgent({ connect });
    const noProxyAgent = withoutProxyTls[kNoProxyAgent] as Record<PropertyKey, unknown>;
    const httpsProxyAgent = withoutProxyTls[kHttpsProxyAgent] as Record<PropertyKey, unknown>;

    expect(getOwnSymbolValue(noProxyAgent, "options")?.connect).toEqual(
      expect.objectContaining(connect),
    );
    expect(getOwnSymbolValue(httpsProxyAgent, "proxy tls settings")).toBeUndefined();

    const withProxyTls = new EnvHttpProxyAgent({
      connect,
      proxyTls: connect,
    });
    const httpsProxyAgentWithProxyTls = withProxyTls[kHttpsProxyAgent] as Record<
      PropertyKey,
      unknown
    >;

    expect(getOwnSymbolValue(httpsProxyAgentWithProxyTls, "proxy tls settings")).toEqual(
      expect.objectContaining(connect),
    );
  });
});
