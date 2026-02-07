import type { IncomingMessage, ServerResponse } from "node:http";
import { SignJWT } from "jose";
import { generateKeyPairSync } from "node:crypto";
import { Readable } from "node:stream";
import { afterEach, describe, expect, test, vi } from "vitest";
import { __resetMuxJwksCacheForTest } from "./mux-jwt.js";

const OPENCLAW_ID = "openclaw-rt-1";

const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  dispatchInboundMessage: vi.fn(async () => ({
    queuedFinal: false,
    counts: { tool: 0, block: 0, final: 0 },
  })),
  resolveTelegramCallbackAction: vi.fn(),
  sendTypingViaMux: vi.fn(async () => {}),
}));

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    loadConfig: mocks.loadConfig,
  };
});

vi.mock("../auto-reply/dispatch.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../auto-reply/dispatch.js")>();
  return {
    ...actual,
    dispatchInboundMessage: mocks.dispatchInboundMessage,
  };
});

vi.mock("../telegram/callback-actions.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../telegram/callback-actions.js")>();
  return {
    ...actual,
    resolveTelegramCallbackAction: mocks.resolveTelegramCallbackAction,
  };
});

vi.mock("../channels/plugins/outbound/mux.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../channels/plugins/outbound/mux.js")>();
  return {
    ...actual,
    sendTypingViaMux: mocks.sendTypingViaMux,
  };
});

vi.mock("../infra/device-identity.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/device-identity.js")>();
  return {
    ...actual,
    loadOrCreateDeviceIdentity: () => ({
      deviceId: "openclaw-rt-1",
      publicKeyPem: "test",
      privateKeyPem: "test",
    }),
  };
});

const { __resetMuxRuntimeAuthCacheForTest } = await import("../channels/plugins/outbound/mux.js");
const { handleMuxInboundHttpRequest } = await import("./mux-http.js");

const ONE_PIXEL_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/woAAn8B9FD5fHAAAAAASUVORK5CYII=";

function createRequest(params: {
  method?: string;
  url?: string;
  headers?: Record<string, string>;
  body?: unknown;
}): IncomingMessage {
  const req = new Readable({
    read() {},
  }) as IncomingMessage;
  (req as { method?: string }).method = params.method ?? "POST";
  (req as { url?: string }).url = params.url ?? "/v1/mux/inbound";
  (req as { headers?: Record<string, string> }).headers = params.headers ?? {};
  if (params.body !== undefined) {
    const raw = typeof params.body === "string" ? params.body : JSON.stringify(params.body);
    req.push(raw);
  }
  req.push(null);
  return req;
}

function createResponse(): ServerResponse & { bodyText: string; headersMap: Map<string, string> } {
  const headersMap = new Map<string, string>();
  const res = {
    statusCode: 200,
    setHeader(name: string, value: unknown) {
      headersMap.set(name.toLowerCase(), String(value));
      return this;
    },
    end(chunk?: unknown) {
      if (typeof chunk === "string") {
        this.bodyText = chunk;
      } else if (chunk instanceof Uint8Array) {
        this.bodyText = Buffer.from(chunk).toString("utf8");
      } else {
        this.bodyText = "";
      }
      return this;
    },
    bodyText: "",
    headersMap,
  };
  return res as unknown as ServerResponse & { bodyText: string; headersMap: Map<string, string> };
}

afterEach(() => {
  mocks.loadConfig.mockReset();
  mocks.dispatchInboundMessage.mockClear();
  mocks.resolveTelegramCallbackAction.mockReset();
  mocks.sendTypingViaMux.mockReset();
  __resetMuxJwksCacheForTest();
  __resetMuxRuntimeAuthCacheForTest();
  vi.unstubAllGlobals();
});

async function waitForAsyncDispatch(): Promise<void> {
  await new Promise((resolveSleep) => setTimeout(resolveSleep, 20));
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

function createJwtFixture() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const kid = "kid-test-1";
  const rawJwk = publicKey.export({ format: "jwk" }) as JsonWebKey & {
    kty?: string;
    crv?: string;
    x?: string;
  };
  const jwk = {
    ...rawJwk,
    kid,
    use: "sig",
    alg: "EdDSA",
  };
  const mintToken = async (params: {
    issuer: string;
    subject: string;
    audience: string;
    scope: string;
    ttlSec?: number;
  }) => {
    const nowSec = Math.trunc(Date.now() / 1000);
    return await new SignJWT({ scope: params.scope })
      .setProtectedHeader({ alg: "EdDSA", typ: "JWT", kid })
      .setIssuer(params.issuer)
      .setSubject(params.subject)
      .setAudience(params.audience)
      .setIssuedAt(nowSec)
      .setNotBefore(nowSec)
      .setExpirationTime(nowSec + Math.max(1, params.ttlSec ?? 3600))
      .sign(privateKey);
  };
  return {
    jwks: { keys: [jwk] },
    mintToken,
  };
}

