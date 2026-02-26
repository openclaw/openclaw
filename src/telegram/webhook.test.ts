import { createHash } from "node:crypto";
import { once } from "node:events";
import { request } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { startTelegramWebhook } from "./webhook.js";

const handlerSpy = vi.hoisted(() => vi.fn((..._args: unknown[]): unknown => undefined));
const setWebhookSpy = vi.hoisted(() => vi.fn());
const deleteWebhookSpy = vi.hoisted(() => vi.fn(async () => true));
const initSpy = vi.hoisted(() => vi.fn(async () => undefined));
const stopSpy = vi.hoisted(() => vi.fn());
const webhookCallbackSpy = vi.hoisted(() => vi.fn(() => handlerSpy));
const createTelegramBotSpy = vi.hoisted(() =>
  vi.fn(() => ({
    init: initSpy,
    api: { setWebhook: setWebhookSpy, deleteWebhook: deleteWebhookSpy },
    stop: stopSpy,
  })),
);

const WEBHOOK_POST_TIMEOUT_MS = process.platform === "win32" ? 20_000 : 8_000;

vi.mock("grammy", async (importOriginal) => {
  const actual = await importOriginal<typeof import("grammy")>();
  return {
    ...actual,
    webhookCallback: webhookCallbackSpy,
  };
});

vi.mock("./bot.js", () => ({
  createTelegramBot: createTelegramBotSpy,
}));

async function fetchWithTimeout(
  input: string,
  init: Omit<RequestInit, "signal">,
  timeoutMs: number,
): Promise<Response> {
  const abort = new AbortController();
  const timer = setTimeout(() => {
    abort.abort();
  }, timeoutMs);
  try {
    return await fetch(input, { ...init, signal: abort.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function postWebhookJson(params: {
  url: string;
  payload: string;
  secret?: string;
  timeoutMs?: number;
}): Promise<Response> {
  return await fetchWithTimeout(
    params.url,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(params.secret ? { "x-telegram-bot-api-secret-token": params.secret } : {}),
      },
      body: params.payload,
    },
    params.timeoutMs ?? 5_000,
  );
}

function createDeterministicRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 4_294_967_296;
  };
}

async function postWebhookPayloadWithChunkPlan(params: {
  port: number;
  path: string;
  payload: string;
  secret: string;
  mode: "single" | "random-chunked";
  timeoutMs?: number;
}): Promise<{ statusCode: number; body: string }> {
  const payloadBuffer = Buffer.from(params.payload, "utf-8");
  return await new Promise((resolve, reject) => {
    let bytesQueued = 0;
    let chunksQueued = 0;
    let phase: "writing" | "awaiting-response" = "writing";
    let settled = false;
    const finishResolve = (value: { statusCode: number; body: string }) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve(value);
    };
    const finishReject = (error: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      reject(error);
    };

    const req = request(
      {
        hostname: "127.0.0.1",
        port: params.port,
        path: params.path,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": String(payloadBuffer.length),
          "x-telegram-bot-api-secret-token": params.secret,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer | string) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        res.on("end", () => {
          finishResolve({
            statusCode: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf-8"),
          });
        });
      },
    );

    const timeout = setTimeout(() => {
      finishReject(
        new Error(
          `webhook post timed out after ${params.timeoutMs ?? 15_000}ms (phase=${phase}, bytesQueued=${bytesQueued}, chunksQueued=${chunksQueued}, totalBytes=${payloadBuffer.length})`,
        ),
      );
      req.destroy();
    }, params.timeoutMs ?? 15_000);

    req.on("error", (error) => {
      finishReject(error);
    });

    const writeAll = async () => {
      if (params.mode === "single") {
        req.end(payloadBuffer);
        return;
      }

      const rng = createDeterministicRng(26156);
      let offset = 0;
      while (offset < payloadBuffer.length) {
        const remaining = payloadBuffer.length - offset;
        const nextSize = Math.max(1, Math.min(remaining, 1 + Math.floor(rng() * 8_192)));
        const chunk = payloadBuffer.subarray(offset, offset + nextSize);
        const canContinue = req.write(chunk);
        offset += nextSize;
        bytesQueued = offset;
        chunksQueued += 1;
        if (chunksQueued % 10 === 0) {
          await sleep(1 + Math.floor(rng() * 3));
        }
        if (!canContinue) {
          // Windows CI occasionally stalls on waiting for drain indefinitely.
          // Bound the wait, then continue queuing this small (~1MB) payload.
          await Promise.race([once(req, "drain"), sleep(25)]);
        }
      }
      phase = "awaiting-response";
      req.end();
    };

    void writeAll().catch((error) => {
      finishReject(error);
    });
  });
}

