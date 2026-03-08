import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import { createMockServerResponse } from "../../test-utils/mock-http-response.js";
import { __testing } from "./provider.js";

type MockIncomingMessage = IncomingMessage & {
  destroyed?: boolean;
  destroy: (error?: Error) => MockIncomingMessage;
};

function createMockRequest(params: {
  body?: string;
  headers?: Record<string, string>;
}): MockIncomingMessage {
  const req = new EventEmitter() as MockIncomingMessage;
  req.destroyed = false;
  req.headers = params.headers ?? {};
  req.destroy = (() => {
    req.destroyed = true;
    return req;
  }) as MockIncomingMessage["destroy"];

  if (typeof params.body === "string") {
    void Promise.resolve().then(() => {
      req.emit("data", Buffer.from(params.body, "utf-8"));
      req.emit("end");
    });
  }

  return req;
}

describe("slack unsigned url_verification handling", () => {
  it("responds to unsigned url_verification challenge", async () => {
    const req = createMockRequest({
      body: JSON.stringify({ type: "url_verification", challenge: "abc123" }),
    });
    const res = createMockServerResponse();

    const handled = await __testing.maybeHandleUnsignedSlackUrlVerification(req, res);

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(res.getHeader("content-type")).toContain("application/json");
    expect(JSON.parse(res.body ?? "{}")).toEqual({ challenge: "abc123" });
  });

  it("does not intercept signed requests", async () => {
    const req = createMockRequest({
      headers: {
        "x-slack-signature": "v0=test",
      },
    });
    const res = createMockServerResponse();

    const handled = await __testing.maybeHandleUnsignedSlackUrlVerification(req, res);

    expect(handled).toBe(false);
    expect(res.headersSent).toBe(false);
  });

  it("rejects unsigned non-verification payloads", async () => {
    const req = createMockRequest({
      body: JSON.stringify({ type: "event_callback", event: { type: "message" } }),
    });
    const res = createMockServerResponse();

    const handled = await __testing.maybeHandleUnsignedSlackUrlVerification(req, res);

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(401);
    expect(res.body).toBe("Missing Slack signature");
  });
});
