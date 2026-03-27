import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, test, vi } from "vitest";
import type { WebhooksConfigResolved } from "./webhooks-http.js";
import { createWebhooksRequestHandler } from "./webhooks-http.js";

function createMockReq(opts: { method?: string; url?: string; body?: string }): IncomingMessage {
  const emitter = new EventEmitter();
  const req = emitter as unknown as IncomingMessage;
  req.method = opts.method ?? "POST";
  req.url = opts.url ?? "/";
  req.headers = {};
  req.destroy = vi.fn() as unknown as IncomingMessage["destroy"];

  if (opts.body !== undefined) {
    process.nextTick(() => {
      emitter.emit("data", Buffer.from(opts.body!, "utf-8"));
      emitter.emit("end");
    });
  } else {
    process.nextTick(() => {
      emitter.emit("end");
    });
  }
  return req;
}

function createMockRes(): ServerResponse & { _body: string; _status: number } {
  const res = {
    statusCode: 200,
    _body: "",
    _status: 200,
    setHeader: vi.fn(),
    end: vi.fn((body?: string) => {
      res._body = body ?? "";
      res._status = res.statusCode;
    }),
  } as unknown as ServerResponse & { _body: string; _status: number };
  return res;
}

const TOKEN = "test-webhook-token-12345";

function createHandler(opts?: {
  config?: WebhooksConfigResolved | null;
  dispatchAgentHook?: () => string;
}) {
  const config: WebhooksConfigResolved | null =
    opts?.config !== undefined
      ? opts.config
      : { token: TOKEN, presets: ["readai"], maxBodyBytes: 256 * 1024, rawMode: [] };

  const dispatchAgentHook = opts?.dispatchAgentHook ?? (() => "run-id-1");

  return createWebhooksRequestHandler({
    getWebhooksConfig: () => config,
    bindHost: "127.0.0.1",
    port: 3000,
    logWebhooks: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      child: vi.fn(),
    } as never,
    dispatchAgentHook: dispatchAgentHook as never,
  });
}

