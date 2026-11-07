import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayPendingRequests } from "../../../packages/gateway-client/src/pending-request.js";
import {
  GatewayClientRequestError,
  GatewayClientRequestTimeoutError,
} from "../../../packages/gateway-client/src/request-error.js";
import type { GatewayClient } from "../../../src/gateway/client.ts";
import { disableWorkshopWhenIdle } from "./skill-workshop-plugin-enable.test-support.ts";

const { delay } = vi.hoisted(() => ({ delay: vi.fn<(ms: number) => Promise<void>>() }));
vi.mock("node:timers/promises", () => ({ setTimeout: delay }));

async function refusal(overrides: ConstructorParameters<typeof GatewayClientRequestError>[0] = {}) {
  const pending = new GatewayPendingRequests({
    createRequestId: () => "workshop-cleanup",
    nowMs: Date.now,
    createRequestError: (error) => new GatewayClientRequestError(error),
  });
  let requestId = "";
  const response = pending.request(
    {
      send(data) {
        const frame: unknown = JSON.parse(data);
        if (!isRecord(frame) || typeof frame.id !== "string") {
          throw new Error("Gateway request omitted its ID");
        }
        requestId = frame.id;
      },
    },
    "plugins.setEnabled",
  );
  pending.handleResponse({
    type: "res",
    id: requestId,
    ok: false,
    error: {
      code: "UNAVAILABLE",
      message: "plugin lifecycle busy",
      retryable: true,
      retryAfterMs: 1_000,
      details: { mutationAccepted: false },
      ...overrides,
    },
  });
  return await response.catch((error: unknown) => error);
}

describe("Skill Workshop cleanup admission", () => {
  let now = 0;
  beforeEach(() => {
    now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    delay.mockReset().mockImplementation(async (ms) => {
      now += ms;
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it("waits for a correlated refusal before repeating only the disable request", async () => {
    const request = vi.fn<GatewayClient["request"]>();
    request.mockRejectedValueOnce(await refusal()).mockResolvedValueOnce({});
    await disableWorkshopWhenIdle({ request });
    expect(delay).toHaveBeenCalledExactlyOnceWith(1_000);
    expect(request.mock.calls).toEqual([
      ["plugins.setEnabled", { pluginId: "skill-workshop", enabled: false }, { timeoutMs: 20_000 }],
      ["plugins.setEnabled", { pluginId: "skill-workshop", enabled: false }, { timeoutMs: 20_000 }],
    ]);
  });

  it.each([
    { name: "accepted mutation", details: { mutationAccepted: true } },
    { name: "unknown acceptance", details: {} },
    { name: "missing details", details: undefined },
    { name: "non-retryable response", retryable: false },
    { name: "different error code", code: "INVALID_REQUEST" },
    { name: "missing delay", retryAfterMs: undefined },
    { name: "zero delay", retryAfterMs: 0 },
    { name: "negative delay", retryAfterMs: -1 },
    { name: "nonfinite delay", retryAfterMs: Number.POSITIVE_INFINITY },
    { name: "invalid delay", retryAfterMs: Number.NaN },
    { name: "delay reaches deadline", retryAfterMs: 60_000 },
  ])("does not replay a $name", async ({ name: _name, ...overrides }) => {
    const error = await refusal(overrides);
    const request = vi.fn<GatewayClient["request"]>().mockRejectedValue(error);
    await expect(disableWorkshopWhenIdle({ request })).rejects.toBe(error);
    expect(request).toHaveBeenCalledOnce();
    expect(delay).not.toHaveBeenCalled();
  });

  it.each([
    new GatewayClientRequestError({
      code: "UNAVAILABLE",
      retryable: true,
      retryAfterMs: 1_000,
      details: { mutationAccepted: false },
    }),
    new GatewayClientRequestTimeoutError({
      method: "plugins.setEnabled",
      timeoutMs: 20_000,
      requestSent: true,
    }),
    new Error("socket closed"),
  ])("does not replay an uncorrelated error: $name", async (error) => {
    const request = vi.fn<GatewayClient["request"]>().mockRejectedValue(error);
    await expect(disableWorkshopWhenIdle({ request })).rejects.toBe(error);
    expect(request).toHaveBeenCalledOnce();
    expect(delay).not.toHaveBeenCalled();
  });

  it("bounds each request by the remaining admission deadline", async () => {
    const request = vi.fn<GatewayClient["request"]>();
    request
      .mockRejectedValueOnce(await refusal({ retryAfterMs: 50_000 }))
      .mockResolvedValueOnce({});
    await disableWorkshopWhenIdle({ request });
    expect(request.mock.calls[1]?.[2]).toEqual({ timeoutMs: 10_000 });
  });

  it("does not dispatch again when the wait consumes the deadline", async () => {
    const error = await refusal();
    const request = vi.fn<GatewayClient["request"]>().mockRejectedValue(error);
    delay.mockImplementationOnce(async () => {
      now = 60_000;
    });
    await expect(disableWorkshopWhenIdle({ request })).rejects.toBe(error);
    expect(request).toHaveBeenCalledOnce();
    expect(delay).toHaveBeenCalledExactlyOnceWith(1_000);
  });
});
