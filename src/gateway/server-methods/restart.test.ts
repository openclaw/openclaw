// Restart method tests cover safe restart scheduling, deferral flags, and
// response payloads returned by gateway.restart.request.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { restartHandlers } from "./restart.js";

const requestSafeGatewayRestart = vi.hoisted(() => vi.fn());

vi.mock("../../infra/restart-coordinator.js", () => ({
  createSafeGatewayRestartPreflight: vi.fn(() => ({
    safe: true,
    counts: {
      queueSize: 0,
      pendingReplies: 0,
      embeddedRuns: 0,
      activeTasks: 0,
      totalActive: 0,
    },
    blockers: [],
    summary: "safe to restart now",
  })),
  requestSafeGatewayRestart: (opts: unknown) => requestSafeGatewayRestart(opts),
}));

function invokeRestartRequest(params: unknown) {
  const respond = vi.fn();
  const handler = restartHandlers["gateway.restart.request"];
  return Promise.resolve(
    handler({
      respond,
      params,
      // The handler only reads `params` and `respond`; remaining fields are unused.
    } as unknown as Parameters<typeof handler>[0]),
  ).then(() => respond);
}

function mockScheduledRestart(preflight: { safe: boolean; summary: string }) {
  requestSafeGatewayRestart.mockReturnValueOnce({
    ok: true,
    status: "scheduled",
    preflight: { ...preflight, counts: {}, blockers: [] },
    restart: {
      ok: true,
      pid: 0,
      signal: "SIGUSR1",
      delayMs: 0,
      mode: "emit",
      coalesced: false,
      cooldownMsApplied: 0,
    },
  });
}

function expectRestartRequest(params: {
  skipDeferral: boolean;
  activeWorkInterruptApproved?: boolean;
}) {
  expect(requestSafeGatewayRestart).toHaveBeenCalledWith(
    expect.objectContaining({
      reason: "operator",
      delayMs: 0,
      skipDeferral: params.skipDeferral,
      activeWorkInterruptApproved: params.activeWorkInterruptApproved ?? false,
      requester: "actor=unknown-actor device=unknown-device ip=unknown-ip conn=unknown-conn",
      audit: {
        actor: "unknown-actor",
        deviceId: "unknown-device",
        clientIp: "unknown-ip",
      },
    }),
  );
}

describe("gateway.restart.request handler", () => {
  beforeEach(() => {
    requestSafeGatewayRestart.mockClear();
  });

  it("defaults to skipDeferral: false when the param is absent", async () => {
    mockScheduledRestart({ safe: true, summary: "safe to restart now" });

    await invokeRestartRequest({ reason: "operator" });

    expectRestartRequest({ skipDeferral: false });
  });

  it("forwards skipDeferral: true only when params.skipDeferral === true", async () => {
    mockScheduledRestart({ safe: false, summary: "" });

    await invokeRestartRequest({ reason: "operator", skipDeferral: true });

    expectRestartRequest({ skipDeferral: true });
  });

  it("forwards active-work interruption approval only when explicitly true", async () => {
    mockScheduledRestart({ safe: false, summary: "" });

    await invokeRestartRequest({
      reason: "operator",
      skipDeferral: true,
      interruptActiveWork: true,
    });

    expectRestartRequest({
      skipDeferral: true,
      activeWorkInterruptApproved: true,
    });
  });

  it("normalizes truthy non-boolean skipDeferral values to false", async () => {
    mockScheduledRestart({ safe: true, summary: "safe to restart now" });

    await invokeRestartRequest({ reason: "operator", skipDeferral: "true" });

    expectRestartRequest({ skipDeferral: false });
  });

  it("forwards skipDeferral: false explicitly when the param is sent as false", async () => {
    mockScheduledRestart({ safe: true, summary: "safe to restart now" });

    await invokeRestartRequest({ reason: "operator", skipDeferral: false });

    expectRestartRequest({ skipDeferral: false });
  });

  it("rejects non-object params without scheduling a restart", async () => {
    const respond = await invokeRestartRequest("operator");

    expect(requestSafeGatewayRestart).not.toHaveBeenCalled();
    expect(respond.mock.calls).toEqual([
      [
        false,
        undefined,
        {
          code: "INVALID_REQUEST",
          message: "invalid gateway.restart.request params",
        },
      ],
    ]);
  });

  it("rejects array params without scheduling a restart", async () => {
    const respond = await invokeRestartRequest([]);

    expect(requestSafeGatewayRestart).not.toHaveBeenCalled();
    expect(respond.mock.calls).toEqual([
      [
        false,
        undefined,
        {
          code: "INVALID_REQUEST",
          message: "invalid gateway.restart.request params",
        },
      ],
    ]);
  });
});