function createNearLimitTelegramPayload(): { payload: string; sizeBytes: number } {
  const maxBytes = 1_024 * 1_024;
  const targetBytes = maxBytes - 4_096;
  const shell = { update_id: 77_777, message: { text: "" } };
  const shellSize = Buffer.byteLength(JSON.stringify(shell), "utf-8");
  const textLength = Math.max(1, targetBytes - shellSize);
  const pattern = "the quick brown fox jumps over the lazy dog ";
  const repeats = Math.ceil(textLength / pattern.length);
  const text = pattern.repeat(repeats).slice(0, textLength);
  const payload = JSON.stringify({
    update_id: 77_777,
    message: { text },
  });
  return { payload, sizeBytes: Buffer.byteLength(payload, "utf-8") };
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

describe("startTelegramWebhook", () => {
  it("starts server, registers webhook, and serves health", async () => {
    initSpy.mockClear();
    createTelegramBotSpy.mockClear();
    webhookCallbackSpy.mockClear();
    const runtimeLog = vi.fn();
    const abort = new AbortController();
    const cfg = { bindings: [] };
    const { server } = await startTelegramWebhook({
      token: "tok",
      secret: "secret",
      accountId: "opie",
      config: cfg,
      port: 0, // random free port
      abortSignal: abort.signal,
      runtime: { log: runtimeLog, error: vi.fn(), exit: vi.fn() },
    });
    expect(createTelegramBotSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "opie",
        config: expect.objectContaining({ bindings: [] }),
      }),
    );
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("no address");
    }
    const url = `http://127.0.0.1:${address.port}`;

    const health = await fetch(`${url}/healthz`);
    expect(health.status).toBe(200);
    expect(initSpy).toHaveBeenCalledTimes(1);
    expect(setWebhookSpy).toHaveBeenCalled();
    expect(webhookCallbackSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        api: expect.objectContaining({
          setWebhook: expect.any(Function),
        }),
      }),
      "callback",
      {
        secretToken: "secret",
        onTimeout: "return",
        timeoutMilliseconds: 10_000,
      },
    );
    expect(runtimeLog).toHaveBeenCalledWith(
      expect.stringContaining("webhook local listener on http://127.0.0.1:"),
    );
    expect(runtimeLog).toHaveBeenCalledWith(expect.stringContaining("/telegram-webhook"));
    expect(runtimeLog).toHaveBeenCalledWith(
      expect.stringContaining("webhook advertised to telegram on http://"),
    );

    abort.abort();
  });

  it("invokes webhook handler on matching path", async () => {
    handlerSpy.mockClear();
    createTelegramBotSpy.mockClear();
    const abort = new AbortController();
    const cfg = { bindings: [] };
    const { server } = await startTelegramWebhook({
      token: "tok",
      secret: "secret",
      accountId: "opie",
      config: cfg,
      port: 0,
      abortSignal: abort.signal,
      path: "/hook",
    });
    expect(createTelegramBotSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "opie",
        config: expect.objectContaining({ bindings: [] }),
      }),
    );
    const addr = server.address();
    if (!addr || typeof addr === "string") {
      throw new Error("no addr");
    }
    const payload = JSON.stringify({ update_id: 1, message: { text: "hello" } });
    const response = await postWebhookJson({
      url: `http://127.0.0.1:${addr.port}/hook`,
      payload,
      secret: "secret",
    });
    expect(response.status).toBe(200);
    expect(handlerSpy).toHaveBeenCalled();
    abort.abort();
  });

  it("rejects startup when webhook secret is missing", async () => {
    await expect(
      startTelegramWebhook({
        token: "tok",
      }),
    ).rejects.toThrow(/requires a non-empty secret token/i);
  });

  it("registers webhook using the bound listening port when port is 0", async () => {
    setWebhookSpy.mockClear();
    const runtimeLog = vi.fn();
    const abort = new AbortController();
    const { server } = await startTelegramWebhook({
      token: "tok",
      secret: "secret",
      port: 0,
      abortSignal: abort.signal,
      path: "/hook",
      runtime: { log: runtimeLog, error: vi.fn(), exit: vi.fn() },
    });
    try {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        throw new Error("no addr");
      }
      expect(addr.port).toBeGreaterThan(0);
      expect(setWebhookSpy).toHaveBeenCalledTimes(1);
      expect(setWebhookSpy).toHaveBeenCalledWith(
        `http://127.0.0.1:${addr.port}/hook`,
        expect.objectContaining({
          secret_token: "secret",
        }),
      );
      expect(runtimeLog).toHaveBeenCalledWith(
        `webhook local listener on http://127.0.0.1:${addr.port}/hook`,
      );
    } finally {
      abort.abort();
    }
  });

  it("keeps webhook payload readable when callback delays body read", async () => {
    handlerSpy.mockImplementationOnce(async (...args: unknown[]) => {
      const [update, reply] = args as [unknown, (json: string) => Promise<void>];
      await sleep(50);
      await reply(JSON.stringify(update));
    });

    const abort = new AbortController();
    const { server } = await startTelegramWebhook({
      token: "tok",
      secret: "secret",
      port: 0,
      abortSignal: abort.signal,
      path: "/hook",
    });
    try {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        throw new Error("no addr");
      }

      const payload = JSON.stringify({ update_id: 1, message: { text: "hello" } });
      const res = await postWebhookJson({
        url: `http://127.0.0.1:${addr.port}/hook`,
        payload,
        secret: "secret",
      });
      expect(res.status).toBe(200);
      const responseBody = await res.text();
      expect(JSON.parse(responseBody)).toEqual(JSON.parse(payload));
    } finally {
      abort.abort();
    }
  });

  it("keeps webhook payload readable across multiple delayed reads", async () => {
    const seenPayloads: string[] = [];
    const delayedHandler = async (...args: unknown[]) => {
      const [update, reply] = args as [unknown, (json: string) => Promise<void>];
      await sleep(50);
      seenPayloads.push(JSON.stringify(update));
      await reply("ok");
    };
    handlerSpy.mockImplementationOnce(delayedHandler).mockImplementationOnce(delayedHandler);

    const abort = new AbortController();
    const { server } = await startTelegramWebhook({
      token: "tok",
      secret: "secret",
      port: 0,
      abortSignal: abort.signal,
      path: "/hook",
    });
    try {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        throw new Error("no addr");
      }

      const payloads = [
        JSON.stringify({ update_id: 1, message: { text: "first" } }),
        JSON.stringify({ update_id: 2, message: { text: "second" } }),
      ];

      for (const payload of payloads) {
        const res = await postWebhookJson({
          url: `http://127.0.0.1:${addr.port}/hook`,
          payload,
          secret: "secret",
        });
        expect(res.status).toBe(200);
      }

      expect(seenPayloads.map((x) => JSON.parse(x))).toEqual(payloads.map((x) => JSON.parse(x)));
    } finally {
      abort.abort();
    }
  });

  it("processes a second request after first-request delayed-init data loss", async () => {
    const seenUpdates: unknown[] = [];
    webhookCallbackSpy.mockImplementationOnce(
      () =>
        vi.fn(
          (
            update: unknown,
            reply: (json: string) => Promise<void>,
            _secretHeader: string | undefined,
            _unauthorized: () => Promise<void>,
          ) => {
            seenUpdates.push(update);
            void (async () => {
              await sleep(50);
              await reply("ok");
            })();
          },
        ) as unknown as typeof handlerSpy,
    );

    const secret = "secret";
    const abort = new AbortController();
    const { server } = await startTelegramWebhook({
      token: "tok",
      secret,
      port: 0,
      abortSignal: abort.signal,
      path: "/hook",
    });

    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("no addr");
      }

      const firstPayload = JSON.stringify({ update_id: 100, message: { text: "first" } });
      const secondPayload = JSON.stringify({ update_id: 101, message: { text: "second" } });
      const firstResponse = await postWebhookPayloadWithChunkPlan({
        port: address.port,
        path: "/hook",
        payload: firstPayload,
        secret,
        mode: "single",
        timeoutMs: WEBHOOK_POST_TIMEOUT_MS,
      });
      const secondResponse = await postWebhookPayloadWithChunkPlan({
        port: address.port,
        path: "/hook",
        payload: secondPayload,
        secret,
        mode: "single",
        timeoutMs: WEBHOOK_POST_TIMEOUT_MS,
      });

      expect(firstResponse.statusCode).toBe(200);
      expect(secondResponse.statusCode).toBe(200);
      expect(seenUpdates).toEqual([JSON.parse(firstPayload), JSON.parse(secondPayload)]);
    } finally {
      abort.abort();
    }
  });

  it("handles near-limit payload with random chunk writes and event-loop yields", async () => {
    const seenUpdates: Array<{ update_id: number; message: { text: string } }> = [];
    webhookCallbackSpy.mockImplementationOnce(
      () =>
        vi.fn(
          (
            update: unknown,
            reply: (json: string) => Promise<void>,
            _secretHeader: string | undefined,
            _unauthorized: () => Promise<void>,
          ) => {
            seenUpdates.push(update as { update_id: number; message: { text: string } });
            void reply("ok");
          },
        ) as unknown as typeof handlerSpy,
    );

    const { payload, sizeBytes } = createNearLimitTelegramPayload();
    expect(sizeBytes).toBeLessThan(1_024 * 1_024);
    expect(sizeBytes).toBeGreaterThan(256 * 1_024);
    const expected = JSON.parse(payload) as { update_id: number; message: { text: string } };

    const secret = "secret";
    const abort = new AbortController();
    const { server } = await startTelegramWebhook({
      token: "tok",
      secret,
      port: 0,
      abortSignal: abort.signal,
      path: "/hook",
    });

    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("no addr");
      }

      const response = await postWebhookPayloadWithChunkPlan({
        port: address.port,
        path: "/hook",
        payload,
        secret,
        mode: "random-chunked",
        timeoutMs: WEBHOOK_POST_TIMEOUT_MS,
      });

      expect(response.statusCode).toBe(200);
      expect(seenUpdates).toHaveLength(1);
      expect(seenUpdates[0]?.update_id).toBe(expected.update_id);
      expect(seenUpdates[0]?.message.text.length).toBe(expected.message.text.length);
      expect(sha256(seenUpdates[0]?.message.text ?? "")).toBe(sha256(expected.message.text));
    } finally {
      abort.abort();
    }
  });

  it("handles near-limit payload written in a single request write", async () => {
    const seenUpdates: Array<{ update_id: number; message: { text: string } }> = [];
    webhookCallbackSpy.mockImplementationOnce(
      () =>
        vi.fn(
          (
            update: unknown,
            reply: (json: string) => Promise<void>,
            _secretHeader: string | undefined,
            _unauthorized: () => Promise<void>,
          ) => {
            seenUpdates.push(update as { update_id: number; message: { text: string } });
            void reply("ok");
          },
        ) as unknown as typeof handlerSpy,
    );

    const { payload, sizeBytes } = createNearLimitTelegramPayload();
    expect(sizeBytes).toBeLessThan(1_024 * 1_024);
    expect(sizeBytes).toBeGreaterThan(256 * 1_024);
    const expected = JSON.parse(payload) as { update_id: number; message: { text: string } };

    const secret = "secret";
    const abort = new AbortController();
    const { server } = await startTelegramWebhook({
      token: "tok",
      secret,
      port: 0,
      abortSignal: abort.signal,
      path: "/hook",
    });

    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("no addr");
      }

      const response = await postWebhookPayloadWithChunkPlan({
        port: address.port,
        path: "/hook",
        payload,
        secret,
        mode: "single",
        timeoutMs: WEBHOOK_POST_TIMEOUT_MS,
      });

      expect(response.statusCode).toBe(200);
      expect(seenUpdates).toHaveLength(1);
      expect(seenUpdates[0]?.update_id).toBe(expected.update_id);
      expect(seenUpdates[0]?.message.text.length).toBe(expected.message.text.length);
      expect(sha256(seenUpdates[0]?.message.text ?? "")).toBe(sha256(expected.message.text));
    } finally {
      abort.abort();
    }
  });

  it("rejects payloads larger than 1MB before invoking webhook handler", async () => {
    handlerSpy.mockClear();
    const abort = new AbortController();
    const { server } = await startTelegramWebhook({
      token: "tok",
      secret: "secret",
      port: 0,
      abortSignal: abort.signal,
      path: "/hook",
    });

    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("no addr");
      }

      const responseOrError = await new Promise<
        | { kind: "response"; statusCode: number; body: string }
        | { kind: "error"; code: string | undefined }
      >((resolve) => {
        const req = request(
          {
            hostname: "127.0.0.1",
            port: address.port,
            path: "/hook",
            method: "POST",
            headers: {
              "content-type": "application/json",
              "content-length": String(1_024 * 1_024 + 2_048),
              "x-telegram-bot-api-secret-token": "secret",
            },
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (chunk: Buffer | string) => {
              chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
            });
            res.on("end", () => {
              resolve({
                kind: "response",
                statusCode: res.statusCode ?? 0,
                body: Buffer.concat(chunks).toString("utf-8"),
              });
            });
          },
        );
        req.on("error", (error: NodeJS.ErrnoException) => {
          resolve({ kind: "error", code: error.code });
        });
        req.end("{}");
      });

      if (responseOrError.kind === "response") {
        expect(responseOrError.statusCode).toBe(413);
        expect(responseOrError.body).toBe("Payload too large");
      } else {
        expect(responseOrError.code).toBeOneOf(["ECONNRESET", "EPIPE"]);
      }
      expect(handlerSpy).not.toHaveBeenCalled();
    } finally {
      abort.abort();
    }
  });

  it("de-registers webhook when shutting down", async () => {
    deleteWebhookSpy.mockClear();
    const abort = new AbortController();
    await startTelegramWebhook({
      token: "tok",
      secret: "secret",
      port: 0,
      abortSignal: abort.signal,
      path: "/hook",
    });

    abort.abort();
    await sleep(25);

    expect(deleteWebhookSpy).toHaveBeenCalledTimes(1);
    expect(deleteWebhookSpy).toHaveBeenCalledWith({ drop_pending_updates: false });
  });
});
