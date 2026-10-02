// Node proxy agent tests cover shared Node HTTP(S) proxy agent construction.
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { createNodeProxyAgent, resolveEnvNodeProxyUrlForTarget } from "./node-proxy-agent.js";

const PROXY_ENV_KEYS = [
  "http_proxy",
  "HTTP_PROXY",
  "https_proxy",
  "HTTPS_PROXY",
  "all_proxy",
  "ALL_PROXY",
  "no_proxy",
  "NO_PROXY",
] as const;

function withProxyEnv<T>(
  env: Partial<Record<(typeof PROXY_ENV_KEYS)[number], string | undefined>>,
  fn: () => T,
): T {
  const previousEnv = process.env;
  const scopedEnv = { ...previousEnv };
  for (const key of PROXY_ENV_KEYS) {
    const value = env[key];
    if (value === undefined) {
      delete scopedEnv[key];
    } else {
      scopedEnv[key] = value;
    }
  }
  // These agents consume JS env values; keep their fixtures out of Bun's native fetch proxy cache.
  process.env = scopedEnv;
  try {
    return fn();
  } finally {
    process.env = previousEnv;
  }
}

describe("resolveEnvNodeProxyUrlForTarget", () => {
  it("rereads proxy and bypass settings for each request", () => {
    const target = new URL("https://api.example.test/v1");
    const env: NodeJS.ProcessEnv = { HTTPS_PROXY: "http://proxy.example:8080" };

    expect(resolveEnvNodeProxyUrlForTarget(target, env)?.href).toBe("http://proxy.example:8080/");
    env.NO_PROXY = "example.test";
    expect(resolveEnvNodeProxyUrlForTarget(target, env)).toBeUndefined();
    env.no_proxy = "";
    expect(resolveEnvNodeProxyUrlForTarget(target, env)?.href).toBe("http://proxy.example:8080/");
    env.https_proxy = "";
    expect(resolveEnvNodeProxyUrlForTarget(target, env)).toBeUndefined();
  });

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
});

describe("createNodeProxyAgent", () => {
  it.each(["explicit", "env"] as const)(
    "uses native Node option defaults for %s proxies",
    (mode) => {
      withProxyEnv({ HTTPS_PROXY: "http://proxy.example:8080" }, () => {
        const agentOptions = { keepAliveMsecs: 0, maxSockets: 0, maxFreeSockets: 0 };
        const agent =
          mode === "explicit"
            ? createNodeProxyAgent({ mode, proxyUrl: "http://proxy.example:8080", agentOptions })
            : createNodeProxyAgent({
                mode,
                targetUrl: "https://collector.example.test",
                agentOptions,
              });
        try {
          expect(agent).toMatchObject({
            keepAliveMsecs: 1000,
            maxSockets: Infinity,
            maxFreeSockets: 256,
          });
        } finally {
          agent?.destroy();
        }
      });
    },
  );

  it("rejects an invalid total socket limit during construction", () => {
    expect(() =>
      createNodeProxyAgent({
        mode: "explicit",
        proxyUrl: "http://proxy.example:8080",
        agentOptions: { maxTotalSockets: 0 },
      }),
    ).toThrow(RangeError);
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
    withProxyEnv({ HTTP_PROXY: "socks5://proxy.example:1080" }, () => {
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
  });

  it.each(["env", "explicit"] as const)(
    "keeps malformed %s proxy credentials out of errors",
    (mode) => {
      const proxyUrl = "https://qa-user:qa-password@[invalid";
      withProxyEnv({ HTTPS_PROXY: proxyUrl }, () => {
        let error: unknown;
        try {
          if (mode === "env") {
            createNodeProxyAgent({ mode, targetUrl: "https://collector.example.test" });
          } else {
            createNodeProxyAgent({ mode, proxyUrl });
          }
        } catch (cause) {
          error = cause;
        }
        expect(error).toMatchObject({ message: expect.stringContaining("Invalid proxy URL") });
        const rendered = inspect(error, { depth: null });
        expect(rendered).not.toContain("qa-user");
        expect(rendered).not.toContain("qa-password");
      });
    },
  );

  it("preserves caller Node agent options on env proxy agents", () => {
    withProxyEnv({ HTTPS_PROXY: "http://proxy.example:8080" }, () => {
      const agent = createNodeProxyAgent({
        mode: "env",
        targetUrl: "https://collector.example.test/v1/traces",
        agentOptions: {
          keepAlive: true,
          keepAliveMsecs: 750,
          maxSockets: 3,
          maxTotalSockets: 6,
          maxFreeSockets: 2,
          scheduling: "fifo",
          timeout: 5000,
          ca: "collector-ca",
          cert: "collector-cert",
          key: "collector-key",
        },
      });

      const agentState = agent as
        | {
            options?: {
              keepAlive?: boolean;
              ca?: string;
              cert?: string;
              key?: string;
            };
            keepAlive?: boolean;
          }
        | undefined;
      expect(agentState?.options).toMatchObject({
        keepAlive: true,
        timeout: 5000,
        ca: "collector-ca",
        cert: "collector-cert",
        key: "collector-key",
      });
      expect(agentState?.keepAlive).toBe(true);
      expect(agent).toMatchObject({
        keepAliveMsecs: 750,
        maxSockets: 3,
        maxTotalSockets: 6,
        maxFreeSockets: 2,
        scheduling: "fifo",
      });
      agent?.destroy();
    });
  });
});
