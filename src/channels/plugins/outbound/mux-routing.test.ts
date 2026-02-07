import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import { discordOutbound } from "./discord.js";
import { __resetMuxRuntimeAuthCacheForTest, sendTypingViaMux } from "./mux.js";
import { telegramOutbound } from "./telegram.js";
import { whatsappOutbound } from "./whatsapp.js";

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
const REGISTER_KEY = "register-shared-key";
const RUNTIME_TOKEN = "runtime-token-1";

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

function gatewayMuxConfig(): Pick<OpenClawConfig, "gateway"> {
  return {
    gateway: {
      http: {
        endpoints: {
          mux: {
            baseUrl: "http://mux.local",
            registerKey: REGISTER_KEY,
            inboundUrl: "http://openclaw.local/v1/mux/inbound",
          },
        },
      },
    },
  };
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

describe("mux outbound routing", () => {
  it("routes telegram outbound through mux when enabled", async () => {
    const fetchSpy = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = resolveFetchUrl(input);
      if (url === "http://mux.local/v1/instances/register") {
        expect(init?.headers).toEqual(
          expect.objectContaining({ Authorization: `Bearer ${REGISTER_KEY}` }),
        );
        return jsonResponse({
          ok: true,
          runtimeToken: RUNTIME_TOKEN,
          expiresAtMs: Date.now() + 24 * 60 * 60 * 1000,
        });
      }
      if (url === "http://mux.local/v1/mux/outbound/send") {
        return jsonResponse({ messageId: "mx-tg-1", chatId: "tg-chat-1" });
      }
      throw new Error(`unexpected url ${url}`);
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const sendTelegram = vi.fn();
    const cfg = {
      ...gatewayMuxConfig(),
      channels: {
        telegram: {
          mux: {
            enabled: true,
          },
        },
      },
    } as OpenClawConfig;

    const result = await telegramOutbound.sendText!({
      cfg,
      to: "telegram:123",
      text: "hello",
      sessionKey: "sess-tg",
      deps: { sendTelegram },
    });

    expect(sendTelegram).not.toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      channel: "telegram",
      messageId: "mx-tg-1",
      chatId: "tg-chat-1",
    });

    const sendCall = fetchSpy.mock.calls.find(
      ([callInput]) => resolveFetchUrl(callInput) === "http://mux.local/v1/mux/outbound/send",
    );
    expect(sendCall).toBeDefined();
    const [url, init] = sendCall as [string | URL | Request, RequestInit];
    expect(resolveFetchUrl(url)).toBe("http://mux.local/v1/mux/outbound/send");
    expect(init.headers).toEqual(
      expect.objectContaining({
        Authorization: `Bearer ${RUNTIME_TOKEN}`,
        "X-OpenClaw-Id": "openclaw-instance-1",
      }),
    );
    expect(parseJsonRequestBody(init)).toMatchObject({
      channel: "telegram",
      sessionKey: "sess-tg",
      to: "telegram:123",
      text: "hello",
    });
  });

  it("routes discord outbound through mux when enabled", async () => {
    const fetchSpy = vi.fn(async (input: string | URL | Request) => {
      const url = resolveFetchUrl(input);
      if (url === "http://mux.local/v1/instances/register") {
        return jsonResponse({
          ok: true,
          runtimeToken: RUNTIME_TOKEN,
          expiresAtMs: Date.now() + 24 * 60 * 60 * 1000,
        });
      }
      if (url === "http://mux.local/v1/mux/outbound/send") {
        return jsonResponse({ messageId: "mx-discord-1", channelId: "dc-channel-1" });
      }
      throw new Error(`unexpected url ${url}`);
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const sendDiscord = vi.fn();
    const cfg = {
      ...gatewayMuxConfig(),
      channels: {
        discord: {
          mux: {
            enabled: true,
          },
        },
      },
    } as OpenClawConfig;

    const result = await discordOutbound.sendText!({
      cfg,
      to: "discord:chan",
      text: "hello",
      sessionKey: "sess-discord",
      deps: { sendDiscord },
    });

    expect(sendDiscord).not.toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      channel: "discord",
      messageId: "mx-discord-1",
      channelId: "dc-channel-1",
    });

    const sendCall = fetchSpy.mock.calls.find(
      ([callInput]) => resolveFetchUrl(callInput) === "http://mux.local/v1/mux/outbound/send",
    );
    expect(sendCall).toBeDefined();
    const [url, init] = sendCall as [string | URL | Request, RequestInit];
    expect(resolveFetchUrl(url)).toBe("http://mux.local/v1/mux/outbound/send");
    expect(parseJsonRequestBody(init)).toMatchObject({
      channel: "discord",
      sessionKey: "sess-discord",
      to: "discord:chan",
      raw: {
        discord: {
          send: {
            text: "hello",
          },
        },
      },
    });
  });

  it("routes whatsapp outbound through mux when enabled", async () => {
    const fetchSpy = vi.fn(async (input: string | URL | Request) => {
      const url = resolveFetchUrl(input);
      if (url === "http://mux.local/v1/instances/register") {
        return jsonResponse({
          ok: true,
          runtimeToken: RUNTIME_TOKEN,
          expiresAtMs: Date.now() + 24 * 60 * 60 * 1000,
        });
      }
      if (url === "http://mux.local/v1/mux/outbound/send") {
        return jsonResponse({ messageId: "mx-wa-1", toJid: "jid-1" });
      }
      throw new Error(`unexpected url ${url}`);
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const sendWhatsApp = vi.fn();
    const cfg = {
      ...gatewayMuxConfig(),
      channels: {
        whatsapp: {
          mux: {
            enabled: true,
          },
        },
      },
    } as OpenClawConfig;

    const result = await whatsappOutbound.sendText!({
      cfg,
      to: "+15555550100",
      text: "hello",
      sessionKey: "sess-wa",
      deps: { sendWhatsApp },
    });

    expect(sendWhatsApp).not.toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ channel: "whatsapp", messageId: "mx-wa-1", toJid: "jid-1" });

    const sendCall = fetchSpy.mock.calls.find(
      ([callInput]) => resolveFetchUrl(callInput) === "http://mux.local/v1/mux/outbound/send",
    );
    expect(sendCall).toBeDefined();
    const [url, init] = sendCall as [string | URL | Request, RequestInit];
    expect(resolveFetchUrl(url)).toBe("http://mux.local/v1/mux/outbound/send");
    expect(parseJsonRequestBody(init)).toMatchObject({
      channel: "whatsapp",
      sessionKey: "sess-wa",
      to: "+15555550100",
      raw: {
        whatsapp: {
          send: {
            text: "hello",
          },
        },
      },
    });
  });

  it("routes telegram outbound through mux from default account config", async () => {
    const fetchSpy = vi.fn(async (input: string | URL | Request) => {
      const url = resolveFetchUrl(input);
      if (url === "http://mux.local/v1/instances/register") {
        return jsonResponse({
          ok: true,
          runtimeToken: RUNTIME_TOKEN,
          expiresAtMs: Date.now() + 24 * 60 * 60 * 1000,
        });
      }
      if (url === "http://mux.local/v1/mux/outbound/send") {
        return jsonResponse({ messageId: "mx-tg-acct-1" });
      }
      throw new Error(`unexpected url ${url}`);
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const cfg = {
      ...gatewayMuxConfig(),
      channels: {
        telegram: {
          accounts: {
            default: {
              mux: {
                enabled: true,
              },
            },
          },
        },
      },
    } as OpenClawConfig;

    await telegramOutbound.sendText!({
      cfg,
      to: "telegram:123",
      text: "hello",
      sessionKey: "sess-tg",
    });

    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("routes discord outbound through mux from default account config", async () => {
    const fetchSpy = vi.fn(async (input: string | URL | Request) => {
      const url = resolveFetchUrl(input);
      if (url === "http://mux.local/v1/instances/register") {
        return jsonResponse({
          ok: true,
          runtimeToken: RUNTIME_TOKEN,
          expiresAtMs: Date.now() + 24 * 60 * 60 * 1000,
        });
      }
      if (url === "http://mux.local/v1/mux/outbound/send") {
        return jsonResponse({ messageId: "mx-discord-acct-1" });
      }
      throw new Error(`unexpected url ${url}`);
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const cfg = {
      ...gatewayMuxConfig(),
      channels: {
        discord: {
          accounts: {
            default: {
              mux: {
                enabled: true,
              },
            },
          },
        },
      },
    } as OpenClawConfig;

    await discordOutbound.sendText!({
      cfg,
      to: "discord:chan",
      text: "hello",
      sessionKey: "sess-discord",
    });

    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("routes whatsapp outbound through mux from default account config", async () => {
    const fetchSpy = vi.fn(async (input: string | URL | Request) => {
      const url = resolveFetchUrl(input);
      if (url === "http://mux.local/v1/instances/register") {
        return jsonResponse({
          ok: true,
          runtimeToken: RUNTIME_TOKEN,
          expiresAtMs: Date.now() + 24 * 60 * 60 * 1000,
        });
      }
      if (url === "http://mux.local/v1/mux/outbound/send") {
        return jsonResponse({ messageId: "mx-wa-acct-1" });
      }
      throw new Error(`unexpected url ${url}`);
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const cfg = {
      ...gatewayMuxConfig(),
      channels: {
        whatsapp: {
          accounts: {
            default: {
              mux: {
                enabled: true,
              },
            },
          },
        },
      },
    } as OpenClawConfig;

    await whatsappOutbound.sendText!({
      cfg,
      to: "+15555550100",
      text: "hello",
      sessionKey: "sess-wa",
    });

    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("routes typing through mux when enabled", async () => {
    const fetchSpy = vi.fn(async (input: string | URL | Request) => {
      const url = resolveFetchUrl(input);
      if (url === "http://mux.local/v1/instances/register") {
        return jsonResponse({
          ok: true,
          runtimeToken: RUNTIME_TOKEN,
          expiresAtMs: Date.now() + 24 * 60 * 60 * 1000,
        });
      }
      if (url === "http://mux.local/v1/mux/outbound/send") {
        return jsonResponse({ ok: true });
      }
      throw new Error(`unexpected url ${url}`);
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const cfg = {
      ...gatewayMuxConfig(),
      channels: {
        telegram: {
          mux: {
            enabled: true,
          },
        },
      },
    } as OpenClawConfig;

    await sendTypingViaMux({
      cfg,
      channel: "telegram",
      sessionKey: "sess-tg",
    });

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const sendCall = fetchSpy.mock.calls.find(
      ([callInput]) => resolveFetchUrl(callInput) === "http://mux.local/v1/mux/outbound/send",
    );
    expect(sendCall).toBeDefined();
    const [url, init] = sendCall as [string | URL | Request, RequestInit];
    expect(resolveFetchUrl(url)).toBe("http://mux.local/v1/mux/outbound/send");
    expect(parseJsonRequestBody(init)).toMatchObject({
      op: "action",
      action: "typing",
      channel: "telegram",
      sessionKey: "sess-tg",
    });
  });

  it("requires gateway mux registerKey when channel mux is enabled", async () => {
    const cfg = {
      gateway: {
        http: {
          endpoints: {
            mux: {
              baseUrl: "http://mux.local",
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

    await expect(
      telegramOutbound.sendText!({
        cfg,
        to: "telegram:123",
        text: "hello",
        sessionKey: "sess-tg",
      }),
    ).rejects.toThrow(/gateway\.http\.endpoints\.mux\.registerKey.*required/i);
  });

  it("requires gateway mux baseUrl when channel mux is enabled", async () => {
    const cfg = {
      gateway: {
        http: {
          endpoints: {
            mux: {
              registerKey: REGISTER_KEY,
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

    await expect(
      telegramOutbound.sendText!({
        cfg,
        to: "telegram:123",
        text: "hello",
        sessionKey: "sess-tg",
      }),
    ).rejects.toThrow(/gateway\.http\.endpoints\.mux\.baseUrl is required/i);
  });

  it("rejects telegram mux success payload missing messageId", async () => {
    const fetchSpy = vi.fn(async (input: string | URL | Request) => {
      const url = resolveFetchUrl(input);
      if (url === "http://mux.local/v1/instances/register") {
        return jsonResponse({
          ok: true,
          runtimeToken: RUNTIME_TOKEN,
          expiresAtMs: Date.now() + 24 * 60 * 60 * 1000,
        });
      }
      if (url === "http://mux.local/v1/mux/outbound/send") {
        return jsonResponse({ chatId: "tg-chat-1" });
      }
      throw new Error(`unexpected url ${url}`);
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const cfg = {
      ...gatewayMuxConfig(),
      channels: {
        telegram: {
          mux: {
            enabled: true,
          },
        },
      },
    } as OpenClawConfig;

    await expect(
      telegramOutbound.sendText!({
        cfg,
        to: "telegram:123",
        text: "hello",
        sessionKey: "sess-tg",
      }),
    ).rejects.toThrow(/missing messageId/i);
  });

  it("rejects discord mux success payload missing messageId", async () => {
    const fetchSpy = vi.fn(async (input: string | URL | Request) => {
      const url = resolveFetchUrl(input);
      if (url === "http://mux.local/v1/instances/register") {
        return jsonResponse({
          ok: true,
          runtimeToken: RUNTIME_TOKEN,
          expiresAtMs: Date.now() + 24 * 60 * 60 * 1000,
        });
      }
      if (url === "http://mux.local/v1/mux/outbound/send") {
        return jsonResponse({ channelId: "dc-channel-1" });
      }
      throw new Error(`unexpected url ${url}`);
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const cfg = {
      ...gatewayMuxConfig(),
      channels: {
        discord: {
          mux: {
            enabled: true,
          },
        },
      },
    } as OpenClawConfig;

    await expect(
      discordOutbound.sendText!({
        cfg,
        to: "discord:chan",
        text: "hello",
        sessionKey: "sess-discord",
      }),
    ).rejects.toThrow(/missing messageId/i);
  });

  it("rejects whatsapp mux success payload missing messageId", async () => {
    const fetchSpy = vi.fn(async (input: string | URL | Request) => {
      const url = resolveFetchUrl(input);
      if (url === "http://mux.local/v1/instances/register") {
        return jsonResponse({
          ok: true,
          runtimeToken: RUNTIME_TOKEN,
          expiresAtMs: Date.now() + 24 * 60 * 60 * 1000,
        });
      }
      if (url === "http://mux.local/v1/mux/outbound/send") {
        return jsonResponse({ toJid: "jid-1" });
      }
      throw new Error(`unexpected url ${url}`);
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const cfg = {
      ...gatewayMuxConfig(),
      channels: {
        whatsapp: {
          mux: {
            enabled: true,
          },
        },
      },
    } as OpenClawConfig;

    await expect(
      whatsappOutbound.sendText!({
        cfg,
        to: "+15555550100",
        text: "hello",
        sessionKey: "sess-wa",
      }),
    ).rejects.toThrow(/missing messageId/i);
  });
});
