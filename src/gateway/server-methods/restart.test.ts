import { expectDefined } from "@openclaw/normalization-core";
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getGatewaySuspendAdmissionPhase,
  resetGatewayWorkAdmission,
  tryBeginGatewaySuspendAdmission,
} from "../../process/gateway-work-admission.js";
import { handleGatewayRequest } from "../server-methods.js";
import { restartHandlers } from "./restart.js";

const scheduleSafeGatewayRestart = vi.hoisted(() => vi.fn());
const createSafeGatewayRestartPreflight = vi.hoisted(() => vi.fn());
const requestGatewayRestartWithSignalAdmission = vi.hoisted(() => vi.fn());
const readActiveGatewayLockIdentity = vi.hoisted(() => vi.fn());

vi.mock("../../infra/restart-coordinator.js", () => ({
  createSafeGatewayRestartPreflight,
  scheduleSafeGatewayRestart,
}));

vi.mock("../../infra/restart.js", () => ({
  requestGatewayRestartWithSignalAdmission,
}));

vi.mock("../../infra/gateway-lock.js", () => ({
  readActiveGatewayLockIdentity,
}));

const restartTarget = { pid: process.pid, ownerId: "gateway-owner", port: 18_789 };

async function invokeHandler(method: string, params: unknown) {
  const respond = vi.fn();
  const handler = expectDefined(restartHandlers[method], `handler ${method}`);
  // These handlers only read params/respond; the router tests below supply full requests.
  await handler({ respond, params } as Parameters<typeof handler>[0]);
  return respond;
}

function invokeRestartRequest(params: unknown) {
  return invokeHandler("gateway.restart.request", params);
}

function invokeTargetedRestart(params: Record<string, unknown> = {}) {
  return invokeRestartRequest({ reason: "operator", target: restartTarget, ...params });
}

function expectEmitted(respond: ReturnType<typeof vi.fn>) {
  expect(respond).toHaveBeenCalledWith(true, { ok: true, status: "emitted", pid: process.pid });
}

function expectRejected(
  respond: ReturnType<typeof vi.fn>,
  message: string,
  code = "INVALID_REQUEST",
) {
  expect(respond).toHaveBeenCalledWith(false, undefined, { code, message });
}

function prepareSuspension() {
  const suspension = tryBeginGatewaySuspendAdmission(() => {});
  expect(suspension?.commit()).toBe(true);
  return suspension;
}

async function invokeRestartRequestThroughGateway(params: unknown) {
  const respond = vi.fn();
  const handler = expectDefined(
    restartHandlers["gateway.restart.request"],
    'restartHandlers["gateway.restart.request"] test invariant',
  );
  await handleGatewayRequest({
    req: {
      type: "req",
      id: `request-${crypto.randomUUID()}`,
      method: "gateway.restart.request",
      params,
    },
    respond,
    client: {
      connId: `conn-${crypto.randomUUID()}`,
      clientIp: "127.0.0.1",
      connect: {
        role: "operator",
        scopes: ["operator.admin"],
        client: { id: "cli", version: "test", platform: "linux", mode: "cli" },
        minProtocol: 1,
        maxProtocol: 1,
      },
    },
    isWebchatConnect: () => false,
    context: { logGateway: { warn: vi.fn() } } as unknown as Parameters<
      typeof handleGatewayRequest
    >[0]["context"],
    extraHandlers: { "gateway.restart.request": handler },
  });
  return respond;
}

