import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { inspect } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createNodeProxyAgent, resolveEnvNodeProxyUrlForTarget } from "./node-proxy-agent.js";

it("snapshots a URL target before reading bypass settings", () => {
  const target = new URL("wss://original.example/ws");
  const env = {
    HTTPS_PROXY: "http://proxy.example:8080",
    get no_proxy() {
      target.hostname = "changed.example";
      return "original.example:443";
    },
  };

  expect(resolveEnvNodeProxyUrlForTarget(target, env)).toBeUndefined();
  expect(resolveEnvNodeProxyUrlForTarget(target, env)?.href).toBe("http://proxy.example:8080/");
  expect(target.protocol).toBe("wss:");
});

describe("createNodeProxyAgent", () => {
  let previousEnv: NodeJS.ProcessEnv;
  beforeEach(() => {
    previousEnv = process.env;
    // Avoid Bun's native fetch proxy cache by replacing, rather than mutating, the real env.
    process.env = { ...previousEnv };
    for (const key of ["http_proxy", "https_proxy", "all_proxy", "no_proxy"]) {
      delete process.env[key];
      delete process.env[key.toUpperCase()];
    }
  });
  afterEach(() => {
    process.env = previousEnv;
  });
  it.each(["socks5://proxy.example:1080", new URL("socks5://proxy.example:1080")])(
    "rejects unsupported explicit proxy %s before creating a request",
    (proxyUrl) => {
      expect(() => createNodeProxyAgent({ mode: "explicit", proxyUrl })).toThrow(
        "Unsupported proxy protocol",
      );
    },
  );

  it("rejects unusable env proxies at either Node request boundary", () => {
    process.env.HTTP_PROXY = "socks5://proxy.example:1080";
    const agent = createNodeProxyAgent({ mode: "env" });
    expect(agent).toBeDefined();
    try {
      for (const request of [httpRequest, httpsRequest]) {
        expect(() => request({ hostname: "upload.invalid", agent }).destroy()).toThrow(
          "Unsupported proxy protocol",
        );
      }
    } finally {
      agent?.destroy();
    }
  });

  it.each(["env", "explicit"] as const)(
    "keeps malformed %s proxy credentials out of errors",
    (mode) => {
      const proxyUrl = "https://qa-user:qa-password@[invalid";
      process.env.HTTPS_PROXY = proxyUrl;
      const create = vi.fn(() =>
        mode === "env"
          ? createNodeProxyAgent({ mode, targetUrl: "https://collector.example.test" })
          : createNodeProxyAgent({ mode, proxyUrl }),
      );
      expect(create).toThrow("Invalid proxy URL");
      const error = create.mock.results[0]?.value;
      expect(inspect(error, { depth: null })).not.toMatch(/qa-user|qa-password/);
    },
  );

  it("preserves caller Node agent options on env proxy agents", () => {
    process.env.HTTPS_PROXY = "http://proxy.example:8080";
    const poolOptions = {
      keepAlive: true,
      maxSockets: 3,
    };
    const tlsOptions = {
      timeout: 5000,
      ca: "collector-ca",
      cert: "collector-cert",
      key: "collector-key",
    };
    const agent = createNodeProxyAgent({
      mode: "env",
      targetUrl: "https://collector.example.test/v1/traces",
      agentOptions: { ...poolOptions, ...tlsOptions },
    });
    expect(agent?.options).toMatchObject({ keepAlive: true, ...tlsOptions });
    expect(agent).toMatchObject(poolOptions);
    agent?.destroy();
  });
});
