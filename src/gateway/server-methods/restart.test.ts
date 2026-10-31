import { expectDefined } from "@openclaw/normalization-core";
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getGatewaySuspendAdmissionPhase,
  resetGatewayWorkAdmission,
  tryBeginGatewaySuspendAdmission,
} from "../../process/gateway-work-admission.js";
import { gatewayRequest } from "../request-frame.test-support.js";
import { handleGatewayRequest } from "../server-methods.js";
import { gatewayConnect } from "../server/client-fixtures.test-support.js";
import { restartHandlers } from "./restart.js";

const scheduleSafeGatewayRestart = vi.hoisted(() => vi.fn());
const createSafeGatewayRestartPreflight = vi.hoisted(() => vi.fn());
const requestGatewayRestartWithSignalAdmission = vi.hoisted(() => vi.fn());
const readActiveGatewayLockIdentity = vi.hoisted(() => vi.fn());

vi.mock("../../infra/restart-coordinator.js", () => ({
  createSafeGatewayRestartPreflight: () => createSafeGatewayRestartPreflight(),
  scheduleSafeGatewayRestart: (opts: unknown) => scheduleSafeGatewayRestart(opts),
}));

vi.mock("../../infra/restart.js", () => ({
  requestGatewayRestartWithSignalAdmission: (reason: unknown, intent: unknown) =>
    requestGatewayRestartWithSignalAdmission(reason, intent),
}));

vi.mock("../../infra/gateway-lock.js", () => ({
  readActiveGatewayLockIdentity: () => readActiveGatewayLockIdentity(),
}));

const restartTarget = { pid: process.pid, ownerId: "gateway-owner", port: 18_789 };
const activeLock = { ...restartTarget, createdAt: "2026-07-16T12:00:00.000Z" };
const targetedRequest = { reason: "operator", target: restartTarget };
const emittedReply = { ok: true, status: "emitted", pid: process.pid };

async function invokeHandler(
  method: keyof typeof restartHandlers,
  params: unknown,
  sessionMutationCommitGuard?: () => void,
) {
  const respond = vi.fn();
  const handler = expectDefined(restartHandlers[method], "restart handler");
  await handler({ respond, params, sessionMutationCommitGuard } as unknown as Parameters<
    typeof handler
  >[0]);
  return respond;
}

function invokeRestartRequest(params: unknown, guard?: () => void) {
  return invokeHandler("gateway.restart.request", params, guard);
}

function expectNoRestart() {
  expect(scheduleSafeGatewayRestart).not.toHaveBeenCalled();
  expect(requestGatewayRestartWithSignalAdmission).not.toHaveBeenCalled();
}

