import { beforeEach, describe, expect, test, vi } from "vitest";
import type { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveHookMappings } from "./hooks-mapping.js";
import { createHooksConfig } from "./hooks-test-helpers.js";
import { getHookChannelError } from "./hooks.js";
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

function expectRetryAfterHeader(setHeader: ReturnType<typeof vi.fn>): void {
  const retryAfterCall = setHeader.mock.calls.find(([name]) => name === "Retry-After");
  if (!retryAfterCall) {
    throw new Error("Expected Retry-After header call");
  }
  const retryAfterValue = retryAfterCall[1];
  expect(typeof retryAfterValue).toBe("string");
  expect(Number.parseInt(String(retryAfterValue), 10)).toBeGreaterThan(0);
}

function expectWarnLog(logWarn: ReturnType<typeof vi.fn>, reason: string) {
  const warnCall = logWarn.mock.calls.find(
    ([message]) => typeof message === "string" && message.includes(`reason=${reason}`),
  );
  if (!warnCall) {
    throw new Error(`Expected warn log with reason=${reason}`);
  }
  return warnCall[0] as string;
}

function createLogHooks(logWarn = vi.fn()): ReturnType<typeof createSubsystemLogger> {
  return {
    warn: logWarn,
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  } as unknown as ReturnType<typeof createSubsystemLogger>;
}

describe("createHooksRequestHandler timeout status mapping", () => {
  beforeEach(() => {
    readJsonBodyMock.mockReset();
  });

  test("returns 408 for request body timeout", async () => {
    readJsonBodyMock.mockResolvedValue({ ok: false, error: "request body timeout" });
    const handler = createHooksHandler({});
    const req = createHookRequest();
    const { res, end } = createResponse();

    const handled = await handler(req, res);

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(408);
    expect(end).toHaveBeenCalledWith(JSON.stringify({ ok: false, error: "request body timeout" }));
  });

  test("logs warning for invalid JSON body-read reject", async () => {
    const logWarn = vi.fn();
    const logHooks = createLogHooks(logWarn);
    readJsonBodyMock.mockResolvedValue({
      ok: false,
      error: "Unexpected token 'o', \"not-json\" is not valid JSON",
    });
    const handler = createHooksHandler({ logHooks });
    const req = createHookRequest({
      headers: {
        "x-request-id": "req-invalid-json-1",
        "content-type": "application/json; charset=utf-8",
        "content-length": "8",
      },
    });
    const { res, end } = createResponse();

    const handled = await handler(req, res);

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(400);
    expect(end).toHaveBeenCalledWith(
      JSON.stringify({
        ok: false,
        error: "Unexpected token 'o', \"not-json\" is not valid JSON",
      }),
    );
    const warnMessage = expectWarnLog(logWarn, "body-invalid-json");
    expect(warnMessage).toContain("path=wake");
    expect(warnMessage).toContain("content-type=application/json;_charset=utf-8");
    expect(warnMessage).toContain("body-type=unparsed");
    expect(warnMessage).toContain("body-bytes=8");
    expect(warnMessage).toContain("request-id=req-invalid-json-1");
    expect(warnMessage).not.toContain("not-json");
  });

  test("logs warning for direct hook validation reject and does not leak token or payload", async () => {
    const secretMessage = "sensitive-direct-message";
    const secretToken = "top-secret-token-direct";
    const logWarn = vi.fn();
    const logHooks = createLogHooks(logWarn);
    const hooksConfig = createHooksConfig();
    hooksConfig.token = secretToken;
    readJsonBodyMock.mockResolvedValue({
      ok: true,
      value: {
        message: secretMessage,
        channel: "invalid",
      },
    });

    const handler = createHooksHandler({
      logHooks,
      getHooksConfig: () => hooksConfig,
    });
    const req = createHookRequest({
      url: "/hooks/agent",
      authorization: `Bearer ${secretToken}`,
      headers: { "x-request-id": "req-direct-1" },
    });
    const { res, end } = createResponse();

    const handled = await handler(req, res);

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(400);
    expect(end).toHaveBeenCalledWith(JSON.stringify({ ok: false, error: getHookChannelError() }));
    const warnMessage = expectWarnLog(logWarn, "agent-channel-invalid");
    expect(warnMessage).toContain("path=agent");
    expect(warnMessage).toContain("reason=agent-channel-invalid");
    expect(warnMessage).not.toContain("top-secret-token-direct");
    expect(warnMessage).not.toContain(secretMessage);
  });

  test("logs warning for mapped validation reject and does not leak scalar raw body", async () => {
    const secretBody = "sensitive-mapped-body";
    const secretToken = "top-secret-token-mapped";
    const logWarn = vi.fn();
    const logHooks = createLogHooks(logWarn);
    readJsonBodyMock.mockResolvedValue({ ok: true, value: secretBody });

    const mappedConfig = createHooksConfig();
    mappedConfig.token = secretToken;
    mappedConfig.mappings = resolveHookMappings({
      mappings: [
        {
          id: "mapped-message-missing",
          match: { path: "mapped-message" },
          action: "agent",
        },
      ],
    });

    const handler = createHooksHandler({
      logHooks,
      getHooksConfig: () => mappedConfig,
    });
    const req = createHookRequest({
      authorization: `Bearer ${secretToken}`,
      url: "/hooks/mapped-message",
      headers: { "x-request-id": "req-mapped-1" },
    });
    const { res, end } = createResponse();

    const handled = await handler(req, res);

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(400);
    expect(end).toHaveBeenCalledWith(
      JSON.stringify({ ok: false, error: "hook mapping requires message" }),
    );
    const warnMessage = expectWarnLog(logWarn, "mapping-validation");
    expect(warnMessage).toContain("path=mapped-message");
    expect(warnMessage).toContain("reason=mapping-validation");
    expect(warnMessage).toContain("body-type=string");
    expect(warnMessage).not.toContain("top-secret-token-mapped");
    expect(warnMessage).not.toContain("sensitive-mapped-body");
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
    expectRetryAfterHeader(setHeader);
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
    expectRetryAfterHeader(setHeader);
  });

  test.each(["0.0.0.0", "::"])(
    "returns unhandled when bindHost=%s sees a non-hook request URL",
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
