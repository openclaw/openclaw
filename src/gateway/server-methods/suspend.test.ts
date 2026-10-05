// Covers suspension RPC validation and coordinator response mapping.

import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatAbortControllerEntry } from "../chat-abort.js";
import { suspendHandlers } from "./suspend.js";

const coordinator = vi.hoisted(() => ({
  prepare: vi.fn(),
  status: vi.fn(),
  resume: vi.fn(),
  capture: vi.fn(),
}));

// mock-isolation: Exercise the suspend RPC capture callback without loading real agent SQLite history-worker lanes and recovery registries.
vi.mock("../../agents/main-session-recovery/main-session-restart-recovery-marking.js", () => ({
  markRestartAbortedMainSessions: coordinator.capture,
}));

vi.mock("../../infra/gateway-suspend-coordinator.js", () => ({
  prepareGatewaySuspend: coordinator.prepare,
  getGatewaySuspendStatus: coordinator.status,
  resumeGatewaySuspend: coordinator.resume,
}));

vi.mock("../server-active-work.js", () => ({
  createGatewayServerActiveWorkInspectors: vi.fn(() => ({ getChatRuns: vi.fn(() => 0) })),
}));

function invoke(
  method: keyof typeof suspendHandlers,
  params: unknown,
  runs = new Map<string, ChatAbortControllerEntry>(),
) {
  const respond = vi.fn();
  const pauseScheduling = vi.fn();
  const resumeScheduling = vi.fn();
  const warn = vi.fn();
  const info = vi.fn();
  const handler = expectDefined(suspendHandlers[method], "suspendHandlers[method] test invariant");
  const context = {
    cron: { pauseScheduling, resumeScheduling },
    logGateway: { warn },
    chatAbortControllers: runs,
    chatQueuedTurns: new Map(),
    getRuntimeConfig: () => ({}),
    resolveGatewayContext: (): unknown => context,
  };
  return Promise.resolve(
    handler({
      params,
      respond,
      context,
    } as unknown as Parameters<typeof handler>[0]),
  ).then(() => ({ respond, pauseScheduling, resumeScheduling, info }));
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("gateway suspend handlers", () => {
  it("captures exact accepted preparation runs through the registered before-drain handler", async () => {
    coordinator.prepare.mockReturnValueOnce({
      status: "draining",
      suspensionId: "accepted-suspension",
      expiresAtMs: Date.now() + 60_000,
    });
    const entry: ChatAbortControllerEntry = {
      controller: new AbortController(),
      sessionId: "accepted-session",
      sessionKey: "agent:main:accepted",
      lifecycleGeneration: "accepted-generation",
      startedAtMs: 1,
      expiresAtMs: Date.now() + 60_000,
      accepted: true,
    };
    await invoke(
      "gateway.suspend.prepare",
      { requestId: "accepted-capture", drain: true },
      new Map([["accepted-run", entry]]),
    );
    const options = coordinator.prepare.mock.calls[0]![0];
    await options.beforeDrain(() => {});
    const captured = coordinator.capture.mock.calls[0]![0];
    expect(captured.captureGoals).toBe(true);
    expect(captured.activeRuns).toEqual([
      expect.objectContaining({
        runId: "accepted-run",
        sessionId: "accepted-session",
        accepted: true,
      }),
    ]);
    expect(captured.isActiveRun(captured.activeRuns[0])).toBe(true);
    entry.controller.abort();
    expect(captured.isActiveRun(captured.activeRuns[0])).toBe(false);
  });
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
    coordinator.prepare.mockReturnValueOnce({
      status: "busy",
      reason: "active-work",
      activeCount: 1,
      blockers: [{ kind: "queue", count: 1, message: "busy" }],
    });
    const { respond, pauseScheduling, resumeScheduling } = await invoke("gateway.suspend.prepare", {
      requestId: "request-1",
    });

    expect(coordinator.prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: "request-1",
        terminalPolicy: "preserve",
        pauseScheduling: expect.any(Function),
        resumeScheduling: expect.any(Function),
      }),
    );
    const options = coordinator.prepare.mock.calls[0]?.[0];
    options.pauseScheduling();
    options.resumeScheduling();
    expect(pauseScheduling).toHaveBeenCalledOnce();
    expect(resumeScheduling).toHaveBeenCalledOnce();
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ status: "busy", reason: "active-work" }),
    );
  });

  it("maps a competing prepared lease to retryable unavailable", async () => {
    coordinator.prepare.mockReturnValueOnce({ status: "conflict", expiresAtMs: Date.now() + 5000 });
    const { respond } = await invoke("gateway.suspend.prepare", { requestId: "request-2" });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "UNAVAILABLE",
        details: expect.objectContaining({ reason: "gateway-suspension-conflict" }),
        retryable: true,
      }),
    );
  });

  it("passes an explicit preserve-only drain through without changing its wire result", async () => {
    const result = {
      status: "draining",
      suspensionId: "suspension-draining",
      expiresAtMs: 123_000,
      retryAfterMs: 20_000,
      activeCount: 1,
      blockers: [{ kind: "terminal-session", count: 1, message: "one preserved terminal" }],
    };
    coordinator.prepare.mockReturnValueOnce(result);

    const { respond, info } = await invoke("gateway.suspend.prepare", {
      requestId: "request-draining",
      drain: true,
    });

    expect(coordinator.prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: "request-draining",
        terminalPolicy: "preserve",
        drain: true,
      }),
    );
    expect(respond).toHaveBeenCalledWith(true, result);
    expect(info).toHaveBeenCalledWith(
      'DRAINING activeCount=1 blockers=terminal-session:1 holders=["one preserved terminal"] custody=clear',
    );
  });

  it("returns a draining status without exposing its owner's suspension id", async () => {
    const result = {
      status: "draining",
      expiresAtMs: 123_000,
      retryAfterMs: 20_000,
      activeCount: 2,
      blockers: [
        { kind: "root-request", count: 1, message: "1 active gateway request(s): http:openai" },
        {
          kind: "terminal-persistence",
          count: 1,
          message: "1 pending terminal session write(s): run=run-1 session=agent:main:chat-1",
        },
      ],
      writeCustody: [{ phase: "terminal-persistence", count: 1 }],
    };
    coordinator.status.mockReturnValueOnce(result);

    const { respond, info } = await invoke("gateway.suspend.status", {
      suspensionId: "suspension-draining",
    });

    expect(coordinator.status).toHaveBeenCalledWith("suspension-draining", false);
    expect(respond).toHaveBeenCalledWith(true, result);
    expect(info).toHaveBeenCalledWith(
      'DRAINING activeCount=2 blockers=root-request:1,terminal-persistence:1 holders=["1 active gateway request(s): http:openai","1 pending terminal session write(s): run=run-1 session=agent:main:chat-1"] custody=held',
    );
  });

  it("maps prepare and status recovery to the same retryable unavailable error", async () => {
    const recovering = {
      status: "recovering",
      reason: "scheduler-resume-failed",
      retryAfterMs: 1_000,
    };
    coordinator.prepare.mockReturnValueOnce(recovering);
    coordinator.status.mockReturnValueOnce(recovering);

    const prepared = await invoke("gateway.suspend.prepare", { requestId: "request-recovery" });
    const status = await invoke("gateway.suspend.status", { suspensionId: "stale-id" });

    for (const respond of [prepared.respond, status.respond]) {
      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({
          code: "UNAVAILABLE",
          message: "gateway scheduler recovery is pending",
          retryable: true,
          retryAfterMs: 1_000,
          details: { reason: "scheduler-resume-failed" },
        }),
      );
    }
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

    coordinator.resume.mockReturnValueOnce({
      ok: true,
      status: "running",
      resumed: false,
    });
    const resumed = await invoke("gateway.suspend.resume", { suspensionId: "suspension-1" });
    expect(resumed.respond).toHaveBeenCalledWith(true, {
      ok: true,
      status: "running",
      resumed: false,
    });
  });

  it("returns retryable unavailable when scheduler resume needs retry", async () => {
    coordinator.resume.mockReturnValueOnce({
      ok: false,
      reason: "scheduler-resume-failed",
      retryAfterMs: 1_000,
    });

    const { respond } = await invoke("gateway.suspend.resume", {
      suspensionId: "suspension-1",
    });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "UNAVAILABLE",
        message: "gateway scheduler recovery is pending",
        retryable: true,
        retryAfterMs: 1_000,
        details: { reason: "scheduler-resume-failed" },
      }),
    );
  });
});