describe("webhooks-http", () => {
  test("responds with plain text for validationToken query param (M365 handshake)", async () => {
    const handler = createHandler({
      config: { token: TOKEN, presets: ["m365-email"], maxBodyBytes: 256 * 1024, rawMode: [] },
    });
    const req = createMockReq({
      url: `/webhooks/${TOKEN}/m365-email?validationToken=abc-123-def`,
    });
    const res = createMockRes();
    const handled = await handler(req, res);
    expect(handled).toBe(true);
    expect(res._status).toBe(200);
    expect(res._body).toBe("abc-123-def");
  });

  test("returns false for non-webhook paths", async () => {
    const handler = createHandler();
    const req = createMockReq({ url: "/hooks/agent" });
    const res = createMockRes();
    const handled = await handler(req, res);
    expect(handled).toBe(false);
  });

  test("returns false when webhooks config is null", async () => {
    const handler = createHandler({ config: null });
    const req = createMockReq({ url: `/webhooks/${TOKEN}/readai` });
    const res = createMockRes();
    const handled = await handler(req, res);
    expect(handled).toBe(false);
  });

  test("returns 404 for invalid token", async () => {
    const handler = createHandler();
    const req = createMockReq({
      url: "/webhooks/wrong-token/readai",
      body: "{}",
    });
    const res = createMockRes();
    const handled = await handler(req, res);
    expect(handled).toBe(true);
    expect(res._status).toBe(404);
  });

  test("returns 404 for token with different length", async () => {
    const handler = createHandler();
    const req = createMockReq({
      url: "/webhooks/short/readai",
      body: "{}",
    });
    const res = createMockRes();
    const handled = await handler(req, res);
    expect(handled).toBe(true);
    expect(res._status).toBe(404);
  });

  test("returns 405 for non-POST methods", async () => {
    const handler = createHandler();
    const req = createMockReq({
      method: "GET",
      url: `/webhooks/${TOKEN}/readai`,
    });
    const res = createMockRes();
    const handled = await handler(req, res);
    expect(handled).toBe(true);
    expect(res._status).toBe(405);
  });

  test("returns 404 for unknown source", async () => {
    const handler = createHandler();
    const req = createMockReq({
      url: `/webhooks/${TOKEN}/unknown`,
      body: "{}",
    });
    const res = createMockRes();
    const handled = await handler(req, res);
    expect(handled).toBe(true);
    expect(res._status).toBe(404);
  });

  test("returns 404 when no source segment", async () => {
    const handler = createHandler();
    const req = createMockReq({
      url: `/webhooks/${TOKEN}`,
      body: "{}",
    });
    const res = createMockRes();
    const handled = await handler(req, res);
    expect(handled).toBe(true);
    expect(res._status).toBe(404);
  });

  test("dispatches valid readai meeting_end webhook", async () => {
    const dispatchFn = vi.fn().mockReturnValue("run-42");
    const handler = createHandler({ dispatchAgentHook: dispatchFn });
    const body = JSON.stringify({
      trigger: "meeting_end",
      session_id: "sess-1",
      title: "Team Sync",
      summary: "Great meeting.",
      action_items: ["Fix bug"],
      key_questions: [],
      topics: [],
      owner: { name: "John" },
      participants: [],
    });
    const req = createMockReq({
      url: `/webhooks/${TOKEN}/readai`,
      body,
    });
    const res = createMockRes();
    const handled = await handler(req, res);
    expect(handled).toBe(true);
    expect(res._status).toBe(200);
    const parsed = JSON.parse(res._body) as { ok: boolean; runId: string };
    expect(parsed.ok).toBe(true);
    expect(parsed.runId).toBe("run-42");
    expect(dispatchFn).toHaveBeenCalledOnce();
    const call = dispatchFn.mock.calls[0][0];
    expect(call.name).toBe("Read.ai");
    expect(call.sessionKey).toBe("webhook:readai:sess-1");
    expect(call.message).toContain("Team Sync");
  });

  test("skips non-meeting_end triggers with ok+skipped", async () => {
    const handler = createHandler();
    const body = JSON.stringify({
      trigger: "meeting_start",
      session_id: "sess-2",
    });
    const req = createMockReq({
      url: `/webhooks/${TOKEN}/readai`,
      body,
    });
    const res = createMockRes();
    const handled = await handler(req, res);
    expect(handled).toBe(true);
    expect(res._status).toBe(200);
    const parsed = JSON.parse(res._body) as { ok: boolean; skipped: boolean };
    expect(parsed.ok).toBe(true);
    expect(parsed.skipped).toBe(true);
  });

  test("returns 400 for malformed JSON body", async () => {
    const handler = createHandler();
    const req = createMockReq({
      url: `/webhooks/${TOKEN}/readai`,
      body: "not-json{",
    });
    const res = createMockRes();
    const handled = await handler(req, res);
    expect(handled).toBe(true);
    expect(res._status).toBe(400);
  });

  test("returns 413 for too-large body", async () => {
    const handler = createHandler({
      config: { token: TOKEN, presets: ["readai"], maxBodyBytes: 10, rawMode: [] },
    });
    const req = createMockReq({
      url: `/webhooks/${TOKEN}/readai`,
      body: JSON.stringify({ trigger: "meeting_end", data: "x".repeat(100) }),
    });
    const res = createMockRes();
    const handled = await handler(req, res);
    expect(handled).toBe(true);
    expect(res._status).toBe(413);
  });

  test("raw mode: dispatches raw JSON instead of formatted message", async () => {
    const dispatchFn = vi.fn().mockReturnValue("run-raw-1");
    const handler = createHandler({
      config: {
        token: TOKEN,
        presets: ["ownerrez"],
        maxBodyBytes: 256 * 1024,
        rawMode: ["ownerrez"],
      },
      dispatchAgentHook: dispatchFn,
    });
    const payload = {
      id: "8bd75001",
      action: "entity_update",
      entity_type: "booking",
      entity_id: 17152244,
      entity: { guest_name: "Alice" },
    };
    const req = createMockReq({
      url: `/webhooks/${TOKEN}/ownerrez`,
      body: JSON.stringify(payload),
    });
    const res = createMockRes();
    const handled = await handler(req, res);
    expect(handled).toBe(true);
    expect(res._status).toBe(200);
    const parsed = JSON.parse(res._body) as { ok: boolean; runId: string };
    expect(parsed.ok).toBe(true);
    expect(parsed.runId).toBe("run-raw-1");
    expect(dispatchFn).toHaveBeenCalledOnce();
    const call = dispatchFn.mock.calls[0][0];
    expect(call.name).toBe("Ownerrez");
    expect(call.sessionKey).toBe("webhook:ownerrez:17152244");
    const parsedMessage = JSON.parse(call.message as string) as typeof payload;
    expect(parsedMessage).toEqual(payload);
  });

  test("raw mode: session key falls back to id field", async () => {
    const dispatchFn = vi.fn().mockReturnValue("run-raw-2");
    const handler = createHandler({
      config: {
        token: TOKEN,
        presets: ["shopify"],
        maxBodyBytes: 256 * 1024,
        rawMode: ["shopify"],
      },
      dispatchAgentHook: dispatchFn,
    });
    const req = createMockReq({
      url: `/webhooks/${TOKEN}/shopify`,
      body: JSON.stringify({ id: "order-99", kind: "orders/create" }),
    });
    const res = createMockRes();
    await handler(req, res);
    expect(dispatchFn.mock.calls[0][0].sessionKey).toBe("webhook:shopify:order-99");
  });

  test("raw mode: session key falls back to unknown when no id field", async () => {
    const dispatchFn = vi.fn().mockReturnValue("run-raw-3");
    const handler = createHandler({
      config: {
        token: TOKEN,
        presets: ["ownerrez"],
        maxBodyBytes: 256 * 1024,
        rawMode: ["ownerrez"],
      },
      dispatchAgentHook: dispatchFn,
    });
    const req = createMockReq({
      url: `/webhooks/${TOKEN}/ownerrez`,
      body: JSON.stringify({ some_field: "value" }),
    });
    const res = createMockRes();
    await handler(req, res);
    expect(dispatchFn.mock.calls[0][0].sessionKey).toBe("webhook:ownerrez:unknown");
  });

  test("mixed mode: non-rawMode presets still use formatted transform", async () => {
    const dispatchFn = vi.fn().mockReturnValue("run-mixed-1");
    const handler = createHandler({
      config: {
        token: TOKEN,
        presets: ["readai", "ownerrez"],
        maxBodyBytes: 256 * 1024,
        rawMode: ["ownerrez"],
      },
      dispatchAgentHook: dispatchFn,
    });
    const body = JSON.stringify({
      trigger: "meeting_end",
      session_id: "sess-mix",
      title: "Mixed Mode Test",
      summary: "Summary here.",
      action_items: [],
      key_questions: [],
      topics: [],
      owner: { name: "Bob" },
      participants: [],
    });
    const req = createMockReq({ url: `/webhooks/${TOKEN}/readai`, body });
    const res = createMockRes();
    await handler(req, res);
    expect(res._status).toBe(200);
    const call = dispatchFn.mock.calls[0][0];
    expect(call.name).toBe("Read.ai");
    expect(call.sessionKey).toBe("webhook:readai:sess-mix");
    expect(call.message).toContain("Mixed Mode Test");
  });
});
