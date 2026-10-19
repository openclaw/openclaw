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
const lockIdentity = { ...restartTarget, createdAt: "2026-07-16T12:00:00.000Z" };

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

function mockScheduledRestart(preflight: { safe: boolean; summary: string }) {
  scheduleSafeGatewayRestart.mockReturnValueOnce({
    ok: true,
    status: "scheduled",
    preflight: { ...preflight, counts: {}, blockers: [] },
  });
}

describe("gateway restart handlers", () => {
  beforeEach(() => {
    resetGatewayWorkAdmission();
    scheduleSafeGatewayRestart.mockClear();
    createSafeGatewayRestartPreflight.mockReset();
    requestGatewayRestartWithSignalAdmission.mockReset();
    requestGatewayRestartWithSignalAdmission.mockReturnValue({ status: "emitted" });
    readActiveGatewayLockIdentity.mockReset();
    readActiveGatewayLockIdentity.mockResolvedValue(lockIdentity);
  });

  afterEach(() => {
    resetGatewayWorkAdmission();
  });

  it("keeps the deprecated read-only preflight response shape", async () => {
    const preflight = {
      safe: false,
      counts: {
        queueSize: 1,
        pendingReplies: 2,
        embeddedRuns: 3,
        cronRuns: 4,
        backgroundExecSessions: 5,
        rootRequests: 6,
        agentRuns: 7,
        acpRuns: 0,
        mediaRuns: 0,
        totalActive: 28,
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
    mockScheduledRestart({ safe: false, summary: "restart deferred" });

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

  it("retains prepared suspension when the exact restart target is stale", async () => {
    const suspension = prepareSuspension();
    readActiveGatewayLockIdentity.mockResolvedValue({
      ...lockIdentity,
      ownerId: "replacement-owner",
      createdAt: "2026-07-16T12:00:01.000Z",
    });

    const respond = await invokeRestartRequestThroughGateway({
      reason: "operator",
      target: restartTarget,
    });

    expect(readActiveGatewayLockIdentity).toHaveBeenCalledOnce();
    expect(requestGatewayRestartWithSignalAdmission).not.toHaveBeenCalled();
    expectRejected(respond, "target gateway no longer owns the active lock");
    expect(getGatewaySuspendAdmissionPhase()).toBe("prepared");
    expect(suspension?.release()).toBe(true);
  });

  it("retains prepared suspension when exact restart delivery fails", async () => {
    const suspension = prepareSuspension();
    requestGatewayRestartWithSignalAdmission.mockReturnValueOnce({ status: "failed" });

    const respond = await invokeRestartRequestThroughGateway({
      reason: "operator",
      target: restartTarget,
    });

    expect(readActiveGatewayLockIdentity).toHaveBeenCalledOnce();
    expect(requestGatewayRestartWithSignalAdmission).toHaveBeenCalledOnce();
    expectRejected(respond, "target gateway restart delivery failed", "UNAVAILABLE");
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
    resolveLock(lockIdentity);

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
    mockScheduledRestart({ safe: true, summary: "safe to restart now" });

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
