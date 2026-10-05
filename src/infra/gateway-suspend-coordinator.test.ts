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
  onGatewaySuspendAdmissionChange,
  resetGatewayWorkAdmission,
  tryBeginGatewayPreparedRestartRootWorkAdmission,
  tryBeginGatewayRootWorkAdmission,
} from "../process/gateway-work-admission.js";
import { createGatewayActiveWorkSnapshot } from "./gateway-active-work.js";
import {
  getGatewaySuspendStatus,
  prepareGatewaySuspend,
  resetGatewaySuspendCoordinatorForLifecycleRestart,
  resumeGatewaySuspend,
} from "./gateway-suspend-coordinator.js";
import { inspectors } from "./gateway-suspend-coordinator.test-support.js";

const SUSPEND_TTL_MS = 2 * 60_000;
const SUSPEND_RETRY_AFTER_MS = 20_000;

beforeEach(() => {
  resetProcessRegistryForTests();
  resetGatewaySuspendCoordinatorForLifecycleRestart();
  resetGatewayWorkAdmission();
});

afterEach(() => {
  resetProcessRegistryForTests();
  resetGatewaySuspendCoordinatorForLifecycleRestart();
  resetGatewayWorkAdmission();
});

describe("gateway suspend coordinator", () => {
  it.each([
    "complete",
    "failure",
    "revoked",
    "restart",
    "reset",
    "expiry",
    "expiry-recovery",
  ] as const)("waits for durable capture before drain and handles %s", async (outcome) => {
    let finish: (() => void) | undefined;
    const captured = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const resumeScheduling = vi.fn();
    if (outcome === "expiry" || outcome === "expiry-recovery") {
      vi.useFakeTimers();
    }
    if (outcome === "expiry-recovery") {
      resumeScheduling.mockImplementationOnce(() => {
        throw new Error("synthetic scheduler resume failure");
      });
    }
    let current = true;
    let settled = false;
    const preparing = prepareGatewaySuspend({
      requestId: "capture-before-drain",
      drain: true,
      pauseScheduling: vi.fn(),
      resumeScheduling,
      assertCurrent: () => {
        if (!current) {
          throw new Error("capture caller revoked");
        }
      },
      inspect: inspectors({ getChatRuns: () => 1 }),
      beforeDrain: async (assertCurrent) => {
        await captured;
        assertCurrent();
        if (outcome === "failure") {
          throw new Error("durable capture failed");
        }
      },
    });
    void preparing.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    try {
      expect(settled).toBe(false);
      expect(getGatewaySuspendAdmissionPhase()).toBe("preparing");
      if (outcome === "revoked") {
        current = false;
      } else if (outcome === "restart") {
        markGatewayRestartDraining();
        expect(resumeScheduling).not.toHaveBeenCalled();
      } else if (outcome === "reset") {
        resetGatewaySuspendCoordinatorForLifecycleRestart();
        resetGatewayWorkAdmission();
        expect(resumeScheduling).toHaveBeenCalledOnce();
      } else if (outcome === "expiry" || outcome === "expiry-recovery") {
        vi.advanceTimersByTime(SUSPEND_TTL_MS);
        expect(settled).toBe(false);
        expect(resumeScheduling).toHaveBeenCalledOnce();
        if (outcome === "expiry-recovery") {
          expect(isGatewayWorkAdmissionClosed()).toBe(true);
          expect(getGatewaySuspendStatus("capture-before-drain")).toMatchObject({
            status: "recovering",
          });
          vi.advanceTimersByTime(1_000);
          expect(resumeScheduling).toHaveBeenCalledTimes(2);
        }
        expect(getGatewaySuspendAdmissionPhase()).toBe("accepting");
      }
      finish!();
      if (outcome === "complete") {
        await expect(preparing).resolves.toMatchObject({ status: "draining" });
        expect(resumeScheduling).not.toHaveBeenCalled();
      } else {
        await expect(preparing).rejects.toThrow(
          outcome === "failure"
            ? "durable capture failed"
            : outcome === "revoked"
              ? "capture caller revoked"
              : "gateway suspension changed before restart intent capture",
        );
        if (outcome === "restart") {
          expect(resumeScheduling).not.toHaveBeenCalled();
          resetGatewaySuspendCoordinatorForLifecycleRestart();
          resetGatewayWorkAdmission();
        }
        expect(getGatewaySuspendAdmissionPhase()).toBe("accepting");
        expect(resumeScheduling).toHaveBeenCalledTimes(outcome === "expiry-recovery" ? 2 : 1);
      }
    } finally {
      finish!();
      await preparing.catch(() => {});
      vi.useRealTimers();
    }
  });

  it.each([false, true])(
    "lifecycle reset resumes a held scheduler before admission is cleared (drain: %s)",
    async (drain) => {
      const resumeScheduling = vi.fn(() => {
        expect(isGatewayWorkAdmissionClosed()).toBe(true);
      });
      expect(
        await prepareGatewaySuspend({
          requestId: "request-lifecycle-reset",
          drain,
          pauseScheduling: vi.fn(),
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

  it("test reset resumes a held scheduler before admission is cleared", async () => {
    const resumeScheduling = vi.fn(() => {
      expect(isGatewayWorkAdmissionClosed()).toBe(true);
    });
    expect(
      await prepareGatewaySuspend({
        requestId: "request-lifecycle-reset",
        pauseScheduling: vi.fn(),
        resumeScheduling,
        inspect: inspectors(),
      }),
    ).toMatchObject({ status: "ready" });

    resetGatewaySuspendCoordinatorForLifecycleRestart();
    resetGatewayWorkAdmission();

    expect(resumeScheduling).toHaveBeenCalledOnce();
    expect(isGatewayWorkAdmissionClosed()).toBe(false);
  });

  it("reopens admission in the same turn when active work refuses preparation", async () => {
    const events: string[] = [];
    const result = await prepareGatewaySuspend({
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

  it("holds a preserve-only drain until terminal persistence, delivery, and sessions settle", async () => {
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
      await prepareGatewaySuspend({
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
      expiresAtMs: 1_000 + SUSPEND_TTL_MS,
      retryAfterMs: SUSPEND_RETRY_AFTER_MS,
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
      expiresAtMs: 1_000 + SUSPEND_TTL_MS,
      retryAfterMs: SUSPEND_RETRY_AFTER_MS,
      activeCount: 1,
      blockers: [{ kind: "reply", count: 1, message: "1 pending reply delivery operation(s)" }],
      writeCustody: [],
    });
    expect(getGatewaySuspendAdmissionPhase()).toBe("draining");

    pendingReplies = 0;
    expect(getGatewaySuspendStatus("suspension-preserve-drain")).toEqual({
      status: "ready",
      expiresAtMs: 1_000 + SUSPEND_TTL_MS,
      writeCustody: [],
    });
    expect(getGatewaySuspendAdmissionPhase()).toBe("prepared");
    expect(tryBeginGatewayRootWorkAdmission()).toBeNull();
    expect(resumeScheduling).not.toHaveBeenCalled();
    expect(resumeGatewaySuspend("suspension-preserve-drain")).toEqual({
      ok: true,
      status: "running",
      resumed: true,
    });
    expect(resumeScheduling).toHaveBeenCalledOnce();
    expect(isGatewayWorkAdmissionClosed()).toBe(false);
  });

  it.each(["preserve", "terminate"] as const)(
    "renews the same %s drain and rejects conflicting request, policy, or drain modes",
    async (terminalPolicy) => {
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

      expect(await prepareGatewaySuspend(params)).toMatchObject({
        status: "draining",
        suspensionId: "suspension-drain-renewal",
        expiresAtMs: 1_000 + SUSPEND_TTL_MS,
        activeCount: 2,
      });

      nowMs = 2_000;
      queued = 1;
      expect(await prepareGatewaySuspend(params)).toMatchObject({
        status: "draining",
        suspensionId: "suspension-drain-renewal",
        expiresAtMs: 2_000 + SUSPEND_TTL_MS,
        activeCount: 1,
      });
      const otherTerminalPolicy = terminalPolicy === "preserve" ? "terminate" : "preserve";
      for (const conflict of [
        { requestId: "request-other" },
        { drain: false },
        { terminalPolicy: otherTerminalPolicy },
      ] satisfies Partial<typeof params>[]) {
        expect(await prepareGatewaySuspend({ ...params, ...conflict })).toEqual({
          status: "conflict",
          expiresAtMs: 2_000 + SUSPEND_TTL_MS,
        });
      }
      expect(pauseScheduling).toHaveBeenCalledOnce();

      nowMs = 3_000;
      queued = 0;
      expect(await prepareGatewaySuspend(params)).toEqual({
        status: "ready",
        suspensionId: "suspension-drain-renewal",
        expiresAtMs: 3_000 + SUSPEND_TTL_MS,
        activeCount: 0,
        blockers: [],
        writeCustody: [],
      });
      expect(getGatewaySuspendAdmissionPhase()).toBe("prepared");
      expect(pauseScheduling).toHaveBeenCalledOnce();
      expect(resumeScheduling).not.toHaveBeenCalled();
    },
  );

  it("resumes a still-draining lease without dropping its admission fence first", async () => {
    const resumeScheduling = vi.fn(() => {
      expect(getGatewaySuspendAdmissionPhase()).toBe("draining");
    });
    expect(
      await prepareGatewaySuspend({
        requestId: "request-draining-resume",
        drain: true,
        pauseScheduling: vi.fn(),
        resumeScheduling,
        inspect: inspectors({ getTerminalSessions: () => 1 }),
        createSuspensionId: () => "suspension-draining-resume",
      }),
    ).toMatchObject({ status: "draining" });

    expect(resumeGatewaySuspend("suspension-draining-resume")).toEqual({
      ok: true,
      status: "running",
      resumed: true,
    });
    expect(resumeScheduling).toHaveBeenCalledOnce();
    expect(isGatewayWorkAdmissionClosed()).toBe(false);
  });

  it.each([undefined, "preserve"] as const)(
    "keeps terminal sessions blocking with terminal policy %s",
    async (terminalPolicy) => {
      expect(
        await prepareGatewaySuspend({
          requestId: `request-terminal-${terminalPolicy ?? "default"}`,
          terminalPolicy,
          pauseScheduling: vi.fn(),
          resumeScheduling: vi.fn(),
          inspect: inspectors({ getTerminalSessions: () => 2 }),
        }),
      ).toEqual({
        status: "busy",
        reason: "active-work",
        retryAfterMs: SUSPEND_RETRY_AFTER_MS,
        activeCount: 2,
        writeCustody: [],
        blockers: [
          {
            kind: "terminal-session",
            count: 2,
            message: "2 open terminal session(s)",
          },
        ],
      });
    },
  );

  it("retains terminal diagnostics when terminal sessions are not blockers", () => {
    const preserving = createGatewayActiveWorkSnapshot(
      inspectors({ getTerminalSessions: () => 2 }),
    );
    const ignoring = createGatewayActiveWorkSnapshot(inspectors({ getTerminalSessions: () => 2 }), {
      ignoreTerminalSessions: true,
    });

    expect(preserving).toMatchObject({
      idle: false,
      counts: { terminalSessions: 2, totalActive: 2 },
      blockers: [expect.objectContaining({ kind: "terminal-session", count: 2 })],
    });
    expect(ignoring).toMatchObject({
      idle: true,
      counts: { terminalSessions: 2, totalActive: 0 },
      blockers: [],
    });
  });

  it.each([false, true])("prepares with terminal sessions excluded (drain: %s)", async (drain) => {
    const params = {
      requestId: "request-terminal-terminate",
      terminalPolicy: "terminate" as const,
      drain,
      pauseScheduling: vi.fn(),
      resumeScheduling: vi.fn(),
      inspect: inspectors({ getTerminalSessions: () => 2 }),
    };
    const expected = { status: "ready", activeCount: 0, blockers: [] };
    expect(await prepareGatewaySuspend(params)).toMatchObject(expected);
    expect(await prepareGatewaySuspend(params)).toMatchObject(expected);
    expect(await prepareGatewaySuspend({ ...params, terminalPolicy: "preserve" })).toMatchObject({
      status: "conflict",
    });
  });

  it("keeps persistence and other active work blocking under terminal termination policy", async () => {
    expect(
      await prepareGatewaySuspend({
        requestId: "request-terminal-terminate-busy",
        terminalPolicy: "terminate",
        pauseScheduling: vi.fn(),
        resumeScheduling: vi.fn(),
        inspect: inspectors({
          getQueueSize: () => 1,
          getTerminalPersistence: () => 1,
          getTerminalSessions: () => 2,
        }),
      }),
    ).toEqual({
      status: "busy",
      reason: "active-work",
      retryAfterMs: SUSPEND_RETRY_AFTER_MS,
      activeCount: 2,
      writeCustody: [{ phase: "terminal-persistence", count: 1 }],
      blockers: [
        { kind: "queue", count: 1, message: "1 queued or active operation(s)" },
        {
          kind: "terminal-persistence",
          count: 1,
          message: "1 pending terminal session write(s)",
        },
      ],
    });
  });

  it("stays busy after a background session is hidden until its process exits", async () => {
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
      await prepareGatewaySuspend({
        requestId: "request-background-exec",
        pauseScheduling: vi.fn(),
        resumeScheduling: vi.fn(),
        inspect,
      }),
    ).toEqual({
      status: "busy",
      reason: "active-work",
      retryAfterMs: SUSPEND_RETRY_AFTER_MS,
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
      await prepareGatewaySuspend({
        requestId: "request-background-exec",
        pauseScheduling: vi.fn(),
        resumeScheduling: vi.fn(),
        inspect,
      }),
    ).toMatchObject({ status: "ready", activeCount: 0, blockers: [] });
  });

  it("keeps admission closed until a failed busy rollback resumes scheduling", async () => {
    vi.useFakeTimers();
    try {
      const resumeScheduling = vi
        .fn()
        .mockImplementationOnce(() => {
          throw new Error("timer unavailable");
        })
        .mockImplementationOnce(() => {});
      const first = await prepareGatewaySuspend({
        requestId: "request-busy-resume-retry",
        pauseScheduling: vi.fn(),
        resumeScheduling,
        inspect: inspectors({ getQueueSize: () => 1 }),
      });

      expect(first).toEqual({
        status: "recovering",
        reason: "scheduler-resume-failed",
        retryAfterMs: 1_000,
      });
      expect(isGatewayWorkAdmissionClosed()).toBe(true);
      expect(getGatewaySuspendStatus("stale-id")).toEqual(first);
      expect(resumeGatewaySuspend("stale-id")).toEqual({
        ok: false,
        reason: "scheduler-resume-failed",
        retryAfterMs: 1_000,
      });
      expect(
        await prepareGatewaySuspend({
          requestId: "request-before-scheduler-resume",
          pauseScheduling: vi.fn(),
          resumeScheduling,
          inspect: inspectors(),
        }),
      ).toEqual(first);

      vi.advanceTimersByTime(1_000);
      expect(resumeScheduling).toHaveBeenCalledTimes(2);
      expect(isGatewayWorkAdmissionClosed()).toBe(false);
      expect(getGatewaySuspendStatus("stale-id")).toEqual({ status: "running" });

      expect(
        await prepareGatewaySuspend({
          requestId: "request-after-scheduler-resume",
          pauseScheduling: vi.fn(),
          resumeScheduling,
          inspect: inspectors(),
          createSuspensionId: () => "suspension-after-scheduler-resume",
        }),
      ).toMatchObject({
        status: "ready",
        suspensionId: "suspension-after-scheduler-resume",
      });
      vi.advanceTimersByTime(1_000);
      expect(resumeScheduling).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels scheduler recovery when restart supersedes suspension", async () => {
    vi.useFakeTimers();
    try {
      const resumeScheduling = vi.fn(() => {
        throw new Error("timer unavailable");
      });
      expect(
        await prepareGatewaySuspend({
          requestId: "request-recovery-restart",
          pauseScheduling: vi.fn(),
          resumeScheduling,
          inspect: inspectors({ getQueueSize: () => 1 }),
        }),
      ).toMatchObject({ status: "recovering" });

      markGatewayRestartDraining();
      vi.advanceTimersByTime(1_000);

      expect(resumeScheduling).toHaveBeenCalledOnce();
      expect(isGatewayWorkAdmissionClosed()).toBe(true);
      expect(getGatewaySuspendStatus("stale-id")).toEqual({ status: "running" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("owns recovery when inspection fails before admission commits", async () => {
    vi.useFakeTimers();
    try {
      const resumeScheduling = vi
        .fn()
        .mockImplementationOnce(() => {
          throw new Error("timer unavailable");
        })
        .mockImplementationOnce(() => {});
      const result = await prepareGatewaySuspend({
        requestId: "request-inspection-failure",
        pauseScheduling: vi.fn(),
        resumeScheduling,
        inspect: inspectors({
          getQueueSize: () => {
            throw new Error("inspection failed");
          },
        }),
      });

      expect(result).toMatchObject({ status: "recovering" });
      expect(isGatewayWorkAdmissionClosed()).toBe(true);
      vi.advanceTimersByTime(1_000);
      expect(resumeScheduling).toHaveBeenCalledTimes(2);
      expect(isGatewayWorkAdmissionClosed()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("renews one ready lease and resumes only with the matching id", async () => {
    const resumeScheduling = vi.fn();
    expect(
      await prepareGatewaySuspend({
        requestId: "request-ready",
        pauseScheduling: vi.fn(),
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
      await prepareGatewaySuspend({
        requestId: "request-ready",
        pauseScheduling: vi.fn(),
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
      (
        await prepareGatewaySuspend({
          requestId: "request-other",
          pauseScheduling: vi.fn(),
          resumeScheduling,
        })
      ).status,
    ).toBe("conflict");

    expect(resumeGatewaySuspend("wrong-id")).toEqual({
      ok: false,
      reason: "suspension-mismatch",
    });
    expect(resumeGatewaySuspend("suspension-1")).toEqual({
      ok: true,
      status: "running",
      resumed: true,
    });
    expect(resumeScheduling).toHaveBeenCalledOnce();
    expect(isGatewayWorkAdmissionClosed()).toBe(false);
  });

  it.each([false, true])(
    "joins restart to a suspension without reopening its scheduler (drain: %s)",
    async (drain) => {
      const resumeScheduling = vi.fn();
      const result = await prepareGatewaySuspend({
        requestId: "request-restart",
        drain,
        pauseScheduling: vi.fn(),
        resumeScheduling,
        inspect: inspectors({ getQueueSize: () => Number(drain) }),
        createSuspensionId: () => "suspension-restart",
      });
      expect(result.status).toBe(drain ? "draining" : "ready");

      markGatewayRestartDraining();

      expect(getGatewaySuspendStatus("suspension-restart", true)).toMatchObject({
        status: "draining",
        ownerId: "request-restart",
        phase: "interrupting",
        activeCount: Number(drain),
      });
      expect(resumeScheduling).not.toHaveBeenCalled();
      expect(isGatewayWorkAdmissionClosed()).toBe(true);
    },
  );

  it.each([false, true])(
    "exposes scheduler recovery after a held lease cannot resume (drain: %s)",
    async (drain) => {
      vi.useFakeTimers();
      try {
        const resumeScheduling = vi
          .fn()
          .mockImplementationOnce(() => {
            throw new Error("timer unavailable");
          })
          .mockImplementationOnce(() => {});
        await prepareGatewaySuspend({
          requestId: "request-resume-retry",
          drain,
          pauseScheduling: vi.fn(),
          resumeScheduling,
          inspect: inspectors({ getQueueSize: () => Number(drain) }),
          createSuspensionId: () => "suspension-resume-retry",
        });

        expect(resumeGatewaySuspend("suspension-resume-retry")).toMatchObject({
          ok: false,
          reason: "scheduler-resume-failed",
        });
        expect(isGatewayWorkAdmissionClosed()).toBe(true);
        expect(getGatewaySuspendStatus("suspension-resume-retry")).toMatchObject({
          status: "recovering",
        });
        expect(
          await prepareGatewaySuspend({
            requestId: "request-resume-retry",
            pauseScheduling: vi.fn(),
            resumeScheduling,
            inspect: inspectors(),
          }),
        ).toMatchObject({ status: "recovering" });
        expect(resumeGatewaySuspend("suspension-resume-retry")).toMatchObject({
          ok: false,
          reason: "scheduler-resume-failed",
        });

        vi.advanceTimersByTime(1_000);
        expect(resumeScheduling).toHaveBeenCalledTimes(2);
        expect(getGatewaySuspendStatus("suspension-resume-retry")).toEqual({ status: "running" });
        expect(isGatewayWorkAdmissionClosed()).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it.each(
    [false, true].flatMap((drain) =>
      [0, SUSPEND_TTL_MS / 2].flatMap((preparationMs) =>
        [false, true].map((rollbackClock) => ({ drain, preparationMs, rollbackClock })),
      ),
    ),
  )(
    "auto-resumes at the original expiry (drain: $drain, preparation: $preparationMs ms, clock rollback: $rollbackClock)",
    async ({ drain, preparationMs, rollbackClock }) => {
      vi.useFakeTimers();
      try {
        const resumeScheduling = vi.fn();
        const expiresAtMs = Date.now() + SUSPEND_TTL_MS;
        expect(
          await prepareGatewaySuspend({
            requestId: "request-expiry",
            drain,
            pauseScheduling: vi.fn(),
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

        vi.advanceTimersByTime(SUSPEND_TTL_MS - preparationMs - 1);
        expect(resumeScheduling).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);
        expect(resumeScheduling).toHaveBeenCalledOnce();
        expect(isGatewayWorkAdmissionClosed()).toBe(false);
        expect(getGatewaySuspendStatus("suspension-expiry")).toEqual({ status: "running" });
      } finally {
        resetGatewaySuspendCoordinatorForLifecycleRestart();
        vi.useRealTimers();
      }
    },
  );

  it.each(
    ["status", "renewal"].flatMap((operation) =>
      [0, 1].map((remainingWork) => ({ operation, remainingWork })),
    ),
  )(
    "expires after a slow draining inspection (operation: $operation, remaining work: $remainingWork)",
    async ({ operation, remainingWork }) => {
      vi.useFakeTimers();
      try {
        const resumeScheduling = vi.fn();
        const params = {
          requestId: "slow-drain-inspection",
          drain: true,
          pauseScheduling: vi.fn(),
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
        expect(await prepareGatewaySuspend(params)).toMatchObject({ status: "draining" });
        if (operation === "status") {
          expect(getGatewaySuspendStatus("slow-drain-inspection")).toEqual({ status: "running" });
        } else {
          await expect(prepareGatewaySuspend(params)).rejects.toThrow(
            "gateway suspension changed during preparation",
          );
        }
        expect(resumeScheduling).toHaveBeenCalledOnce();
        expect(isGatewayWorkAdmissionClosed()).toBe(false);
      } finally {
        resetGatewaySuspendCoordinatorForLifecycleRestart();
        vi.useRealTimers();
      }
    },
  );

  it("automatically resumes a short remaining budget with real timers", async () => {
    let elapsedInspectionMs = 0;
    const resumeScheduling = vi.fn();
    try {
      const result = await prepareGatewaySuspend({
        requestId: "real-timer-expiry",
        pauseScheduling: vi.fn(),
        resumeScheduling,
        nowMs: () => Date.now() + elapsedInspectionMs,
        inspect: inspectors({
          getQueueSize: () => {
            elapsedInspectionMs = SUSPEND_TTL_MS - 100;
            return 0;
          },
        }),
      });
      expect(result).toMatchObject({ status: "ready" });
      expect(isGatewayWorkAdmissionClosed()).toBe(true);
      await vi.waitFor(() => expect(resumeScheduling).toHaveBeenCalledOnce());
      expect(isGatewayWorkAdmissionClosed()).toBe(false);
    } finally {
      resetGatewaySuspendCoordinatorForLifecycleRestart();
    }
  });

  it.each(
    [false, true].flatMap((drain) =>
      ["inspection", "lease setup"].map((phase) => ({ drain, phase })),
    ),
  )(
    "resumes instead of returning an already-expired lease (drain: $drain, phase: $phase)",
    async ({ drain, phase }) => {
      vi.useFakeTimers();
      try {
        const resumeScheduling = vi.fn();
        await expect(
          prepareGatewaySuspend({
            requestId: "expired-inspection",
            drain,
            pauseScheduling: vi.fn(),
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
        ).rejects.toThrow("gateway suspension expired during preparation");
        expect(resumeScheduling).toHaveBeenCalledOnce();
        expect(isGatewayWorkAdmissionClosed()).toBe(false);
        expect(getGatewaySuspendStatus("expired-inspection")).toEqual({ status: "running" });
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("ignores an already-queued expiry callback after the same drain lease is renewed", async () => {
    vi.useFakeTimers();
    try {
      let nowMs = 1_000;
      const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
      const resumeScheduling = vi.fn();
      const params = {
        requestId: "request-stale-drain-expiry",
        drain: true,
        pauseScheduling: vi.fn(),
        resumeScheduling,
        inspect: inspectors({ getTerminalSessions: () => 1 }),
        nowMs: () => nowMs,
        createSuspensionId: () => "suspension-stale-drain-expiry",
      };

      expect(await prepareGatewaySuspend(params)).toMatchObject({ status: "draining" });
      const staleExpiry = timeoutSpy.mock.calls[0]?.[0];
      expect(typeof staleExpiry).toBe("function");

      nowMs = 2_000;
      expect(await prepareGatewaySuspend(params)).toMatchObject({
        status: "draining",
        expiresAtMs: 2_000 + SUSPEND_TTL_MS,
      });
      if (typeof staleExpiry !== "function") {
        throw new Error("missing initial suspension expiry callback");
      }
      staleExpiry();

      expect(resumeScheduling).not.toHaveBeenCalled();
      expect(getGatewaySuspendAdmissionPhase()).toBe("draining");
      expect(getGatewaySuspendStatus("suspension-stale-drain-expiry")).toMatchObject({
        status: "draining",
        expiresAtMs: 2_000 + SUSPEND_TTL_MS,
      });

      vi.advanceTimersByTime(SUSPEND_TTL_MS);
      expect(resumeScheduling).toHaveBeenCalledOnce();
      expect(isGatewayWorkAdmissionClosed()).toBe(false);
    } finally {
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
  });

  it("enters recovery when lease expiry cannot resume the scheduler", async () => {
    vi.useFakeTimers();
    const phases: string[] = [];
    const unsubscribe = onGatewaySuspendAdmissionChange((phase) => phases.push(phase));
    try {
      const resumeScheduling = vi
        .fn()
        .mockImplementationOnce(() => {
          throw new Error("timer unavailable");
        })
        .mockImplementationOnce(() => {});
      await prepareGatewaySuspend({
        requestId: "request-expiry-recovery",
        pauseScheduling: vi.fn(),
        resumeScheduling,
        inspect: inspectors(),
        createSuspensionId: () => "suspension-expiry-recovery",
      });

      vi.advanceTimersByTime(SUSPEND_TTL_MS);
      expect(getGatewaySuspendStatus("suspension-expiry-recovery")).toMatchObject({
        status: "recovering",
      });
      expect(isGatewayWorkAdmissionClosed()).toBe(true);
      expect(phases).toEqual(["preparing", "prepared"]);

      vi.advanceTimersByTime(1_000);
      expect(resumeScheduling).toHaveBeenCalledTimes(2);
      expect(getGatewaySuspendStatus("suspension-expiry-recovery")).toEqual({
        status: "running",
      });
      expect(isGatewayWorkAdmissionClosed()).toBe(false);
      expect(phases).toEqual(["preparing", "prepared", "accepting"]);
    } finally {
      unsubscribe();
      vi.useRealTimers();
    }
  });

  it.each([false, true])(
    "expires synchronously when timer delivery is delayed (drain: %s)",
    async (drain) => {
      let nowMs = 10_000;
      const resumeScheduling = vi.fn();
      await prepareGatewaySuspend({
        requestId: "request-delayed-expiry",
        drain,
        pauseScheduling: vi.fn(),
        resumeScheduling,
        inspect: inspectors({ getQueueSize: () => Number(drain) }),
        nowMs: () => nowMs,
        createSuspensionId: () => "suspension-delayed-expiry",
      });

      nowMs += SUSPEND_TTL_MS;

      expect(getGatewaySuspendStatus("suspension-delayed-expiry")).toEqual({ status: "running" });
      expect(resumeScheduling).toHaveBeenCalledOnce();
      expect(isGatewayWorkAdmissionClosed()).toBe(false);
    },
  );
});
