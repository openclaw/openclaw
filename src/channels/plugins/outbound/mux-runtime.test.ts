import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import { __resetMuxRuntimeAuthCacheForTest, sendViaMux, sendTypingViaMux } from "./mux.js";

vi.mock("../../../infra/device-identity.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../infra/device-identity.js")>();
  return {
    ...actual,
    loadOrCreateDeviceIdentity: () => ({
      deviceId: "openclaw-instance-1",
      publicKeyPem: "test",
      privateKeyPem: "test",
    }),
  };
});

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  __resetMuxRuntimeAuthCacheForTest();
  vi.restoreAllMocks();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function runtimeMuxConfig(): OpenClawConfig {
  return {
    gateway: {
      port: 18_789,
      http: {
        endpoints: {
          mux: {
            baseUrl: "http://mux.local",
            registerKey: "register-shared-key",
            inboundUrl: "http://openclaw.local:18789/v1/mux/inbound",
          },
        },
      },
    },
    channels: {
      telegram: {
        mux: {
          enabled: true,
        },
      },
    },
  } as OpenClawConfig;
}

function parseJsonRequestBody(init: RequestInit): Record<string, unknown> {
  if (typeof init.body !== "string") {
    throw new Error("expected string request body");
  }
  return JSON.parse(init.body) as Record<string, unknown>;
}

function resolveFetchUrl(input: string | URL | Request): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  return input.url;
}

describe("mux runtime auth", () => {
  it("registers once and sends outbound request with runtime jwt auth", async () => {
    const now = Date.now();
    const fetchSpy = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = resolveFetchUrl(input);
      if (url === "http://mux.local/v1/instances/register") {
        expect(init?.headers).toEqual(
          expect.objectContaining({ Authorization: "Bearer register-shared-key" }),
        );
        expect(parseJsonRequestBody(init ?? {})).toMatchObject({
          openclawId: "openclaw-instance-1",
          inboundUrl: "http://openclaw.local:18789/v1/mux/inbound",
        });
        return jsonResponse({
          ok: true,
          runtimeToken: "runtime-token-1",
          expiresAtMs: now + 24 * 60 * 60 * 1000,
        });
      }
      if (url === "http://mux.local/v1/mux/outbound/send") {
        expect(init?.headers).toEqual(
          expect.objectContaining({
            Authorization: "Bearer runtime-token-1",
            "X-OpenClaw-Id": "openclaw-instance-1",
          }),
        );
        expect(parseJsonRequestBody(init ?? {})).toMatchObject({
          channel: "telegram",
          sessionKey: "tg:session:1",
          text: "hello runtime",
          openclawId: "openclaw-instance-1",
        });
        return jsonResponse({ messageId: "mx-1", chatId: "chat-1" });
      }
      throw new Error(`unexpected url ${url}`);
    });

    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const result = await sendViaMux({
      cfg: runtimeMuxConfig(),
      channel: "telegram",
      sessionKey: "tg:session:1",
      text: "hello runtime",
    });

    expect(result).toMatchObject({
      messageId: "mx-1",
      chatId: "chat-1",
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("reuses cached runtime token without registering on every request", async () => {
    const now = Date.now();
    const fetchSpy = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = resolveFetchUrl(input);
      if (url === "http://mux.local/v1/instances/register") {
        return jsonResponse({
          ok: true,
          openclawId: "openclaw-instance-1",
          runtimeToken: "runtime-token-cached",
          expiresAtMs: now + 24 * 60 * 60 * 1000,
        });
      }
      if (url === "http://mux.local/v1/mux/outbound/send") {
        expect(init?.headers).toEqual(
          expect.objectContaining({ Authorization: "Bearer runtime-token-cached" }),
        );
        return jsonResponse({ messageId: `mx-${fetchSpy.mock.calls.length}` });
      }
      throw new Error(`unexpected url ${url}`);
    });

    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    await sendViaMux({
      cfg: runtimeMuxConfig(),
      channel: "telegram",
      sessionKey: "tg:session:1",
      text: "first",
    });
    await sendTypingViaMux({
      cfg: runtimeMuxConfig(),
      channel: "telegram",
      sessionKey: "tg:session:1",
    });

    const urls = fetchSpy.mock.calls.map((call) => resolveFetchUrl(call[0]));
    expect(urls.filter((url) => url.endsWith("/v1/instances/register"))).toHaveLength(1);
    expect(urls.filter((url) => url.endsWith("/v1/mux/outbound/send"))).toHaveLength(2);
  });

  it("re-registers and retries once when runtime token is rejected", async () => {
    const now = Date.now();
    let registerCount = 0;
    let outboundCount = 0;

    const fetchSpy = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = resolveFetchUrl(input);
      if (url === "http://mux.local/v1/instances/register") {
        registerCount += 1;
        return jsonResponse({
          ok: true,
          openclawId: "openclaw-instance-1",
          runtimeToken: registerCount === 1 ? "runtime-token-old" : "runtime-token-new",
          expiresAtMs: now + 24 * 60 * 60 * 1000,
        });
      }
      if (url === "http://mux.local/v1/mux/outbound/send") {
        outboundCount += 1;
        const authHeader = (init?.headers as Record<string, string> | undefined)?.Authorization;
        if (outboundCount === 1) {
          expect(authHeader).toBe("Bearer runtime-token-old");
          return jsonResponse({ ok: false, error: "unauthorized" }, 401);
        }
        expect(authHeader).toBe("Bearer runtime-token-new");
        return jsonResponse({ messageId: "mx-retry-1" });
      }
      throw new Error(`unexpected url ${url}`);
    });

    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const result = await sendViaMux({
      cfg: runtimeMuxConfig(),
      channel: "telegram",
      sessionKey: "tg:session:1",
      text: "retry please",
    });

    expect(result.messageId).toBe("mx-retry-1");
    expect(registerCount).toBe(2);
    expect(outboundCount).toBe(2);
  });
});
