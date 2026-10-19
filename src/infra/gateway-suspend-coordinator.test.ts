// Covers atomic refuse-only suspension preparation, renewal, and release.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  addSession,
  deleteSession,
  getActiveBackgroundExecSessionCount,
  markBackgrounded,
  markExited,
} from "../agents/bash-process-registry.js";
import { createProcessSessionFixture } from "../agents/bash-process-registry.test-helpers.js";
import { resetProcessRegistryForTests } from "../agents/bash-process-registry.test-support.js";
import {
  getGatewaySuspendAdmissionPhase,
  isGatewayWorkAdmissionClosed,
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
  tryBeginGatewayPreparedRestartRootWorkAdmission,
  tryBeginGatewayRootWorkAdmission,
} from "../process/gateway-work-admission.js";
import {
  getGatewaySuspendStatus,
  prepareGatewaySuspend,
  resetGatewaySuspendCoordinatorForLifecycleRestart,
  resumeGatewaySuspend,
} from "./gateway-suspend-coordinator.js";
import { inspectors } from "./gateway-suspend-coordinator.test-support.js";

const SUSPEND_TTL_MS = 2 * 60_000;
const DRAIN_BUDGET_MS = 45_000;
const SUSPEND_BUSY_RETRY_AFTER_MS = 20_000;
const resumed = { ok: true, status: "running", resumed: true };
type SuspendOptions = Parameters<typeof prepareGatewaySuspend>[0];
function prepare(options: Partial<SuspendOptions> = {}) {
  return prepareGatewaySuspend({
    requestId: "request",
    pauseScheduling: vi.fn(),
    resumeScheduling: vi.fn(),
    ...options,
  });
}

function reset() {
  resetProcessRegistryForTests();
  resetGatewaySuspendCoordinatorForLifecycleRestart();
  resetGatewayWorkAdmission();
}

beforeEach(reset);
afterEach(() => {
  reset();
  vi.useRealTimers();
});