describe("gateway restart handlers", () => {
  beforeEach(() => {
    resetGatewayWorkAdmission();
    scheduleSafeGatewayRestart.mockReset().mockReturnValue({ ok: true, status: "scheduled" });
    createSafeGatewayRestartPreflight.mockReset();
    requestGatewayRestartWithSignalAdmission.mockReset();
    requestGatewayRestartWithSignalAdmission.mockReturnValue({ status: "emitted" });
    readActiveGatewayLockIdentity.mockReset();
    readActiveGatewayLockIdentity.mockResolvedValue(restartTarget);
  });

  afterEach(() => {
    resetGatewayWorkAdmission();
  });

  it("keeps the deprecated read-only preflight response shape", async () => {
    const preflight = {
      safe: false,
      counts: {
        queueSize: 1,
        totalActive: 1,
      },
      blockers: [{ kind: "queue", count: 1, message: "1 queued or active operation(s)" }],
      summary: "restart deferred: 1 queued or active operation(s)",
    };
    createSafeGatewayRestartPreflight.mockReturnValueOnce(preflight);

    const respond = await invokeHandler("gateway.restart.preflight", {});

    expect(respond).toHaveBeenCalledWith(true, preflight);
    expect(scheduleSafeGatewayRestart).not.toHaveBeenCalled();
    expect(requestGatewayRestartWithSignalAdmission).not.toHaveBeenCalled();
  });

  it.each([
    { restartIntent: { waitMs: 0 }, expected: { waitMs: 0 } },
    { restartIntent: { force: true }, expected: { force: true } },
    { restartIntent: { force: true, drainBudgetMs: 0 }, expected: { force: true, waitMs: 0 } },
    { restartIntent: { waitMs: MAX_TIMER_TIMEOUT_MS }, expected: { waitMs: MAX_TIMER_TIMEOUT_MS } },
  ])(
    "delivers a targeted restart only to the matching lock owner ($restartIntent)",
    async ({ restartIntent, expected }) => {
      const respond = await invokeTargetedRestart({ restartIntent });

      expect(scheduleSafeGatewayRestart).not.toHaveBeenCalled();
      expect(requestGatewayRestartWithSignalAdmission).toHaveBeenCalledWith("operator", {
        reason: "operator",
        ...expected,
      });
      expectEmitted(respond);
    },
  );

  it("schedules a safe restart only after matching the target lock owner", async () => {
    const respond = await invokeTargetedRestart({ safe: true, skipDeferral: true });

    expect(scheduleSafeGatewayRestart).toHaveBeenCalledWith({
      reason: "operator",
      delayMs: 0,
      skipDeferral: true,
    });
    expect(requestGatewayRestartWithSignalAdmission).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ ok: true, status: "scheduled" }),
    );
  });

  it("rejects an invalid targeted safe mode without restarting", async () => {
    const respond = await invokeTargetedRestart({ safe: "true" });

    expect(scheduleSafeGatewayRestart).not.toHaveBeenCalled();
    expect(requestGatewayRestartWithSignalAdmission).not.toHaveBeenCalled();
    expectRejected(respond, "invalid safe targeted restart mode");
  });

  it.each([
    {
      failure: "stale target",
      code: "INVALID_REQUEST",
      message: "target gateway no longer owns the active lock",
      signals: 0,
    },
    {
      failure: "delivery failure",
      code: "UNAVAILABLE",
      message: "target gateway restart delivery failed",
      signals: 1,
    },
  ])("retains prepared suspension after $failure", async ({ code, message, signals }) => {
    const suspension = prepareSuspension();
    if (signals === 0) {
      readActiveGatewayLockIdentity.mockResolvedValue({
        ...restartTarget,
        ownerId: "replacement-owner",
      });
    } else {
      requestGatewayRestartWithSignalAdmission.mockReturnValueOnce({ status: "failed" });
    }

    const respond = await invokeRestartRequestThroughGateway({
      reason: "operator",
      target: restartTarget,
    });

    expect(readActiveGatewayLockIdentity).toHaveBeenCalledOnce();
    expect(requestGatewayRestartWithSignalAdmission).toHaveBeenCalledTimes(signals);
    expectRejected(respond, message, code);
    expect(getGatewaySuspendAdmissionPhase()).toBe("prepared");
    expect(suspension?.release()).toBe(true);
  });

  it("finishes an admitted exact restart after suspension resumes", async () => {
    let resolveLock: (value: unknown) => void = () => {};
    readActiveGatewayLockIdentity.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveLock = resolve;
      }),
    );
    const suspension = prepareSuspension();

    const request = invokeRestartRequestThroughGateway({
      reason: "operator",
      target: restartTarget,
    });
    await vi.waitFor(() => expect(readActiveGatewayLockIdentity).toHaveBeenCalledOnce());
    expect(suspension?.release()).toBe(true);
    resolveLock(restartTarget);

    const respond = await request;
    expect(requestGatewayRestartWithSignalAdmission).toHaveBeenCalledOnce();
    expectEmitted(respond);
  });

  it.each([
    { force: true, waitMs: 30_000 },
    { waitMs: MAX_TIMER_TIMEOUT_MS + 1 },
    { force: true, drainBudgetMs: MAX_TIMER_TIMEOUT_MS + 1 },
  ])("rejects an invalid targeted restart intent: %j", async (restartIntent) => {
    const respond = await invokeTargetedRestart({ restartIntent });

    expect(requestGatewayRestartWithSignalAdmission).not.toHaveBeenCalled();
    expectRejected(respond, "invalid targeted gateway restart intent");
  });

  it("backs off before an emoji that crosses the reason limit", async () => {
    await invokeRestartRequest({ reason: "x".repeat(199) + "🧠tail" });

    expect(scheduleSafeGatewayRestart).toHaveBeenCalledWith({
      reason: "x".repeat(199),
      delayMs: 0,
      skipDeferral: false,
    });
  });

  it("rejects non-object params without scheduling a restart", async () => {
    const respond = await invokeRestartRequest("operator");

    expect(scheduleSafeGatewayRestart).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledExactlyOnceWith(false, undefined, {
      code: "INVALID_REQUEST",
      message: "invalid gateway.restart.request params",
    });
  });
});
