import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isRetryableGatewayStartupUnavailableError } from "../../packages/gateway-protocol/src/startup-unavailable.js";
import {
  resetGatewayWorkAdmission,
  tryBeginGatewaySuspendAdmission,
} from "../process/gateway-work-admission.js";
import {
  CONTROL_PLANE_RATE_LIMIT_MAX_REQUESTS,
  CONTROL_PLANE_RATE_LIMIT_WINDOW_MS,
} from "./control-plane-rate-limit.js";
import { STARTUP_UNAVAILABLE_GATEWAY_METHODS } from "./methods/core-method-policy.js";
import { handleGatewayRequest } from "./server-methods.js";
import type { GatewayRequestHandler } from "./server-methods/types.js";

let clientSequence = 0;

describe("gateway control-plane write rate limit", () => {
  beforeEach(() => {
    clientSequence += 1;
    resetGatewayWorkAdmission();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-19T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    resetGatewayWorkAdmission();
  });

  function setup() {
    const logWarn = vi.fn();
    const context = {
      getRuntimeConfig: () => ({}),
      logGateway: { warn: logWarn },
      unavailableGatewayMethods: new Set<string>(),
    } as unknown as Parameters<typeof handleGatewayRequest>[0]["context"];
    const client = {
      connect: {
        role: "operator",
        scopes: ["operator.admin"],
        client: { id: "openclaw-control-ui", version: "1.0.0", platform: "macos", mode: "ui" },
        minProtocol: 1,
        maxProtocol: 1,
      },
      connId: `conn-${clientSequence}`,
      clientIp: `10.0.0.${clientSequence}`,
    } as Parameters<typeof handleGatewayRequest>[0]["client"];
    const handler = vi.fn<GatewayRequestHandler>(({ respond }) => {
      respond(true, undefined, undefined);
    });
    async function request(method: string) {
      const respond = vi.fn();
      await handleGatewayRequest({
        req: { type: "req", id: crypto.randomUUID(), method },
        respond,
        client,
        isWebchatConnect: () => false,
        context,
        extraHandlers: { [method]: handler },
      });
      return respond;
    }
    async function exhaust(method: string) {
      for (let attempt = 0; attempt < CONTROL_PLANE_RATE_LIMIT_MAX_REQUESTS; attempt += 1) {
        await request(method);
      }
      return request(method);
    }
    return { context, handler, request, exhaust, logWarn };
  }

  function expectRateLimited(respond: ReturnType<typeof vi.fn>) {
    expect(respond.mock.calls[0]).toEqual([
      false,
      undefined,
      expect.objectContaining({ code: "UNAVAILABLE", retryable: true }),
    ]);
  }

  it.each(["config.patch", "cron.add"])(
    "bounds the control-plane write budget for %s",
    async (method) => {
      const { handler, exhaust, logWarn } = setup();
      expectRateLimited(await exhaust(method));
      expect(handler).toHaveBeenCalledTimes(CONTROL_PLANE_RATE_LIMIT_MAX_REQUESTS);
      expect(logWarn).toHaveBeenCalledTimes(1);
    },
  );

  it("allows the OpenClaw inference ladder to probe more than 3 candidates", async () => {
    const { handler, request } = setup();
    const payload = { ok: false, status: "auth", error: "candidate failed" };
    handler.mockImplementation(({ respond }) => respond(true, payload, undefined));
    for (let attempt = 0; attempt < 4; attempt += 1) {
      expect(await request("openclaw.setup.activate")).toHaveBeenCalledWith(
        true,
        payload,
        undefined,
      );
    }
    expect(handler).toHaveBeenCalledTimes(4);
  });

  it("resets the control-plane write budget after 60 seconds", async () => {
    const { handler, request, exhaust, logWarn } = setup();
    expectRateLimited(await exhaust("update.run"));
    expect(logWarn).toHaveBeenCalledOnce();

    vi.advanceTimersByTime(CONTROL_PLANE_RATE_LIMIT_WINDOW_MS + 1);

    expect(await request("update.run")).toHaveBeenCalledWith(true, undefined, undefined);
    expect(handler).toHaveBeenCalledTimes(CONTROL_PLANE_RATE_LIMIT_MAX_REQUESTS + 1);
  });

  it("does not consume the write budget for requests refused during suspension", async () => {
    const { handler, request } = setup();
    const suspension = tryBeginGatewaySuspendAdmission(() => {});
    expect(suspension?.commit()).toBe(true);

    for (let attempt = 0; attempt < 4; attempt += 1) {
      const refused = await request("config.patch");
      expect(refused.mock.calls[0]?.[2]).toMatchObject({
        code: "UNAVAILABLE",
        details: { reason: "gateway-suspending" },
      });
    }
    expect(suspension?.release()).toBe(true);

    expect(await request("config.patch")).toHaveBeenCalledWith(true, undefined, undefined);
    expect(handler).toHaveBeenCalledOnce();
  });

  it("keeps suspension preparation rate-limited while admission is closed", async () => {
    const { handler, exhaust } = setup();
    const suspension = tryBeginGatewaySuspendAdmission(() => {});
    expect(suspension?.commit()).toBe(true);

    expectRateLimited(await exhaust("gateway.suspend.prepare"));
    expect(handler).toHaveBeenCalledTimes(CONTROL_PLANE_RATE_LIMIT_MAX_REQUESTS);
    expect(suspension?.release()).toBe(true);
  });

  it("blocks a startup-gated method before dispatch with a retryable startup error", async () => {
    const method = "sessions.list";
    const { context, handler, request } = setup();
    context.unavailableGatewayMethods = new Set(STARTUP_UNAVAILABLE_GATEWAY_METHODS);
    const blocked = await request(method);
    expect(handler).not.toHaveBeenCalled();
    expect(blocked.mock.calls[0]).toEqual([
      false,
      undefined,
      expect.objectContaining({
        code: "UNAVAILABLE",
        retryable: true,
        retryAfterMs: 500,
        details: { reason: "startup-sidecars", method },
      }),
    ]);
    const error = blocked.mock.calls[0]?.[2];
    expect(isRetryableGatewayStartupUnavailableError(error)).toBe(true);
  });
});
