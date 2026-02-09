import type { IncomingMessage, ServerResponse } from "node:http";
import { EventEmitter } from "node:events";
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
      : { token: TOKEN, presets: ["readai"], maxBodyBytes: 256 * 1024 };

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
      config: { token: TOKEN, presets: ["readai"], maxBodyBytes: 10 },
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
});
