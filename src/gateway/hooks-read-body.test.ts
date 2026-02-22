import type { IncomingMessage } from "node:http";
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { readJsonBody } from "./hooks.js";

function createMockRequest(params: {
  chunks?: string[];
  headers?: Record<string, string>;
  emitEnd?: boolean;
}): IncomingMessage {
  const req = new EventEmitter() as IncomingMessage & {
    destroyed?: boolean;
    destroy: () => void;
  };
  req.destroyed = false;
  req.headers = params.headers ?? {};
  req.destroy = () => {
    req.destroyed = true;
  };

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

describe("readJsonBody", () => {
  it("reads a valid JSON body", async () => {
    const req = createMockRequest({ chunks: ['{"hello":"world"}'] });
    const result = await readJsonBody(req, 1024);
    expect(result).toEqual({ ok: true, value: { hello: "world" } });
  });

  it("returns empty object for empty body", async () => {
    const req = createMockRequest({ chunks: [""] });
    const result = await readJsonBody(req, 1024);
    expect(result).toEqual({ ok: true, value: {} });
  });

  it("rejects bodies exceeding maxBytes", async () => {
    const req = createMockRequest({ chunks: ["x".repeat(256)] });
    const result = await readJsonBody(req, 64);
    expect(result).toEqual({ ok: false, error: "payload too large" });
  });

  it("rejects slow requests after timeout", async () => {
    const req = createMockRequest({ emitEnd: false });
    const result = await readJsonBody(req, 1024, 10);
    expect(result).toEqual({ ok: false, error: "request body timeout" });
    expect(req.destroyed).toBe(true);
  });

  it("uses custom timeoutMs when provided", async () => {
    const req = createMockRequest({ emitEnd: false });
    const start = Date.now();
    const result = await readJsonBody(req, 1024, 50);
    const elapsed = Date.now() - start;
    expect(result).toEqual({ ok: false, error: "request body timeout" });
    expect(elapsed).toBeGreaterThanOrEqual(40);
    expect(elapsed).toBeLessThan(500);
  });

  it("clears timeout on successful read", async () => {
    const req = createMockRequest({ chunks: ['{"ok":true}'] });
    const result = await readJsonBody(req, 1024, 50);
    expect(result).toEqual({ ok: true, value: { ok: true } });
    // No timeout should fire after this — if it did, req would be destroyed
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(req.destroyed).toBe(false);
  });

  it("handles connection close before end", async () => {
    const req = createMockRequest({ emitEnd: false });
    void Promise.resolve().then(() => {
      req.emit("data", Buffer.from('{"partial":'));
      req.emit("close");
    });
    const result = await readJsonBody(req, 1024, 5000);
    expect(result.ok).toBe(false);
  });
});
