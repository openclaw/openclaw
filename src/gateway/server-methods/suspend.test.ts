import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { suspendHandlers } from "./suspend.js";

const coordinator = vi.hoisted(() => ({
  prepare: vi.fn(),
  status: vi.fn(),
  resume: vi.fn(),
}));

vi.mock("../../infra/gateway-suspend-coordinator.js", () => ({
  prepareGatewaySuspend: coordinator.prepare,
  getGatewaySuspendStatus: coordinator.status,
  resumeGatewaySuspend: coordinator.resume,
}));

vi.mock("../server-active-work.js", () => ({
  createGatewayServerActiveWorkInspectors: vi.fn(() => ({ getChatRuns: vi.fn(() => 0) })),
}));

async function invoke(method: keyof typeof suspendHandlers, params: unknown) {
  const respond = vi.fn();
  const handler = expectDefined(suspendHandlers[method], "suspendHandlers[method] test invariant");
  await handler({
    params,
    respond,
    context: {
      cron: { pauseScheduling: vi.fn(), resumeScheduling: vi.fn() },
      logGateway: { warn: vi.fn(), info: vi.fn() },
    },
  } as unknown as Parameters<typeof handler>[0]);
  return { respond };
}

beforeEach(() => vi.clearAllMocks());

describe("gateway suspend handlers", () => {
  it("validates the closed prepare params shape", async () => {
    const { respond } = await invoke("gateway.suspend.prepare", {
      requestId: "request-1",
      extra: true,
    });

    expect(coordinator.prepare).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(false, undefined, {
      code: "INVALID_REQUEST",
      message: "invalid gateway.suspend.prepare params",
    });
  });

  it("maps a competing prepared lease to retryable unavailable", async () => {
    coordinator.prepare.mockReturnValueOnce({ status: "conflict", expiresAtMs: Date.now() + 5000 });
    const { respond } = await invoke("gateway.suspend.prepare", { requestId: "request-2" });

    expect(respond.mock.calls[0]).toMatchObject([
      false,
      undefined,
      {
        code: "UNAVAILABLE",
        details: expect.objectContaining({ reason: "gateway-suspension-conflict" }),
        retryable: true,
      },
    ]);
  });

  it.each([
    ["gateway.suspend.prepare", false],
    ["gateway.suspend.status", true],
  ] as const)("passes through %s draining results (custody=%s)", async (method, held) => {
    const params = held
      ? { suspensionId: "suspension-draining" }
      : { requestId: "request-draining", drain: true };
    const blockers = [{ kind: "terminal-persistence", count: 1, message: "pending write" }];
    const result = {
      status: "draining",
      ...(!held ? { suspensionId: "suspension-draining" } : {}),
      activeCount: blockers.length,
      blockers,
      ...(held ? { writeCustody: [{ phase: "terminal-persistence", count: 1 }] } : {}),
    };
    coordinator[held ? "status" : "prepare"].mockReturnValue(result);
    const { respond } = await invoke(method, params);
    if (!held) {
      expect(coordinator.prepare).toHaveBeenCalledWith(
        expect.objectContaining({ ...params, terminalPolicy: "preserve" }),
      );
    }
    expect(respond).toHaveBeenCalledWith(true, result);
  });

  it("keeps resume idempotent and rejects a mismatched active lease", async () => {
    coordinator.resume.mockReturnValueOnce({ ok: false, reason: "suspension-mismatch" });
    const mismatch = await invoke("gateway.suspend.resume", {
      suspensionId: "suspension-wrong",
    });
    expect(mismatch.respond).toHaveBeenCalledWith(false, undefined, {
      code: "INVALID_REQUEST",
      message: "gateway suspension id does not match",
    });

    const result = { ok: true, status: "running", resumed: false };
    coordinator.resume.mockReturnValueOnce(result);
    const resumed = await invoke("gateway.suspend.resume", { suspensionId: "suspension-1" });
    expect(resumed.respond).toHaveBeenCalledWith(true, result);
  });
});
