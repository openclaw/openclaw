import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  createHookRequest,
  createHooksHandler,
  createResponse,
} from "./server-http.test-harness.js";

const { readJsonBodyMock } = vi.hoisted(() => ({
  readJsonBodyMock: vi.fn(),
}));

vi.mock("./hooks.js", async () => {
  const actual = await vi.importActual<typeof import("./hooks.js")>("./hooks.js");
  return {
    ...actual,
    readJsonBody: readJsonBodyMock,
  };
});

describe("createHooksRequestHandler timeout status mapping", () => {
  beforeEach(() => {
    readJsonBodyMock.mockClear();
  });

  test("returns 408 for request body timeout", async () => {
    readJsonBodyMock.mockResolvedValue({ ok: false, error: "request body timeout" });
    const dispatchWakeHook = vi.fn();
    const dispatchAgentHook = vi.fn(() => "run-1");
    const handler = createHooksHandler({ dispatchWakeHook, dispatchAgentHook });
    const req = createHookRequest();
    const { res, end } = createResponse();

    const handled = await handler(req, res);

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(408);
    expect(end).toHaveBeenCalledWith(JSON.stringify({ ok: false, error: "request body timeout" }));
    expect(dispatchWakeHook).not.toHaveBeenCalled();
    expect(dispatchAgentHook).not.toHaveBeenCalled();
  });

  test("returns 413 for oversized /hooks/message payloads", async () => {
    readJsonBodyMock.mockResolvedValue({ ok: false, error: "payload too large" });
    const dispatchMessageHook = vi.fn();
    const handler = createHooksHandler({ dispatchMessageHook });
    const req = createHookRequest({ url: "/hooks/message" });
    const { res, end } = createResponse();

    const handled = await handler(req, res);

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(413);
    expect(end).toHaveBeenCalledWith(JSON.stringify({ ok: false, error: "payload too large" }));
    expect(dispatchMessageHook).not.toHaveBeenCalled();
  });

  test("dedupes /hooks/message retries by requestId when idempotency header is absent", async () => {
    readJsonBodyMock.mockResolvedValue({
      ok: true,
      value: { message: "hello", requestId: "req-1" },
    });
    const dispatchMessageHook = vi.fn(async () => ({
      status: "accepted" as const,
      sessionKey: "main",
    }));
    const handler = createHooksHandler({ dispatchMessageHook });

    const firstReq = createHookRequest({ url: "/hooks/message" });
    const first = createResponse();
    const firstHandled = await handler(firstReq, first.res);
    expect(firstHandled).toBe(true);
    expect(first.res.statusCode).toBe(200);
    const firstPayload = JSON.parse((first.end.mock.calls[0] as [string])[0]) as {
      sessionKey?: string;
      status?: string;
    };

    const secondReq = createHookRequest({ url: "/hooks/message" });
    const second = createResponse();
    const secondHandled = await handler(secondReq, second.res);
    expect(secondHandled).toBe(true);
    expect(second.res.statusCode).toBe(200);
    const secondPayload = JSON.parse((second.end.mock.calls[0] as [string])[0]) as {
      sessionKey?: string;
      status?: string;
    };

    expect(dispatchMessageHook).toHaveBeenCalledTimes(1);
    expect(firstPayload.sessionKey).toBe("main");
    expect(secondPayload.sessionKey).toBe(firstPayload.sessionKey);
    expect(secondPayload.status).toBe(firstPayload.status);
  });

  test("returns 503 when /hooks/message dispatch is temporarily unavailable", async () => {
    readJsonBodyMock.mockResolvedValue({
      ok: true,
      value: { message: "hello", requestId: "req-1" },
    });
    const dispatchMessageHook = vi.fn(async () => {
      throw Object.assign(new Error("gateway context unavailable"), { statusCode: 503 });
    });
    const handler = createHooksHandler({ dispatchMessageHook });
    const req = createHookRequest({ url: "/hooks/message" });
    const { res, end } = createResponse();

    const handled = await handler(req, res);

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(503);
    expect(end).toHaveBeenCalledWith(
      JSON.stringify({ ok: false, error: "hook message dispatch unavailable" }),
    );
  });

  test("shares hook auth rate-limit bucket across ipv4 and ipv4-mapped ipv6 forms", async () => {
    const handler = createHooksHandler({ bindHost: "127.0.0.1" });

    for (let i = 0; i < 20; i++) {
      const req = createHookRequest({
        authorization: "Bearer wrong",
        remoteAddress: "1.2.3.4",
      });
      const { res } = createResponse();
      const handled = await handler(req, res);
      expect(handled).toBe(true);
      expect(res.statusCode).toBe(401);
    }

    const mappedReq = createHookRequest({
      authorization: "Bearer wrong",
      remoteAddress: "::ffff:1.2.3.4",
    });
    const { res: mappedRes, setHeader } = createResponse();
    const handled = await handler(mappedReq, mappedRes);

    expect(handled).toBe(true);
    expect(mappedRes.statusCode).toBe(429);
    expect(setHeader).toHaveBeenCalledWith("Retry-After", expect.any(String));
  });

  test("uses trusted proxy forwarded client ip for hook auth throttling", async () => {
    const handler = createHooksHandler({
      getClientIpConfig: () => ({ trustedProxies: ["10.0.0.1"] }),
    });

    for (let i = 0; i < 20; i++) {
      const req = createHookRequest({
        authorization: "Bearer wrong",
        remoteAddress: "10.0.0.1",
        headers: { "x-forwarded-for": "1.2.3.4" },
      });
      const { res } = createResponse();
      const handled = await handler(req, res);
      expect(handled).toBe(true);
      expect(res.statusCode).toBe(401);
    }

    const forwardedReq = createHookRequest({
      authorization: "Bearer wrong",
      remoteAddress: "10.0.0.1",
      headers: { "x-forwarded-for": "1.2.3.4, 10.0.0.1" },
    });
    const { res: forwardedRes, setHeader } = createResponse();
    const handled = await handler(forwardedReq, forwardedRes);

    expect(handled).toBe(true);
    expect(forwardedRes.statusCode).toBe(429);
    expect(setHeader).toHaveBeenCalledWith("Retry-After", expect.any(String));
  });

  test.each(["0.0.0.0", "::"])(
    "does not throw when bindHost=%s while parsing non-hook request URL",
    async (bindHost) => {
      const handler = createHooksHandler({ bindHost });
      const req = createHookRequest({ url: "/" });
      const { res, end } = createResponse();

      const handled = await handler(req, res);

      expect(handled).toBe(false);
      expect(end).not.toHaveBeenCalled();
    },
  );
});