function expectError(respond: ReturnType<typeof vi.fn>, message: string, code = "INVALID_REQUEST") {
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
    req: gatewayRequest(`request-${crypto.randomUUID()}`, "gateway.restart.request", params),
    respond,
    client: {
      connId: `conn-${crypto.randomUUID()}`,
      clientIp: "127.0.0.1",
      connect: gatewayConnect(["operator.admin"], { id: "cli", platform: "linux", mode: "cli" }),
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
    scheduleSafeGatewayRestart.mockClear();
    createSafeGatewayRestartPreflight.mockReset();
    requestGatewayRestartWithSignalAdmission.mockReset();
    requestGatewayRestartWithSignalAdmission.mockReturnValue({ status: "emitted" });
    readActiveGatewayLockIdentity.mockReset();
    readActiveGatewayLockIdentity.mockResolvedValue(activeLock);
  });

  afterEach(() => {
    resetGatewayWorkAdmission();
  });

  it("refuses stale authority before targeted restart effects", async () => {
    await expect(
      invokeRestartRequest({ target: restartTarget }, () => {
        throw new Error("requester revoked");
      }),
    ).rejects.toThrow("requester revoked");
    expectNoRestart();
  });

  it("keeps the deprecated read-only preflight response shape", async () => {
    const preflight = {
      safe: false,
      counts: { queueSize: 1, totalActive: 1 },
      blockers: [{ kind: "queue", count: 1, message: "1 queued or active operation(s)" }],
      summary: "restart deferred: 1 queued or active operation(s)",
    };
    createSafeGatewayRestartPreflight.mockReturnValueOnce(preflight);

    const respond = await invokeHandler("gateway.restart.preflight", {});

    expect(respond).toHaveBeenCalledWith(true, preflight);
    expectNoRestart();
  });

  it.each([
    { restartIntent: { waitMs: 0 }, expected: { waitMs: 0 } },
    { restartIntent: { waitMs: MAX_TIMER_TIMEOUT_MS }, expected: { waitMs: MAX_TIMER_TIMEOUT_MS } },
    { restartIntent: { force: true }, expected: { force: true } },
    { restartIntent: { force: true, drainBudgetMs: 0 }, expected: { force: true, waitMs: 0 } },
  ])(
    "delivers a targeted restart only to the matching lock owner ($restartIntent)",
    async ({ restartIntent, expected }) => {
      const respond = await invokeRestartRequest({
        ...targetedRequest,
        restartIntent,
      });

      expect(scheduleSafeGatewayRestart).not.toHaveBeenCalled();
      expect(requestGatewayRestartWithSignalAdmission).toHaveBeenCalledWith("operator", {
        reason: "operator",
        ...expected,
      });
      expect(respond).toHaveBeenCalledWith(true, emittedReply);
    },
  );

  it("schedules a safe restart only after matching the target lock owner", async () => {
    scheduleSafeGatewayRestart.mockReturnValueOnce({ ok: true, status: "scheduled" });

    const respond = await invokeRestartRequest({
      ...targetedRequest,
      safe: true,
      skipDeferral: true,
    });

    expect(scheduleSafeGatewayRestart).toHaveBeenCalledWith({
      reason: "operator",
      skipDeferral: true,
    });
    expect(requestGatewayRestartWithSignalAdmission).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ ok: true, status: "scheduled" }),
    );
  });

  it("rejects an invalid targeted safe mode without restarting", async () => {
    const respond = await invokeRestartRequest({
      safe: "true",
      target: restartTarget,
    });

    expectNoRestart();
    expectError(respond, "invalid safe targeted restart mode");
  });

  it("retains prepared suspension when the exact restart target is stale", async () => {
    const suspension = prepareSuspension();
    readActiveGatewayLockIdentity.mockResolvedValue({
      ...activeLock,
      ownerId: "replacement-owner",
      createdAt: "2026-07-16T12:00:01.000Z",
    });

    const respond = await invokeRestartRequestThroughGateway(targetedRequest);

    expect(readActiveGatewayLockIdentity).toHaveBeenCalledOnce();
    expect(requestGatewayRestartWithSignalAdmission).not.toHaveBeenCalled();
    expectError(respond, "target gateway no longer owns the active lock");
    expect(getGatewaySuspendAdmissionPhase()).toBe("prepared");
    expect(suspension?.release()).toBe(true);
  });

  it("retains prepared suspension when exact restart delivery fails", async () => {
    const suspension = prepareSuspension();
    requestGatewayRestartWithSignalAdmission.mockReturnValueOnce({ status: "failed" });

    const respond = await invokeRestartRequestThroughGateway(targetedRequest);

    expect(readActiveGatewayLockIdentity).toHaveBeenCalledOnce();
    expect(requestGatewayRestartWithSignalAdmission).toHaveBeenCalledOnce();
    expectError(respond, "target gateway restart delivery failed", "UNAVAILABLE");
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

    const request = invokeRestartRequestThroughGateway(targetedRequest);
    await vi.waitFor(() => expect(readActiveGatewayLockIdentity).toHaveBeenCalledOnce());
    expect(suspension?.release()).toBe(true);
    resolveLock(activeLock);

    const respond = await request;
    expect(requestGatewayRestartWithSignalAdmission).toHaveBeenCalledOnce();
    expect(respond).toHaveBeenCalledWith(true, emittedReply);
  });

  it.each([
    { force: true, waitMs: 30_000 },
    { waitMs: MAX_TIMER_TIMEOUT_MS + 1 },
    { force: true, drainBudgetMs: MAX_TIMER_TIMEOUT_MS + 1 },
  ])("rejects an invalid targeted restart intent: %j", async (restartIntent) => {
    const respond = await invokeRestartRequest({ ...targetedRequest, restartIntent });
    expect(requestGatewayRestartWithSignalAdmission).not.toHaveBeenCalled();
    expectError(respond, "invalid targeted gateway restart intent");
  });

  it("backs off before an emoji that crosses the reason limit", async () => {
    await invokeRestartRequest({ reason: "x".repeat(199) + "🧠tail" });

    expect(scheduleSafeGatewayRestart).toHaveBeenCalledWith({
      reason: "x".repeat(199),
      skipDeferral: false,
    });
  });

  it("rejects non-object params without scheduling a restart", async () => {
    const respond = await invokeRestartRequest("operator");

    expect(scheduleSafeGatewayRestart).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledOnce();
    expectError(respond, "invalid gateway.restart.request params");
  });
});
