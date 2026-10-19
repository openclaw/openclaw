import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  const pauseScheduling = vi.fn();
  const resumeScheduling = vi.fn();
  const info = vi.fn();
  const handler = expectDefined(suspendHandlers[method], "suspendHandlers[method] test invariant");
  await handler({
    params,
    respond,
    context: {
      cron: { pauseScheduling, resumeScheduling },
      logGateway: { warn: vi.fn(), info },
    },
  } as unknown as Parameters<typeof handler>[0]);
  return { respond, pauseScheduling, resumeScheduling, info };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

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

  it("wires prepare to scheduler pause/resume and returns busy or ready", async () => {
    const result = { status: "busy", reason: "active-work" };
    coordinator.prepare.mockReturnValueOnce(result);
    const { respond, pauseScheduling, resumeScheduling } = await invoke("gateway.suspend.prepare", {
      requestId: "request-1",
    });

    expect(coordinator.prepare.mock.calls[0]?.[0]).toMatchObject({
      requestId: "request-1",
      terminalPolicy: "preserve",
      pauseScheduling: expect.any(Function),
      resumeScheduling: expect.any(Function),
    });
    const options = coordinator.prepare.mock.calls[0]?.[0];
    options.pauseScheduling();
    options.resumeScheduling();
    expect(pauseScheduling).toHaveBeenCalledOnce();
    expect(resumeScheduling).toHaveBeenCalledOnce();
    expect(respond).toHaveBeenCalledWith(true, result);
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
    if (held) {
      vi.useFakeTimers();
    }
    const params = held
      ? { suspensionId: "suspension-draining" }
      : { requestId: "request-draining", drain: true };
    const blockers = held
      ? [
          { kind: "root-request", count: 1, message: "http request" },
          { kind: "terminal-persistence", count: 1, message: "pending write" },
        ]
      : [{ kind: "terminal-session", count: 1, message: "one preserved terminal" }];
    const result = {
      status: "draining",
      ...(method === "gateway.suspend.prepare" ? { suspensionId: "suspension-draining" } : {}),
      expiresAtMs: 123_000,
      retryAfterMs: 20_000,
      activeCount: blockers.length,
      blockers,
      ...(held ? { writeCustody: [{ phase: "terminal-persistence", count: 1 }] } : {}),
    };
    coordinator[held ? "status" : "prepare"].mockReturnValue(result);
    const { respond, info } = await invoke(method, params);
    if (method === "gateway.suspend.prepare") {
      expect(coordinator.prepare).toHaveBeenCalledWith(
        expect.objectContaining({ ...params, terminalPolicy: "preserve" }),
      );
    } else {
      expect(coordinator.status).toHaveBeenCalledWith("suspension-draining", false);
    }
    expect(respond).toHaveBeenCalledWith(true, result);
    expect(info).toHaveBeenCalledWith(
      held
        ? 'DRAINING activeCount=2 blockers=root-request:1,terminal-persistence:1 holders=["http request","pending write"] custody=held'
        : 'DRAINING activeCount=1 blockers=terminal-session:1 holders=["one preserved terminal"] custody=clear',
    );
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
