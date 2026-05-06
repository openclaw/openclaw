import { afterEach, describe, expect, test, vi } from "vitest";
import * as logger from "../logger.js";
import {
  OPENCLAW_GATEWAY_CLIENT_TIMING_DEBUG,
  __testing,
  createGatewayClientTimingSession,
  emitGatewayClientTimingEvent,
  isGatewayClientTimingDebugEnabled,
  sanitizeGatewayClientTimingPayload,
} from "./gateway-client-timing.js";

describe("gateway-client-timing", () => {
  afterEach(() => {
    __testing.resetEnv(process.env);
    vi.restoreAllMocks();
  });

  test("debug gate is off unless env is exactly 1", () => {
    __testing.resetEnv(process.env);
    expect(isGatewayClientTimingDebugEnabled(process.env)).toBe(false);
    process.env[OPENCLAW_GATEWAY_CLIENT_TIMING_DEBUG] = "0";
    expect(isGatewayClientTimingDebugEnabled(process.env)).toBe(false);
    process.env[OPENCLAW_GATEWAY_CLIENT_TIMING_DEBUG] = "true";
    expect(isGatewayClientTimingDebugEnabled(process.env)).toBe(false);
    process.env[OPENCLAW_GATEWAY_CLIENT_TIMING_DEBUG] = "1";
    expect(isGatewayClientTimingDebugEnabled(process.env)).toBe(true);
  });

  test("createGatewayClientTimingSession returns undefined when debug off", () => {
    __testing.resetEnv(process.env);
    expect(createGatewayClientTimingSession("cron.list", "rpc", process.env)).toBeUndefined();
  });

  test("debug on emits only allow-listed timing fields via logDebug", () => {
    process.env[OPENCLAW_GATEWAY_CLIENT_TIMING_DEBUG] = "1";
    const spy = vi.spyOn(logger, "logDebug").mockImplementation(() => {});
    const session = createGatewayClientTimingSession("cron.list", "rpc", process.env);
    expect(session).toBeDefined();
    session?.emit("request_send", true);
    expect(spy).toHaveBeenCalledTimes(1);
    const line = spy.mock.calls[0]?.[0] ?? "";
    expect(line).toContain("gateway.client.timing");
    const jsonPart = line.slice(line.indexOf("{"));
    const parsed = JSON.parse(jsonPart) as Record<string, unknown>;
    expect(Object.keys(parsed).toSorted()).toEqual(
      ["elapsedMs", "method", "ok", "requestKind", "stage"].toSorted(),
    );
    expect(parsed.stage).toBe("request_send");
    expect(parsed.method).toBe("cron.list");
    expect(parsed.requestKind).toBe("rpc");
    expect(parsed.ok).toBe(true);
    expect(typeof parsed.elapsedMs).toBe("number");
  });

  test("hostile sentinel strings never appear in emitted diagnostics", () => {
    process.env[OPENCLAW_GATEWAY_CLIENT_TIMING_DEBUG] = "1";
    const spy = vi.spyOn(logger, "logDebug").mockImplementation(() => {});
    const token = "sk-ant-api03-SENTINEL_TOKEN_DO_NOT_LEAK_0123456789abcdef";
    const winPath = "C:\\Users\\SENTINEL_USER\\.openclaw\\secrets.json";
    const url = "https://evil.example.com/sentinel-hook?token=supersecret";
    const err = new Error(
      `boom ${token} ${winPath} ${url} cmd=/bin/sh job=prompt delivery=x session=prof`,
    );
    err.name = "SentinelError";
    emitGatewayClientTimingEvent(
      {
        stage: "request_settle",
        elapsedMs: 12,
        ok: false,
        method: "cron.list",
        requestKind: "rpc",
        errorName: err.name,
        errorCode: "SENTINEL_CODE",
        leakToken: token,
        leakPath: winPath,
        leakUrl: url,
      },
      process.env,
    );
    expect(spy).toHaveBeenCalledTimes(1);
    const line = spy.mock.calls[0]?.[0] ?? "";
    expect(line).not.toContain(token);
    expect(line).not.toContain(winPath);
    expect(line).not.toContain(url);
    expect(line).not.toContain("sk-ant-api03");
    expect(line).not.toContain("evil.example.com");
    expect(line).toContain("SentinelError");
    expect(line).toContain("SENTINEL_CODE");
  });

  test("sanitize strips unknown stages and extra keys", () => {
    const malicious = {
      stage: "not_a_real_stage",
      elapsedMs: 1,
      ok: true,
      method: "cron.list",
      requestKind: "rpc",
      extraEvil: "sk-not-in-output",
    };
    expect(sanitizeGatewayClientTimingPayload(malicious)).toBeNull();
    const ok = sanitizeGatewayClientTimingPayload({
      stage: "ws_open",
      elapsedMs: 2,
      ok: true,
      method: "connect",
      requestKind: "rpc",
      extraEvil: "should-not-appear",
    });
    expect(ok).not.toBeNull();
    if (!ok) {
      throw new Error("expected sanitized timing payload");
    }
    expect(Object.keys(ok)).not.toContain("extraEvil");
  });

  test("sanitize rejects unsafe timing identifiers", () => {
    expect(
      sanitizeGatewayClientTimingPayload({
        stage: "ws_open",
        elapsedMs: 2,
        ok: true,
        method: "cron.list sk-ant-api03-SENTINEL_TOKEN_DO_NOT_LEAK",
        requestKind: "rpc",
      }),
    ).toBeNull();
    expect(
      sanitizeGatewayClientTimingPayload({
        stage: "ws_open",
        elapsedMs: 2,
        ok: true,
        method: "connect",
        requestKind: "rpc https://evil.example.com/sentinel-hook",
      }),
    ).toBeNull();
    const ok = sanitizeGatewayClientTimingPayload({
      stage: "request_settle",
      elapsedMs: -2,
      ok: false,
      method: "cron.list",
      requestKind: "rpc",
      errorName: "Error with details",
      errorCode: "E_CRON_TIMEOUT",
    });
    expect(ok).toEqual({
      stage: "request_settle",
      elapsedMs: 0,
      ok: false,
      method: "cron.list",
      requestKind: "rpc",
      errorCode: "E_CRON_TIMEOUT",
    });
  });

  test("sanitize rejects non-finite elapsedMs", () => {
    expect(
      sanitizeGatewayClientTimingPayload({
        stage: "ws_open",
        elapsedMs: Number.NaN,
        ok: true,
        method: "m",
        requestKind: "rpc",
      }),
    ).toBeNull();
  });
});
