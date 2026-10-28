import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  resetGatewayWorkAdmission,
  tryBeginGatewaySuspendAdmission,
} from "../process/gateway-work-admission.js";
import { CONTROL_PLANE_RATE_LIMIT_MAX_REQUESTS } from "./control-plane-rate-limit.js";
import { STARTUP_UNAVAILABLE_GATEWAY_METHODS } from "./methods/core-method-policy.js";
import { sendAuthorizationRequest } from "./server-methods.authorization.test-support.js";
import type { GatewayRequestHandler } from "./server-methods/types.js";

let clientSequence = 0;

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
  const context = {
    unavailableGatewayMethods: new Set<string>(),
  };
  const handler = vi.fn<GatewayRequestHandler>(({ respond }) => {
    respond(true, undefined, undefined);
  });
  const request = (method: string) =>
    sendAuthorizationRequest(method, undefined, {
      connId: `conn-${clientSequence}`,
      scopes: ["operator.admin"],
      context,
      extraHandlers: { [method]: handler },
    });
  async function exhaust(method: string) {
    for (let attempt = 0; attempt < CONTROL_PLANE_RATE_LIMIT_MAX_REQUESTS; attempt += 1) {
      await request(method);
    }
    return request(method);
  }
  return { context, handler, request, exhaust };
}

function expectBudgetResult(respond: ReturnType<typeof vi.fn>, allowed = false) {
  expect(respond.mock.calls[0]).toEqual([
    allowed,
    undefined,
    allowed ? undefined : expect.objectContaining({ code: "UNAVAILABLE", retryable: true }),
  ]);
}

it.each([
  ["config.patch", false],
  ["cron.add", false],
  ["openclaw.setup.activate", true],
] as const)("applies the control-plane budget to %s (exempt=%s)", async (method, exempt) => {
  const { handler, exhaust } = setup();
  expectBudgetResult(await exhaust(method), exempt);
  expect(handler).toHaveBeenCalledTimes(CONTROL_PLANE_RATE_LIMIT_MAX_REQUESTS + Number(exempt));
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

  expectBudgetResult(await exhaust("gateway.suspend.prepare"));
  expect(handler).toHaveBeenCalledTimes(CONTROL_PLANE_RATE_LIMIT_MAX_REQUESTS);
  expect(suspension?.release()).toBe(true);
});

it("blocks a startup-gated method before dispatch with a retryable startup error", async () => {
  const method = "chat.send";
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
});
