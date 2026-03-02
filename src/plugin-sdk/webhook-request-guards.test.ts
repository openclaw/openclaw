import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import { createMockServerResponse } from "../test-utils/mock-http-response.js";
import { createFixedWindowRateLimiter } from "./webhook-memory-guards.js";
import {
  applyBasicWebhookRequestGuards,
  isJsonContentType,
  readJsonWebhookBodyOrReject,
} from "./webhook-request-guards.js";

type MockIncomingMessage = IncomingMessage & {
  destroyed?: boolean;
  destroy: () => MockIncomingMessage;
};

function createMockRequest(params: {
  method?: string;
  headers?: Record<string, string>;
  chunks?: string[];
  emitEnd?: boolean;
}): MockIncomingMessage {
  const req = new EventEmitter() as MockIncomingMessage;
  req.method = params.method ?? "POST";
  req.headers = params.headers ?? {};
  req.destroyed = false;
  req.destroy = (() => {
    req.destroyed = true;
    return req;
  }) as MockIncomingMessage["destroy"];

  if (params.chunks) {
    void Promise.resolve().then(() => {
      for (const chunk of params.chunks ?? []) {
        req.emit("data", Buffer.from(chunk, "utf-8"));
      }
      if (params.emitEnd !== false) {
        req.emit("end");
      }
    });
  }

  return req;
}

describe("isJsonContentType", () => {
  it("accepts application/json and +json suffixes", () => {
    expect(isJsonContentType("application/json")).toBe(true);
    expect(isJsonContentType("application/cloudevents+json; charset=utf-8")).toBe(true);
  });

  it("rejects non-json media types", () => {
    expect(isJsonContentType("text/plain")).toBe(false);
    expect(isJsonContentType(undefined)).toBe(false);
  });
});

describe("applyBasicWebhookRequestGuards", () => {
  it("rejects disallowed HTTP methods", () => {
    const req = createMockRequest({ method: "GET" });
    const res = createMockServerResponse();
    const ok = applyBasicWebhookRequestGuards({
      req,
      res,
      allowMethods: ["POST"],
    });
    expect(ok).toBe(false);
    expect(res.statusCode).toBe(405);
    expect(res.getHeader("allow")).toBe("POST");
  });

  it("enforces rate limits", () => {
    const limiter = createFixedWindowRateLimiter({
      windowMs: 60_000,
      maxRequests: 1,
      maxTrackedKeys: 10,
    });
    const req1 = createMockRequest({ method: "POST" });
    const res1 = createMockServerResponse();
    const req2 = createMockRequest({ method: "POST" });
    const res2 = createMockServerResponse();
    expect(
      applyBasicWebhookRequestGuards({
        req: req1,
        res: res1,
        rateLimiter: limiter,
        rateLimitKey: "k",
        nowMs: 1_000,
      }),
    ).toBe(true);
    expect(
      applyBasicWebhookRequestGuards({
        req: req2,
        res: res2,
        rateLimiter: limiter,
        rateLimitKey: "k",
        nowMs: 1_001,
      }),
    ).toBe(false);
    expect(res2.statusCode).toBe(429);
  });

  it("rejects non-json requests when required", () => {
    const req = createMockRequest({
      method: "POST",
      headers: { "content-type": "text/plain" },
    });
    const res = createMockServerResponse();
    const ok = applyBasicWebhookRequestGuards({
      req,
      res,
      requireJsonContentType: true,
    });
    expect(ok).toBe(false);
    expect(res.statusCode).toBe(415);
  });
});

describe("readJsonWebhookBodyOrReject", () => {
  it("returns parsed JSON body", async () => {
    const req = createMockRequest({ chunks: ['{"ok":true}'] });
    const res = createMockServerResponse();
    await expect(
      readJsonWebhookBodyOrReject({
        req,
        res,
        maxBytes: 1024,
        emptyObjectOnEmpty: false,
      }),
    ).resolves.toEqual({ ok: true, value: { ok: true } });
  });

  it("preserves valid JSON null payload", async () => {
    const req = createMockRequest({ chunks: ["null"] });
    const res = createMockServerResponse();
    await expect(
      readJsonWebhookBodyOrReject({
        req,
        res,
        maxBytes: 1024,
        emptyObjectOnEmpty: false,
      }),
    ).resolves.toEqual({ ok: true, value: null });
  });

  it("writes 400 on invalid JSON payload", async () => {
    const req = createMockRequest({ chunks: ["{bad json"] });
    const res = createMockServerResponse();
    await expect(
      readJsonWebhookBodyOrReject({
        req,
        res,
        maxBytes: 1024,
        emptyObjectOnEmpty: false,
      }),
    ).resolves.toEqual({ ok: false });
    expect(res.statusCode).toBe(400);
    expect(res.body).toBe("Bad Request");
  });
});
