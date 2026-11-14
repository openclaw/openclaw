// Proxy capture env tests cover environment variable generation for capture sessions.
import fs from "node:fs";
import { Agent } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execNodeEvalSync } from "../test-utils/node-process.js";
import {
  createDebugProxyWebSocketAgent,
  resolveDebugProxySettings,
  resolveEffectiveDebugProxyUrl,
} from "./env.js";

const { createAmbientNodeProxyAgent, loadProxyline } = vi.hoisted(() => {
  const createAgent = vi.fn();
  return {
    createAmbientNodeProxyAgent: createAgent,
    loadProxyline: vi.fn(() => ({ createAmbientNodeProxyAgent: createAgent })),
  };
});
vi.mock("../infra/net/proxyline-runtime.js", () => ({ loadProxyline }));

const OPENCLAW_DEBUG_PROXY_ENABLED = "OPENCLAW_DEBUG_PROXY_ENABLED";
const OPENCLAW_DEBUG_PROXY_SESSION_ID = "OPENCLAW_DEBUG_PROXY_SESSION_ID";

it("leaves Proxyline unloaded until proxy capture is requested in a fresh process", () => {
  const output = execNodeEvalSync(
    `
      import assert from "node:assert/strict";
      import { registerHooks } from "node:module";
      let loads = 0;
      const hook = registerHooks({
        resolve(specifier, context, nextResolve) {
          if (specifier === "@openclaw/proxyline") loads++;
          return nextResolve(specifier, context);
        },
      });
      let agent;
      try {
        const capture = await import(${JSON.stringify(new URL("./env.ts", import.meta.url).href)});
        const apns = await import(${JSON.stringify(new URL("../infra/push-apns-http2.ts", import.meta.url).href)});
        assert.equal(loads, 0, "capture and direct APNs imports must leave Proxyline unloaded");
        await assert.rejects(apns.connectApnsHttp2Session({
          authority: "https://api.push.apple.com",
          timeoutMs: 1000,
          signal: AbortSignal.abort(new Error("fixture cancelled")),
        }), /fixture cancelled/);
        assert.equal(loads, 0, "cancelled direct APNs must leave Proxyline unloaded");
        agent = capture.createDebugProxyWebSocketAgent({
          ...capture.resolveDebugProxySettings({}),
          enabled: true,
          proxyUrl: "http://capture.example.test:8080",
        });
        assert.ok(agent);
        assert.equal(loads, 1, "capture must load the real synchronous proxy factory");
        console.log("ok");
      } finally {
        agent?.destroy();
        hook.deregister();
      }
    `,
    { imports: ["tsx"] },
  );
  expect(output.trim()).toBe("ok");
});

describe("createDebugProxyWebSocketAgent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    { enabled: false, proxyUrl: "http://capture.example.test:8080" },
    { enabled: true, proxyUrl: undefined },
  ])("does not load proxy support for inactive settings %j", (settings) => {
    expect(
      createDebugProxyWebSocketAgent({ ...resolveDebugProxySettings({}), ...settings }),
    ).toBeUndefined();
    expect(loadProxyline).not.toHaveBeenCalled();
  });

  it("creates the capture agent synchronously with only the explicit proxy environment", () => {
    const agent = new Agent();
    createAmbientNodeProxyAgent.mockReturnValue(agent);
    const proxyUrl = "http://capture.example.test:8080";
    try {
      expect(
        createDebugProxyWebSocketAgent({
          ...resolveDebugProxySettings({}),
          enabled: true,
          proxyUrl,
        }),
      ).toBe(agent);
      expect(loadProxyline).toHaveBeenCalledOnce();
      expect(createAmbientNodeProxyAgent).toHaveBeenCalledExactlyOnceWith({
        protocol: "https",
        env: {
          HTTP_PROXY: proxyUrl,
          HTTPS_PROXY: proxyUrl,
          ALL_PROXY: undefined,
          NO_PROXY: undefined,
          http_proxy: undefined,
          https_proxy: undefined,
          all_proxy: undefined,
          no_proxy: undefined,
        },
      });
    } finally {
      agent.destroy();
    }
  });
});

describe("resolveDebugProxySettings", () => {
  it("keeps an implicit debug proxy session id stable within one process", () => {
    const env = {
      [OPENCLAW_DEBUG_PROXY_ENABLED]: "1",
    } satisfies NodeJS.ProcessEnv;

    const first = resolveDebugProxySettings(env);
    const second = resolveDebugProxySettings(env);

    expect(first.sessionId).toBe(second.sessionId);
  });

  it("prefers an explicit session id from the environment", () => {
    const settings = resolveDebugProxySettings({
      [OPENCLAW_DEBUG_PROXY_ENABLED]: "1",
      [OPENCLAW_DEBUG_PROXY_SESSION_ID]: "session-explicit",
    });

    expect(settings.sessionId).toBe("session-explicit");
  });
});

describe("resolveEffectiveDebugProxyUrl", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("does not discover capture paths while disabled and retains configured URL precedence", () => {
    vi.stubEnv("OPENCLAW_TEST_FAST", "0");
    vi.stubEnv("OPENCLAW_STATE_DIR", undefined);
    vi.stubEnv(OPENCLAW_DEBUG_PROXY_ENABLED, "0");
    vi.stubEnv("OPENCLAW_DEBUG_PROXY_URL", "http://ambient.example.test:8080");
    const existsSync = vi.spyOn(fs, "existsSync");

    expect(resolveEffectiveDebugProxyUrl()).toBeUndefined();
    expect(resolveEffectiveDebugProxyUrl(" http://configured.example.test:8080 ")).toBe(
      "http://configured.example.test:8080",
    );
    expect(existsSync).not.toHaveBeenCalled();

    vi.stubEnv(OPENCLAW_DEBUG_PROXY_ENABLED, "1");
    expect(resolveEffectiveDebugProxyUrl()).toBe("http://ambient.example.test:8080");
    expect(resolveEffectiveDebugProxyUrl("http://configured.example.test:8080")).toBe(
      "http://configured.example.test:8080",
    );
    vi.stubEnv(OPENCLAW_DEBUG_PROXY_ENABLED, "0");
    expect(resolveEffectiveDebugProxyUrl()).toBeUndefined();
  });
});
