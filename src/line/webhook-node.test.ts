import type { IncomingMessage, ServerResponse } from "node:http";
import crypto from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createLineNodeWebhookHandler } from "./webhook-node.js";

const sign = (body: string, secret: string) =>
  crypto.createHmac("SHA256", secret).update(body).digest("base64");

function createRes() {
  const headers: Record<string, string> = {};
  const res = {
    statusCode: 0,
    headersSent: false,
    setHeader: (k: string, v: string) => {
      headers[k.toLowerCase()] = v;
    },
    end: vi.fn((data?: unknown) => {
      res.headersSent = true;
      // Keep payload available for assertions
      (res as { body?: unknown }).body = data;
    }),
  } as unknown as ServerResponse & { body?: unknown };
  return { res, headers };
}

function createPostWebhookTestHarness(rawBody: string, secret = "secret") {
  const bot = { handleWebhook: vi.fn(async () => {}) };
  const runtime = { error: vi.fn() };
  const handler = createLineNodeWebhookHandler({
    channelSecret: secret,
    bot,
    runtime,
    readBody: async () => rawBody,
  });
  return { bot, handler, secret };
}

describe("createLineNodeWebhookHandler", () => {
  it("returns 200 for GET", async () => {
    const bot = { handleWebhook: vi.fn(async () => {}) };
    const runtime = { error: vi.fn() };
    const handler = createLineNodeWebhookHandler({
      channelSecret: "secret",
      bot,
      runtime,
      readBody: async () => "",
    });

    const { res } = createRes();
    await handler({ method: "GET", headers: {} } as unknown as IncomingMessage, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toBe("OK");
  });

  it("returns 200 for verification request (empty events, no signature)", async () => {
    const rawBody = JSON.stringify({ events: [] });
    const { bot, handler } = createPostWebhookTestHarness(rawBody);

    const { res, headers } = createRes();
    await handler({ method: "POST", headers: {} } as unknown as IncomingMessage, res);

    expect(res.statusCode).toBe(200);
    expect(headers["content-type"]).toBe("application/json");
    expect(res.body).toBe(JSON.stringify({ status: "ok" }));
    expect(bot.handleWebhook).not.toHaveBeenCalled();
  });

  it("rejects missing signature when events are non-empty", async () => {
    const rawBody = JSON.stringify({ events: [{ type: "message" }] });
    const { bot, handler } = createPostWebhookTestHarness(rawBody);

    const { res } = createRes();
    await handler({ method: "POST", headers: {} } as unknown as IncomingMessage, res);

    expect(res.statusCode).toBe(400);
    expect(bot.handleWebhook).not.toHaveBeenCalled();
  });

  it("rejects invalid signature", async () => {
    const rawBody = JSON.stringify({ events: [{ type: "message" }] });
    const { bot, handler } = createPostWebhookTestHarness(rawBody);

    const { res } = createRes();
    await handler(
      { method: "POST", headers: { "x-line-signature": "bad" } } as unknown as IncomingMessage,
      res,
    );

    expect(res.statusCode).toBe(401);
    expect(bot.handleWebhook).not.toHaveBeenCalled();
  });

  it("accepts valid signature and dispatches events", async () => {
    const rawBody = JSON.stringify({ events: [{ type: "message" }] });
    const { bot, handler, secret } = createPostWebhookTestHarness(rawBody);

    const { res } = createRes();
    await handler(
      {
        method: "POST",
        headers: { "x-line-signature": sign(rawBody, secret) },
      } as unknown as IncomingMessage,
      res,
    );

    expect(res.statusCode).toBe(200);
    expect(bot.handleWebhook).toHaveBeenCalledWith(
      expect.objectContaining({ events: expect.any(Array) }),
    );
  });

  it("returns 400 for invalid JSON payload even when signature is valid", async () => {
    const rawBody = "not json";
    const { bot, handler, secret } = createPostWebhookTestHarness(rawBody);

    const { res } = createRes();
    await handler(
      {
        method: "POST",
        headers: { "x-line-signature": sign(rawBody, secret) },
      } as unknown as IncomingMessage,
      res,
    );

    expect(res.statusCode).toBe(400);
    expect(bot.handleWebhook).not.toHaveBeenCalled();
  });
});
