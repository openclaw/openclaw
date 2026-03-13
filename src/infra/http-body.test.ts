import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import { createMockServerResponse } from "../test-utils/mock-http-response.js";
import {
  installRequestBodyLimitGuard,
  isRequestBodyLimitError,
  readJsonBodyWithLimit,
  readRequestBodyWithLimit,
} from "./http-body.js";

type MockIncomingMessage = IncomingMessage & {
  destroyed?: boolean;
  destroy: (error?: Error) => MockIncomingMessage;
  __unhandledDestroyError?: unknown;
};

async function waitForMicrotaskTurn(): Promise<void> {
  await new Promise<void>((resolve) => queueMicrotask(resolve));
}

async function expectReadPayloadTooLarge(params: {
  chunks?: string[];
  headers?: Record<string, string>;
  maxBytes: number;
}) {
  const req = createMockRequest({
    chunks: params.chunks,
    headers: params.headers,
    emitEnd: false,
  });
  await expect(readRequestBodyWithLimit(req, { maxBytes: params.maxBytes })).rejects.toMatchObject({
    message: "PayloadTooLarge",
  });
  await waitForMicrotaskTurn();
  expect(req.__unhandledDestroyError).toBeUndefined();
}

async function expectGuardPayloadTooLarge(params: {
  chunks?: string[];
  headers?: Record<string, string>;
  maxBytes: number;
  responseFormat?: "json" | "text";
  responseText?: { PAYLOAD_TOO_LARGE?: string };
}) {
  const req = createMockRequest({
    chunks: params.chunks,
    headers: params.headers,
    emitEnd: false,
  });
  const res = createMockServerResponse();
  const guard = installRequestBodyLimitGuard(req, res, {
    maxBytes: params.maxBytes,
    ...(params.responseFormat ? { responseFormat: params.responseFormat } : {}),
    ...(params.responseText ? { responseText: params.responseText } : {}),
  });
  await waitForMicrotaskTurn();
  expect(guard.isTripped()).toBe(true);
  expect(guard.code()).toBe("PAYLOAD_TOO_LARGE");
  expect(res.statusCode).toBe(413);
  expect(req.__unhandledDestroyError).toBeUndefined();
  return { req, res, guard };
}

function createMockRequest(params: {
  chunks?: string[];
  headers?: Record<string, string>;
  emitEnd?: boolean;
}): MockIncomingMessage {
  const req = new EventEmitter() as MockIncomingMessage;
  req.destroyed = false;
  req.headers = params.headers ?? {};
  req.destroy = ((error?: Error) => {
    req.destroyed = true;
    if (error) {
      // Simulate Node's async 'error' emission on destroy(err). If no listener is
      // present at that time, EventEmitter throws; capture that as "unhandled".
      queueMicrotask(() => {
        try {
          req.emit("error", error);
        } catch (err) {
          req.__unhandledDestroyError = err;
        }
      });
    }
    return req;
  }) as MockIncomingMessage["destroy"];

  if (params.chunks) {
    void Promise.resolve().then(() => {
      for (const chunk of params.chunks ?? []) {
        req.emit("data", Buffer.from(chunk, "utf-8"));
        if (req.destroyed) {
          return;
        }
      }
      if (params.emitEnd !== false) {
        req.emit("end");
      }
    });
  }

  return req;
}

describe("http body limits", () => {
  it("reads body within max bytes", async () => {
    const req = createMockRequest({ chunks: ['{"ok":true}'] });
    await expect(readRequestBodyWithLimit(req, { maxBytes: 1024 })).resolves.toBe('{"ok":true}');
  });

  it.each([
    {
      name: "rejects oversized streamed body",
      chunks: ["x".repeat(512)],
      maxBytes: 64,
    },
    {
      name: "declared oversized content-length does not emit unhandled error",
      headers: { "content-length": "9999" },
      maxBytes: 128,
    },
  ])("$name", async ({ chunks, headers, maxBytes }) => {
    await expectReadPayloadTooLarge({ chunks, headers, maxBytes });
  });

  it("returns json parse error when body is invalid", async () => {
    const req = createMockRequest({ chunks: ["{bad json"] });
    const result = await readJsonBodyWithLimit(req, { maxBytes: 1024, emptyObjectOnEmpty: false });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("INVALID_JSON");
    }
  });

  it("returns empty object for an empty body by default", async () => {
    const req = createMockRequest({ chunks: ["   "] });
    const result = await readJsonBodyWithLimit(req, { maxBytes: 1024 });
    expect(result).toEqual({ ok: true, value: {} });
  });

  it("returns payload-too-large for json body", async () => {
    const req = createMockRequest({ chunks: ["x".repeat(1024)] });
    const result = await readJsonBodyWithLimit(req, { maxBytes: 10 });
    expect(result).toEqual({ ok: false, code: "PAYLOAD_TOO_LARGE", error: "Payload too large" });
  });

  it.each([
    {
      name: "guard rejects oversized declared content-length",
      headers: { "content-length": "9999" },
      maxBytes: 128,
      expectedBody: '{"error":"Payload too large"}',
    },
    {
      name: "guard rejects streamed oversized body",
      chunks: ["small", "x".repeat(256)],
      maxBytes: 128,
      responseFormat: "text" as const,
      expectedBody: "Payload too large",
    },
    {
      name: "guard uses custom response text for payload-too-large",
      chunks: ["small", "x".repeat(256)],
      maxBytes: 128,
      responseFormat: "text" as const,
      responseText: { PAYLOAD_TOO_LARGE: "Too much" },
      expectedBody: "Too much",
    },
  ])("$name", async ({ chunks, headers, maxBytes, responseFormat, responseText, expectedBody }) => {
    const { res } = await expectGuardPayloadTooLarge({
      chunks,
      headers,
      maxBytes,
      ...(responseFormat ? { responseFormat } : {}),
      ...(responseText ? { responseText } : {}),
    });
    expect(res.body).toBe(expectedBody);
  });

  it("timeout surfaces typed error when timeoutMs is clamped", async () => {
    const req = createMockRequest({ emitEnd: false });
    const promise = readRequestBodyWithLimit(req, { maxBytes: 128, timeoutMs: 0 });
    await expect(promise).rejects.toSatisfy((error: unknown) =>
      isRequestBodyLimitError(error, "REQUEST_BODY_TIMEOUT"),
    );
    expect(req.__unhandledDestroyError).toBeUndefined();
  });

  it("guard clamps invalid maxBytes to one byte", async () => {
    const { res } = await expectGuardPayloadTooLarge({
      chunks: ["ab"],
      maxBytes: Number.NaN,
      responseFormat: "text",
    });
    expect(res.body).toBe("Payload too large");
  });

  it("surfaces connection-closed as a typed limit error", async () => {
    const req = createMockRequest({ emitEnd: false });
    const promise = readRequestBodyWithLimit(req, { maxBytes: 128 });
    queueMicrotask(() => req.emit("close"));
    await expect(promise).rejects.toSatisfy((error: unknown) =>
      isRequestBodyLimitError(error, "CONNECTION_CLOSED"),
    );
  });
});