describe("handleMuxInboundHttpRequest", () => {
  test("authenticates and dispatches inbound payload", async () => {
    const jwtFixture = createJwtFixture();
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = resolveFetchUrl(input);
      if (url === "http://mux.local/.well-known/jwks.json") {
        return new Response(JSON.stringify(jwtFixture.jwks), {
          status: 200,
          headers: { "Content-Type": "application/json; charset=utf-8" },
        });
      }
      throw new Error(`unexpected fetch url ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const token = await jwtFixture.mintToken({
      issuer: "http://mux.local",
      subject: OPENCLAW_ID,
      audience: "openclaw-mux-inbound",
      scope: "mux:inbound",
    });

    mocks.loadConfig.mockReturnValue({
      gateway: {
        http: {
          endpoints: {
            mux: {
              enabled: true,
              baseUrl: "http://mux.local",
              registerKey: "rk-test-1",
              inboundUrl: "http://openclaw.local/v1/mux/inbound",
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
    });

    const noAuthReq = createRequest({
      headers: { "content-type": "application/json" },
      body: {},
    });
    const noAuthRes = createResponse();
    expect(await handleMuxInboundHttpRequest(noAuthReq, noAuthRes)).toBe(true);
    expect(noAuthRes.statusCode).toBe(401);
    expect(JSON.parse(noAuthRes.bodyText)).toEqual({
      ok: false,
      error: "unauthorized",
      code: "MISSING_BEARER",
    });

    const missingChannelReq = createRequest({
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        "x-openclaw-id": OPENCLAW_ID,
      },
      body: {
        sessionKey: "main",
        to: "telegram:123",
        body: "hello",
        openclawId: OPENCLAW_ID,
      },
    });
    const missingChannelRes = createResponse();
    expect(await handleMuxInboundHttpRequest(missingChannelReq, missingChannelRes)).toBe(true);
    expect(missingChannelRes.statusCode).toBe(400);

    const okReq = createRequest({
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        "x-openclaw-id": OPENCLAW_ID,
      },
      body: {
        channel: "telegram",
        sessionKey: "main",
        to: "telegram:123",
        from: "telegram:user",
        body: "hello mux",
        messageId: "mux-msg-1",
        openclawId: OPENCLAW_ID,
      },
    });
    const okRes = createResponse();
    expect(await handleMuxInboundHttpRequest(okReq, okRes)).toBe(true);
    expect(okRes.statusCode).toBe(202);
    expect(JSON.parse(okRes.bodyText)).toEqual({ ok: true, eventId: "mux-msg-1" });

    await waitForAsyncDispatch();
    expect(mocks.dispatchInboundMessage).toHaveBeenCalledTimes(1);
    const call = mocks.dispatchInboundMessage.mock.calls[0]?.[0] as
      | {
          ctx?: {
            Provider?: string;
            Surface?: string;
            OriginatingChannel?: string;
            OriginatingTo?: string;
            SessionKey?: string;
            MessageSid?: string;
            CommandAuthorized?: boolean;
            Body?: string;
            RawBody?: string;
            CommandBody?: string;
            ChannelData?: Record<string, unknown>;
          };
          replyOptions?: { images?: unknown[] };
        }
      | undefined;
    expect(call?.ctx).toMatchObject({
      Provider: "telegram",
      Surface: "mux",
      OriginatingChannel: "telegram",
      OriginatingTo: "telegram:123",
      SessionKey: "main",
      MessageSid: "mux-msg-1",
      Body: "hello mux",
      RawBody: "hello mux",
      CommandBody: "hello mux",
      CommandAuthorized: true,
    });
    expect(call?.ctx?.ChannelData).toBeUndefined();
    expect(call?.replyOptions?.images).toBeUndefined();
  });

  test("accepts mux inbound jwt auth and reuses cached jwks", async () => {
    const jwtFixture = createJwtFixture();
    let jwksFetchCount = 0;
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = resolveFetchUrl(input);
      if (url === "http://mux.local/.well-known/jwks.json") {
        jwksFetchCount += 1;
        return new Response(JSON.stringify(jwtFixture.jwks), {
          status: 200,
          headers: { "Content-Type": "application/json; charset=utf-8" },
        });
      }
      throw new Error(`unexpected fetch url ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    mocks.loadConfig.mockReturnValue({
      gateway: {
        http: {
          endpoints: {
            mux: {
              enabled: true,
              baseUrl: "http://mux.local",
              registerKey: "rk-test-1",
              inboundUrl: "http://openclaw.local/v1/mux/inbound",
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
    });

    const token = await jwtFixture.mintToken({
      issuer: "http://mux.local",
      subject: OPENCLAW_ID,
      audience: "openclaw-mux-inbound",
      scope: "mux:inbound mux:runtime",
    });

    const makeRequest = () =>
      createRequest({
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
          "x-openclaw-id": OPENCLAW_ID,
        },
        body: {
          channel: "telegram",
          sessionKey: "main",
          to: "telegram:123",
          from: "telegram:user",
          body: "hello jwt",
          messageId: `mux-msg-${Date.now()}`,
          openclawId: OPENCLAW_ID,
        },
      });

    const firstRes = createResponse();
    expect(await handleMuxInboundHttpRequest(makeRequest(), firstRes)).toBe(true);
    expect(firstRes.statusCode).toBe(202);

    const secondRes = createResponse();
    expect(await handleMuxInboundHttpRequest(makeRequest(), secondRes)).toBe(true);
    expect(secondRes.statusCode).toBe(202);

    await waitForAsyncDispatch();
    expect(mocks.dispatchInboundMessage).toHaveBeenCalledTimes(2);
    expect(jwksFetchCount).toBe(1);
  });

  test("rejects runtime jwt request when payload openclawId does not match", async () => {
    const jwtFixture = createJwtFixture();
    const fetchMock = vi.fn(async () => {
      return new Response(JSON.stringify(jwtFixture.jwks), {
        status: 200,
        headers: { "Content-Type": "application/json; charset=utf-8" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    mocks.loadConfig.mockReturnValue({
      gateway: {
        http: {
          endpoints: {
            mux: {
              enabled: true,
              baseUrl: "http://mux.local",
              registerKey: "rk-test-1",
              inboundUrl: "http://openclaw.local/v1/mux/inbound",
            },
          },
        },
      },
    });

    const token = await jwtFixture.mintToken({
      issuer: "http://mux.local",
      subject: OPENCLAW_ID,
      audience: "openclaw-mux-inbound",
      scope: "mux:inbound",
    });
    const req = createRequest({
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        "x-openclaw-id": OPENCLAW_ID,
      },
      body: {
        channel: "telegram",
        sessionKey: "main",
        to: "telegram:123",
        body: "hello",
        openclawId: "someone-else",
      },
    });
    const res = createResponse();
    expect(await handleMuxInboundHttpRequest(req, res)).toBe(true);
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.bodyText)).toEqual({
      ok: false,
      error: "unauthorized",
      code: "PAYLOAD_OPENCLAW_ID_MISMATCH",
    });
  });

  test("passes through channelData without transport mutation", async () => {
    const jwtFixture = createJwtFixture();
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = resolveFetchUrl(input);
      if (url === "http://mux.local/.well-known/jwks.json") {
        return new Response(JSON.stringify(jwtFixture.jwks), {
          status: 200,
          headers: { "Content-Type": "application/json; charset=utf-8" },
        });
      }
      throw new Error(`unexpected fetch url ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const token = await jwtFixture.mintToken({
      issuer: "http://mux.local",
      subject: OPENCLAW_ID,
      audience: "openclaw-mux-inbound",
      scope: "mux:inbound",
    });

    mocks.loadConfig.mockReturnValue({
      gateway: {
        http: {
          endpoints: {
            mux: {
              enabled: true,
              baseUrl: "http://mux.local",
              registerKey: "rk-test-1",
              inboundUrl: "http://openclaw.local/v1/mux/inbound",
            },
          },
        },
      },
    });

    const req = createRequest({
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        "x-openclaw-id": OPENCLAW_ID,
      },
      body: {
        channel: "discord",
        sessionKey: "dc:dm:42",
        to: "discord:dm:42",
        from: "discord:user:42",
        body: "hello from dm",
        messageId: "dc-msg-1",
        channelData: {
          routeKey: "discord:default:dm:user:42",
          discord: {
            rawMessage: {
              id: "1234567890",
              content: "hello from dm",
            },
          },
        },
        openclawId: OPENCLAW_ID,
      },
    });
    const res = createResponse();
    expect(await handleMuxInboundHttpRequest(req, res)).toBe(true);
    expect(res.statusCode).toBe(202);

    await waitForAsyncDispatch();
    const call = mocks.dispatchInboundMessage.mock.calls[0]?.[0] as
      | {
          ctx?: {
            Body?: string;
            RawBody?: string;
            ChannelData?: Record<string, unknown>;
          };
        }
      | undefined;
    expect(call?.ctx?.Body).toBe("hello from dm");
    expect(call?.ctx?.RawBody).toBe("hello from dm");
    expect(call?.ctx?.ChannelData).toEqual({
      routeKey: "discord:default:dm:user:42",
      discord: {
        rawMessage: {
          id: "1234567890",
          content: "hello from dm",
        },
      },
    });
  });

  test.each(["discord", "whatsapp"] as const)(
    "sends mux typing action for %s replies",
    async (channel) => {
      const jwtFixture = createJwtFixture();
      const fetchMock = vi.fn(async (input: string | URL | Request) => {
        const url = resolveFetchUrl(input);
        if (url === "http://mux.local/.well-known/jwks.json") {
          return new Response(JSON.stringify(jwtFixture.jwks), {
            status: 200,
            headers: { "Content-Type": "application/json; charset=utf-8" },
          });
        }
        throw new Error(`unexpected fetch url ${url}`);
      });
      vi.stubGlobal("fetch", fetchMock);

      const token = await jwtFixture.mintToken({
        issuer: "http://mux.local",
        subject: OPENCLAW_ID,
        audience: "openclaw-mux-inbound",
        scope: "mux:inbound",
      });

      mocks.loadConfig.mockReturnValue({
        gateway: {
          http: {
            endpoints: {
              mux: {
                enabled: true,
                baseUrl: "http://mux.local",
              },
            },
          },
        },
      });
      mocks.dispatchInboundMessage.mockImplementationOnce(async (params) => {
        await params.replyOptions?.onReplyStart?.();
        return {
          queuedFinal: false,
          counts: { tool: 0, block: 0, final: 0 },
        };
      });

      const req = createRequest({
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
          "x-openclaw-id": OPENCLAW_ID,
        },
        body: {
          channel,
          sessionKey: `${channel}:session:1`,
          accountId: "mux",
          to: `${channel}:123`,
          from: `${channel}:user:42`,
          body: "hello",
          messageId: `${channel}-msg-1`,
          openclawId: OPENCLAW_ID,
        },
      });
      const res = createResponse();

      expect(await handleMuxInboundHttpRequest(req, res)).toBe(true);
      expect(res.statusCode).toBe(202);
      await waitForAsyncDispatch();
      expect(mocks.sendTypingViaMux).toHaveBeenCalledWith({
        cfg: expect.any(Object),
        channel,
        accountId: "mux",
        sessionKey: `${channel}:session:1`,
      });
    },
  );

  test("parses image attachments into replyOptions.images", async () => {
    const jwtFixture = createJwtFixture();
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = resolveFetchUrl(input);
      if (url === "http://mux.local/.well-known/jwks.json") {
        return new Response(JSON.stringify(jwtFixture.jwks), {
          status: 200,
          headers: { "Content-Type": "application/json; charset=utf-8" },
        });
      }
      throw new Error(`unexpected fetch url ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const token = await jwtFixture.mintToken({
      issuer: "http://mux.local",
      subject: OPENCLAW_ID,
      audience: "openclaw-mux-inbound",
      scope: "mux:inbound",
    });

    mocks.loadConfig.mockReturnValue({
      gateway: {
        http: {
          endpoints: {
            mux: {
              enabled: true,
              baseUrl: "http://mux.local",
            },
          },
        },
      },
    });

    const req = createRequest({
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        "x-openclaw-id": OPENCLAW_ID,
      },
      body: {
        channel: "telegram",
        sessionKey: "main",
        to: "telegram:123",
        body: "see image",
        messageId: "mux-img-1",
        openclawId: OPENCLAW_ID,
        attachments: [
          {
            type: "image",
            mimeType: "image/png",
            fileName: "dot.png",
            content: `data:image/png;base64,${ONE_PIXEL_PNG_BASE64}`,
          },
        ],
      },
    });
    const res = createResponse();
    expect(await handleMuxInboundHttpRequest(req, res)).toBe(true);
    expect(res.statusCode).toBe(202);

    await waitForAsyncDispatch();
    expect(mocks.dispatchInboundMessage).toHaveBeenCalledTimes(1);
    const call = mocks.dispatchInboundMessage.mock.calls[0]?.[0] as
      | {
          ctx?: { MessageSid?: string };
          replyOptions?: {
            images?: Array<{ type: string; data: string; mimeType: string }>;
          };
        }
      | undefined;
    expect(call?.ctx?.MessageSid).toBe("mux-img-1");
    expect(call?.replyOptions?.images).toEqual([
      {
        type: "image",
        data: ONE_PIXEL_PNG_BASE64,
        mimeType: "image/png",
      },
    ]);
  });

  test("acks immediately without waiting for slow dispatch completion", async () => {
    const jwtFixture = createJwtFixture();
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = resolveFetchUrl(input);
      if (url === "http://mux.local/.well-known/jwks.json") {
        return new Response(JSON.stringify(jwtFixture.jwks), {
          status: 200,
          headers: { "Content-Type": "application/json; charset=utf-8" },
        });
      }
      throw new Error(`unexpected fetch url ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const token = await jwtFixture.mintToken({
      issuer: "http://mux.local",
      subject: OPENCLAW_ID,
      audience: "openclaw-mux-inbound",
      scope: "mux:inbound",
    });

    mocks.loadConfig.mockReturnValue({
      gateway: {
        http: {
          endpoints: {
            mux: {
              enabled: true,
              baseUrl: "http://mux.local",
            },
          },
        },
      },
    });
    mocks.dispatchInboundMessage.mockImplementationOnce(async () => {
      await new Promise((resolveSleep) => setTimeout(resolveSleep, 250));
      return {
        queuedFinal: false,
        counts: { tool: 0, block: 0, final: 0 },
      };
    });

    const req = createRequest({
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        "x-openclaw-id": OPENCLAW_ID,
      },
      body: {
        channel: "telegram",
        sessionKey: "main",
        to: "telegram:123",
        body: "slow path",
        messageId: "mux-slow-1",
        openclawId: OPENCLAW_ID,
      },
    });
    const res = createResponse();
    const startedAt = Date.now();
    expect(await handleMuxInboundHttpRequest(req, res)).toBe(true);
    const elapsedMs = Date.now() - startedAt;
    expect(res.statusCode).toBe(202);
    expect(elapsedMs).toBeLessThan(120);

    await new Promise((resolveSleep) => setTimeout(resolveSleep, 300));
    expect(mocks.dispatchInboundMessage).toHaveBeenCalledTimes(1);
  });

  test("handles telegram callback edit actions via mux raw outbound", async () => {
    const jwtFixture = createJwtFixture();
    const token = await jwtFixture.mintToken({
      issuer: "http://mux.local",
      subject: OPENCLAW_ID,
      audience: "openclaw-mux-inbound",
      scope: "mux:inbound",
    });

    mocks.loadConfig.mockReturnValue({
      gateway: {
        http: {
          endpoints: {
            mux: {
              enabled: true,
              baseUrl: "http://mux.local",
              registerKey: "rk-test-1",
              inboundUrl: "http://openclaw.local/v1/mux/inbound",
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
    });
    mocks.resolveTelegramCallbackAction.mockResolvedValue({
      kind: "edit",
      text: "page two",
      buttons: [[{ text: "Prev", callback_data: "commands_page_1:main" }]],
    });
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = resolveFetchUrl(input);
      if (url === "http://mux.local/.well-known/jwks.json") {
        return new Response(JSON.stringify(jwtFixture.jwks), {
          status: 200,
          headers: { "Content-Type": "application/json; charset=utf-8" },
        });
      }
      if (url === "http://mux.local/v1/instances/register") {
        return new Response(
          JSON.stringify({
            runtimeToken: "rt-token-1",
            expiresAtMs: Date.now() + 86_400_000,
          }),
          { status: 200, headers: { "Content-Type": "application/json; charset=utf-8" } },
        );
      }
      if (url === "http://mux.local/v1/mux/outbound/send") {
        return new Response(JSON.stringify({ messageId: "mx-edit-1" }), {
          status: 200,
          headers: { "Content-Type": "application/json; charset=utf-8" },
        });
      }
      void init;
      throw new Error(`unexpected fetch url ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const req = createRequest({
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        "x-openclaw-id": OPENCLAW_ID,
      },
      body: {
        eventId: "tgcb:470",
        event: { kind: "callback" },
        channel: "telegram",
        sessionKey: "tg:group:-100555",
        to: "telegram:-100555",
        from: "telegram:1234",
        body: "commands_page_2:main",
        accountId: "default",
        chatType: "group",
        messageId: "777",
        channelData: {
          chatId: "-100555",
          telegram: {
            callbackData: "commands_page_2:main",
            callbackMessageId: "777",
          },
        },
        openclawId: OPENCLAW_ID,
      },
    });
    const res = createResponse();

    expect(await handleMuxInboundHttpRequest(req, res)).toBe(true);
    expect(res.statusCode, res.bodyText).toBe(202);
    expect(mocks.dispatchInboundMessage).not.toHaveBeenCalled();
    expect(mocks.resolveTelegramCallbackAction).toHaveBeenCalledWith(
      expect.objectContaining({
        data: "commands_page_2:main",
        chatId: "-100555",
      }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const sendCall = fetchMock.mock.calls.find(
      ([callInput]) => resolveFetchUrl(callInput) === "http://mux.local/v1/mux/outbound/send",
    );
    expect(sendCall).toBeDefined();
    const [url, init] = sendCall as [string | URL | Request, RequestInit];
    expect(resolveFetchUrl(url)).toBe("http://mux.local/v1/mux/outbound/send");
    const body = parseJsonRequestBody(init);
    expect(body).toMatchObject({
      channel: "telegram",
      sessionKey: "tg:group:-100555",
      accountId: "default",
      raw: {
        telegram: {
          method: "editMessageText",
          body: {
            message_id: 777,
            text: "page two",
            reply_markup: {
              inline_keyboard: [[{ text: "Prev", callback_data: "commands_page_1:main" }]],
            },
          },
        },
      },
    });
  });

  test("forwards telegram callback actions as synthetic command text", async () => {
    const jwtFixture = createJwtFixture();
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = resolveFetchUrl(input);
      if (url === "http://mux.local/.well-known/jwks.json") {
        return new Response(JSON.stringify(jwtFixture.jwks), {
          status: 200,
          headers: { "Content-Type": "application/json; charset=utf-8" },
        });
      }
      throw new Error(`unexpected fetch url ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const token = await jwtFixture.mintToken({
      issuer: "http://mux.local",
      subject: OPENCLAW_ID,
      audience: "openclaw-mux-inbound",
      scope: "mux:inbound",
    });

    mocks.loadConfig.mockReturnValue({
      gateway: {
        http: {
          endpoints: {
            mux: {
              enabled: true,
              baseUrl: "http://mux.local",
            },
          },
        },
      },
    });
    mocks.resolveTelegramCallbackAction.mockResolvedValue({
      kind: "forward",
      text: "/model openai/gpt-5",
    });

    const req = createRequest({
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        "x-openclaw-id": OPENCLAW_ID,
      },
      body: {
        eventId: "tgcb:471",
        event: { kind: "callback" },
        channel: "telegram",
        sessionKey: "tg:group:-100555",
        to: "telegram:-100555",
        from: "telegram:1234",
        body: "mdl_sel_openai:gpt-5",
        accountId: "default",
        chatType: "group",
        messageId: "778",
        channelData: {
          chatId: "-100555",
          routeKey: "telegram:default:chat:-100555",
          telegram: {
            callbackData: "mdl_sel_openai:gpt-5",
            callbackMessageId: "778",
          },
        },
        openclawId: OPENCLAW_ID,
      },
    });
    const res = createResponse();

    expect(await handleMuxInboundHttpRequest(req, res)).toBe(true);
    expect(res.statusCode).toBe(202);
    await waitForAsyncDispatch();
    expect(mocks.dispatchInboundMessage).toHaveBeenCalledTimes(1);
    const call = mocks.dispatchInboundMessage.mock.calls[0]?.[0] as
      | {
          ctx?: {
            Body?: string;
            RawBody?: string;
            CommandBody?: string;
          };
        }
      | undefined;
    expect(call?.ctx).toMatchObject({
      Body: "/model openai/gpt-5",
      RawBody: "/model openai/gpt-5",
      CommandBody: "/model openai/gpt-5",
    });
  });
});