describe("gateway suspend coordinator", () => {
  it.each([false, true])(
    "lifecycle reset resumes a held scheduler before admission is cleared (drain: %s)",
    (drain) => {
      const resumeScheduling = vi.fn(() => {
        expect(isGatewayWorkAdmissionClosed()).toBe(true);
      });
      expect(
        prepare({
          requestId: "request-lifecycle-reset",
          drain,
          resumeScheduling,
          inspect: inspectors({ getQueueSize: () => Number(drain) }),
        }),
      ).toMatchObject({ status: drain ? "draining" : "ready" });

      markGatewayRestartDraining();
      expect(resumeScheduling).not.toHaveBeenCalled();
      expect(isGatewayWorkAdmissionClosed()).toBe(true);

      resetGatewaySuspendCoordinatorForLifecycleRestart();

      expect(resumeScheduling).toHaveBeenCalledOnce();
      resetGatewayWorkAdmission();
      expect(isGatewayWorkAdmissionClosed()).toBe(false);
    },
  );

  it("reopens admission in the same turn when active work refuses preparation", () => {
    const events: string[] = [];
    const result = prepare({
      requestId: "request-busy",
      pauseScheduling: () => events.push("pause"),
      resumeScheduling: () => events.push("resume"),
      inspect: inspectors({
        getQueueSize: () => {
          events.push("inspect");
          return 1;
        },
      }),
    });

    expect(result.status).toBe("busy");
    expect(events).toEqual(["pause", "inspect", "resume"]);
    expect(isGatewayWorkAdmissionClosed()).toBe(false);
  });

  it("holds a preserve-only drain until terminal persistence, delivery, and sessions settle", () => {
    let pendingReplies = 1;
    let terminalPersistence = 1;
    let terminalSessions = 1;
    const pauseScheduling = vi.fn();
    const resumeScheduling = vi.fn();
    const inspect = inspectors({
      getPendingReplies: () => pendingReplies,
      getTerminalPersistence: () => terminalPersistence,
      getTerminalSessions: () => terminalSessions,
    });

    expect(
      prepare({
        requestId: "request-preserve-drain",
        terminalPolicy: "preserve",
        drain: true,
        pauseScheduling,
        resumeScheduling,
        inspect,
        nowMs: () => 1_000,
        createSuspensionId: () => "suspension-preserve-drain",
      }),
    ).toEqual({
      status: "draining",
      suspensionId: "suspension-preserve-drain",
      expiresAtMs: 1_000 + DRAIN_BUDGET_MS,
      retryAfterMs: 5_000,
      activeCount: 3,
      writeCustody: [{ phase: "terminal-persistence", count: 1 }],
      blockers: [
        { kind: "reply", count: 1, message: "1 pending reply delivery operation(s)" },
        {
          kind: "terminal-persistence",
          count: 1,
          message: "1 pending terminal session write(s)",
        },
        { kind: "terminal-session", count: 1, message: "1 open terminal session(s)" },
      ],
    });
    expect(pauseScheduling).toHaveBeenCalledOnce();
    expect(resumeScheduling).not.toHaveBeenCalled();
    expect(getGatewaySuspendAdmissionPhase()).toBe("draining");
    expect(tryBeginGatewayRootWorkAdmission()).toBeNull();
    expect(tryBeginGatewayPreparedRestartRootWorkAdmission()).toBeNull();

    terminalPersistence = 0;
    terminalSessions = 0;
    expect(getGatewaySuspendStatus("suspension-preserve-drain")).toEqual({
      status: "draining",
      expiresAtMs: 1_000 + DRAIN_BUDGET_MS,
      retryAfterMs: 5_000,
      activeCount: 1,
      blockers: [{ kind: "reply", count: 1, message: "1 pending reply delivery operation(s)" }],
      writeCustody: [],
    });
    expect(getGatewaySuspendAdmissionPhase()).toBe("draining");

    pendingReplies = 0;
    expect(getGatewaySuspendStatus("suspension-preserve-drain")).toEqual({
      status: "ready",
      expiresAtMs: 1_000 + DRAIN_BUDGET_MS,
      writeCustody: [],
    });
    expect(getGatewaySuspendAdmissionPhase()).toBe("prepared");
    expect(tryBeginGatewayRootWorkAdmission()).toBeNull();
    expect(resumeScheduling).not.toHaveBeenCalled();
    expect(resumeGatewaySuspend("suspension-preserve-drain")).toEqual(resumed);
    expect(resumeScheduling).toHaveBeenCalledOnce();
    expect(isGatewayWorkAdmissionClosed()).toBe(false);
  });

  it.each(["preserve", "terminate"] as const)(
    "retains the absolute deadline of the same %s drain and rejects conflicting request, policy, or drain modes",
    (terminalPolicy) => {
      let queued = 2;
      let nowMs = 1_000;
      const pauseScheduling = vi.fn();
      const resumeScheduling = vi.fn();
      const params = {
        requestId: "request-drain-renewal",
        terminalPolicy,
        drain: true,
        pauseScheduling,
        resumeScheduling,
        inspect: inspectors({
          getQueueSize: () => queued,
          getTerminalSessions: () => (terminalPolicy === "terminate" ? 2 : 0),
        }),
        nowMs: () => nowMs,
        createSuspensionId: () => "suspension-drain-renewal",
      };

      expect(prepare(params)).toMatchObject({
        status: "draining",
        suspensionId: "suspension-drain-renewal",
        expiresAtMs: 1_000 + DRAIN_BUDGET_MS,
        activeCount: 2,
      });

      nowMs = 2_000;
      queued = 1;
      expect(prepare(params)).toMatchObject({
        status: "draining",
        suspensionId: "suspension-drain-renewal",
        expiresAtMs: 1_000 + DRAIN_BUDGET_MS,
        activeCount: 1,
      });
      const otherTerminalPolicy = terminalPolicy === "preserve" ? "terminate" : "preserve";
      for (const conflict of [
        { requestId: "request-other" },
        { drain: false },
        { terminalPolicy: otherTerminalPolicy },
      ] satisfies Partial<typeof params>[]) {
        expect(prepare({ ...params, ...conflict })).toEqual({
          status: "conflict",
          expiresAtMs: 1_000 + DRAIN_BUDGET_MS,
        });
      }
      expect(pauseScheduling).toHaveBeenCalledOnce();

      nowMs = 3_000;
      queued = 0;
      expect(prepare(params)).toEqual({
        status: "ready",
        suspensionId: "suspension-drain-renewal",
        expiresAtMs: 1_000 + DRAIN_BUDGET_MS,
        activeCount: 0,
        blockers: [],
        writeCustody: [],
      });
      expect(getGatewaySuspendAdmissionPhase()).toBe("prepared");
      expect(pauseScheduling).toHaveBeenCalledOnce();
      expect(resumeScheduling).not.toHaveBeenCalled();
    },
  );

  it("resumes a still-draining lease without dropping its admission fence first", () => {
    const resumeScheduling = vi.fn(() => {
      expect(getGatewaySuspendAdmissionPhase()).toBe("draining");
    });
    expect(
      prepare({
        requestId: "request-draining-resume",
        drain: true,
        resumeScheduling,
        inspect: inspectors({ getTerminalSessions: () => 1 }),
        createSuspensionId: () => "suspension-draining-resume",
      }),
    ).toMatchObject({ status: "draining" });

    expect(resumeGatewaySuspend("suspension-draining-resume")).toEqual(resumed);
    expect(resumeScheduling).toHaveBeenCalledOnce();
    expect(isGatewayWorkAdmissionClosed()).toBe(false);
  });

  it("stays busy after a background session is hidden until its process exits", () => {
    const session = createProcessSessionFixture({
      id: "private-background-session",
      command: "private command",
    });
    addSession(session);
    markBackgrounded(session);
    deleteSession(session.id);

    const inspect = inspectors({
      getBackgroundExecSessions: getActiveBackgroundExecSessionCount,
    });
    expect(
      prepare({
        requestId: "request-background-exec",
        inspect,
      }),
    ).toEqual({
      status: "busy",
      reason: "active-work",
      retryAfterMs: SUSPEND_BUSY_RETRY_AFTER_MS,
      activeCount: 1,
      writeCustody: [],
      blockers: [
        {
          kind: "background-exec",
          count: 1,
          message: "1 active background exec session(s)",
        },
      ],
    });

    markExited(session, 0, null, "completed");
    expect(
      prepare({
        requestId: "request-background-exec",
        inspect,
      }),
    ).toMatchObject({ status: "ready", activeCount: 0, blockers: [] });
  });

  it("reopens admission when inspection fails before admission commits", () => {
    const resumeScheduling = vi.fn();
    expect(() =>
      prepare({
        requestId: "request-inspection-failure",
        resumeScheduling,
        inspect: inspectors({
          getQueueSize: () => {
            throw new Error("inspection failed");
          },
        }),
      }),
    ).toThrow("inspection failed");
    expect(resumeScheduling).toHaveBeenCalledOnce();
    expect(isGatewayWorkAdmissionClosed()).toBe(false);
  });

  it("renews one ready lease and resumes only with the matching id", () => {
    const resumeScheduling = vi.fn();
    expect(
      prepare({
        requestId: "request-ready",
        resumeScheduling,
        inspect: inspectors(),
        nowMs: () => 1_000,
        createSuspensionId: () => "suspension-1",
      }),
    ).toMatchObject({
      status: "ready",
      suspensionId: "suspension-1",
      expiresAtMs: 1_000 + SUSPEND_TTL_MS,
    });
    expect(isGatewayWorkAdmissionClosed()).toBe(true);

    expect(
      prepare({
        requestId: "request-ready",
        resumeScheduling,
        inspect: inspectors({ getQueueSize: () => 99 }),
        nowMs: () => 2_000,
      }),
    ).toMatchObject({
      status: "ready",
      suspensionId: "suspension-1",
      expiresAtMs: 2_000 + SUSPEND_TTL_MS,
    });
    expect(
      prepare({
        requestId: "request-other",
        resumeScheduling,
      }).status,
    ).toBe("conflict");

    expect(resumeGatewaySuspend("wrong-id")).toEqual({
      ok: false,
      reason: "suspension-mismatch",
    });
    expect(resumeGatewaySuspend("suspension-1")).toEqual(resumed);
    expect(resumeScheduling).toHaveBeenCalledOnce();
    expect(isGatewayWorkAdmissionClosed()).toBe(false);
  });

  it.each(
    [false, true].flatMap((drain) =>
      [0, (drain ? DRAIN_BUDGET_MS : SUSPEND_TTL_MS) / 2].flatMap((preparationMs) =>
        [false, true].map((rollbackClock) => ({ drain, preparationMs, rollbackClock })),
      ),
    ),
  )(
    "auto-resumes at the original expiry (drain: $drain, preparation: $preparationMs ms, clock rollback: $rollbackClock)",
    ({ drain, preparationMs, rollbackClock }) => {
      vi.useFakeTimers();
      const resumeScheduling = vi.fn();
      const ttlMs = drain ? DRAIN_BUDGET_MS : SUSPEND_TTL_MS;
      const expiresAtMs = Date.now() + ttlMs;
      expect(
        prepare({
          requestId: "request-expiry",
          drain,
          resumeScheduling,
          inspect: inspectors({
            getQueueSize: () => {
              vi.advanceTimersByTime(preparationMs);
              if (rollbackClock) {
                vi.setSystemTime(Date.now() - preparationMs);
              }
              return Number(drain);
            },
          }),
          createSuspensionId: () => "suspension-expiry",
        }),
      ).toMatchObject({ status: drain ? "draining" : "ready", expiresAtMs });

      vi.advanceTimersByTime(ttlMs - preparationMs - 1);
      expect(resumeScheduling).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(resumeScheduling).toHaveBeenCalledOnce();
      expect(isGatewayWorkAdmissionClosed()).toBe(false);
      expect(getGatewaySuspendStatus("suspension-expiry")).toEqual({ status: "running" });
    },
  );

  it.each(
    ["status", "renewal"].flatMap((operation) =>
      [0, 1].map((remainingWork) => ({ operation, remainingWork })),
    ),
  )(
    "expires after a slow draining inspection (operation: $operation, remaining work: $remainingWork)",
    ({ operation, remainingWork }) => {
      vi.useFakeTimers();
      const resumeScheduling = vi.fn();
      const params = {
        requestId: "slow-drain-inspection",
        drain: true,
        resumeScheduling,
        inspect: inspectors({
          getQueueSize: vi
            .fn()
            .mockReturnValueOnce(1)
            .mockImplementation(() => {
              // Synchronous inspection prevents an expired timer from being delivered.
              vi.setSystemTime(Date.now() + SUSPEND_TTL_MS);
              return remainingWork;
            }),
        }),
        createSuspensionId: () => "slow-drain-inspection",
      };
      expect(prepare(params)).toMatchObject({ status: "draining" });
      if (operation === "status") {
        expect(getGatewaySuspendStatus("slow-drain-inspection")).toEqual({ status: "running" });
      } else {
        expect(() => prepare(params)).toThrow("gateway suspension changed during preparation");
      }
      expect(resumeScheduling).toHaveBeenCalledOnce();
      expect(isGatewayWorkAdmissionClosed()).toBe(false);
    },
  );

  it.each(
    [false, true].flatMap((drain) =>
      ["inspection", "lease setup"].map((phase) => ({ drain, phase })),
    ),
  )(
    "resumes instead of returning an already-expired lease (drain: $drain, phase: $phase)",
    ({ drain, phase }) => {
      vi.useFakeTimers();
      const resumeScheduling = vi.fn();
      expect(() =>
        prepare({
          requestId: "expired-inspection",
          drain,
          resumeScheduling,
          inspect: inspectors({
            getQueueSize: () => {
              if (phase === "inspection") {
                vi.advanceTimersByTime(SUSPEND_TTL_MS);
              }
              return Number(drain);
            },
          }),
          createSuspensionId: () => {
            if (phase === "lease setup") {
              vi.advanceTimersByTime(SUSPEND_TTL_MS);
            }
            return "expired-inspection";
          },
        }),
      ).toThrow("gateway suspension expired during preparation");
      expect(resumeScheduling).toHaveBeenCalledOnce();
      expect(isGatewayWorkAdmissionClosed()).toBe(false);
      expect(getGatewaySuspendStatus("expired-inspection")).toEqual({ status: "running" });
    },
  );
});
