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
  armGatewaySuspendHandoff,
  consumeGatewaySuspendHandoff,
  disarmGatewaySuspendHandoff,
  getGatewaySuspendStatus,
  prepareGatewaySuspend,
  resetGatewaySuspendCoordinatorForLifecycleRestart,
  resumeGatewaySuspend,
  type GatewaySuspendHandoffOwner,
} from "./gateway-suspend-coordinator.js";
import { inspectors } from "./gateway-suspend-coordinator.test-support.js";

const SUSPEND_TTL_MS = 2 * 60_000;
const DRAIN_BUDGET_MS = 45_000;
const SUSPEND_BUSY_RETRY_AFTER_MS = 20_000;
const resumed = { ok: true, status: "running", resumed: true };
const LEASE = "suspension";
const pauseScheduling = vi.fn();
const resumeScheduling = vi.fn();
type SuspendOptions = Parameters<typeof prepareGatewaySuspend>[0];
function prepare(options: Partial<SuspendOptions> = {}) {
  return prepareGatewaySuspend({
    requestId: "request",
    pauseScheduling,
    resumeScheduling,
    createSuspensionId: () => LEASE,
    ...options,
    inspect: options.inspect && inspectors(options.inspect),
  });
}

function reset() {
  resetProcessRegistryForTests();
  resetGatewaySuspendCoordinatorForLifecycleRestart();
  resetGatewayWorkAdmission();
}

beforeEach(() => {
  reset();
  pauseScheduling.mockClear();
  resumeScheduling.mockClear();
});
afterEach(() => {
  reset();
  vi.useRealTimers();
});

describe("gateway suspend coordinator", () => {
  it.each([false, true])(
    "lifecycle reset resumes a held scheduler before admission is cleared (drain: %s)",
    (drain) => {
      const resumeWhileClosed = vi.fn(() => {
        expect(isGatewayWorkAdmissionClosed()).toBe(true);
      });
      expect(
        prepare({
          drain,
          resumeScheduling: resumeWhileClosed,
          inspect: { getQueueSize: () => Number(drain) },
        }),
      ).toMatchObject({ status: drain ? "draining" : "ready" });

      markGatewayRestartDraining();
      expect(resumeWhileClosed).not.toHaveBeenCalled();
      expect(isGatewayWorkAdmissionClosed()).toBe(true);

      resetGatewaySuspendCoordinatorForLifecycleRestart();

      expect(resumeWhileClosed).toHaveBeenCalledOnce();
      resetGatewayWorkAdmission();
      expect(isGatewayWorkAdmissionClosed()).toBe(false);
    },
  );

  it("reopens admission in the same turn when active work refuses preparation", () => {
    const events: string[] = [];
    const result = prepare({
      pauseScheduling: () => events.push("pause"),
      resumeScheduling: () => events.push("resume"),
      inspect: {
        getQueueSize: () => {
          events.push("inspect");
          return 1;
        },
      },
    });

    expect(result.status).toBe("busy");
    expect(events).toEqual(["pause", "inspect", "resume"]);
    expect(isGatewayWorkAdmissionClosed()).toBe(false);
  });

  it("holds a preserve-only drain until terminal persistence, delivery, and sessions settle", () => {
    let pendingReplies = 1;
    let terminalPersistence = 1;
    let terminalSessions = 1;
    const inspect = {
      getPendingReplies: () => pendingReplies,
      getTerminalPersistence: () => terminalPersistence,
      getTerminalSessions: () => terminalSessions,
    };

    expect(
      prepare({
        terminalPolicy: "preserve",
        drain: true,
        inspect,
        nowMs: () => 1_000,
      }),
    ).toEqual({
      status: "draining",
      suspensionId: LEASE,
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
    expect(getGatewaySuspendStatus(LEASE)).toEqual({
      status: "draining",
      expiresAtMs: 1_000 + DRAIN_BUDGET_MS,
      retryAfterMs: 5_000,
      activeCount: 1,
      blockers: [{ kind: "reply", count: 1, message: "1 pending reply delivery operation(s)" }],
      writeCustody: [],
    });
    expect(getGatewaySuspendAdmissionPhase()).toBe("draining");

    pendingReplies = 0;
    expect(getGatewaySuspendStatus(LEASE)).toEqual({
      status: "ready",
      expiresAtMs: 1_000 + DRAIN_BUDGET_MS,
      writeCustody: [],
    });
    expect(getGatewaySuspendAdmissionPhase()).toBe("prepared");
    expect(tryBeginGatewayRootWorkAdmission()).toBeNull();
    expect(resumeScheduling).not.toHaveBeenCalled();
    expect(resumeGatewaySuspend(LEASE)).toEqual(resumed);
    expect(resumeScheduling).toHaveBeenCalledOnce();
    expect(isGatewayWorkAdmissionClosed()).toBe(false);
  });

  it.each(["preserve", "terminate"] as const)(
    "retains the absolute deadline of the same %s drain and rejects conflicting request, policy, or drain modes",
    (terminalPolicy) => {
      let queued = 2;
      let nowMs = 1_000;
      const params = {
        terminalPolicy,
        drain: true,
        inspect: {
          getQueueSize: () => queued,
          getTerminalSessions: () => (terminalPolicy === "terminate" ? 2 : 0),
        },
        nowMs: () => nowMs,
      };

      expect(prepare(params)).toMatchObject({
        status: "draining",
        suspensionId: LEASE,
        expiresAtMs: 1_000 + DRAIN_BUDGET_MS,
        activeCount: 2,
      });

      nowMs = 2_000;
      queued = 1;
      expect(prepare(params)).toMatchObject({
        status: "draining",
        suspensionId: LEASE,
        expiresAtMs: 1_000 + DRAIN_BUDGET_MS,
        activeCount: 1,
      });
      const otherTerminalPolicy = terminalPolicy === "preserve" ? "terminate" : "preserve";
      for (const conflict of [
        { requestId: "request-other" },
        { drain: false },
        { terminalPolicy: otherTerminalPolicy },
      ] satisfies Partial<SuspendOptions>[]) {
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
        suspensionId: LEASE,
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
    const resumeWhileDraining = vi.fn(() => {
      expect(getGatewaySuspendAdmissionPhase()).toBe("draining");
    });
    expect(
      prepare({
        drain: true,
        resumeScheduling: resumeWhileDraining,
        inspect: { getTerminalSessions: () => 1 },
      }),
    ).toMatchObject({ status: "draining" });

    expect(resumeGatewaySuspend(LEASE)).toEqual(resumed);
    expect(resumeWhileDraining).toHaveBeenCalledOnce();
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

    const inspect = {
      getBackgroundExecSessions: getActiveBackgroundExecSessionCount,
    };
    expect(prepare({ inspect })).toEqual({
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
    expect(prepare({ inspect })).toMatchObject({ status: "ready", activeCount: 0, blockers: [] });
  });

  it("reopens admission when inspection fails before admission commits", () => {
    expect(() =>
      prepare({
        inspect: {
          getQueueSize: () => {
            throw new Error("inspection failed");
          },
        },
      }),
    ).toThrow("inspection failed");
    expect(resumeScheduling).toHaveBeenCalledOnce();
    expect(isGatewayWorkAdmissionClosed()).toBe(false);
  });

  it("renews one ready lease and resumes only with the matching id", () => {
    expect(
      prepare({
        inspect: {},
        nowMs: () => 1_000,
      }),
    ).toMatchObject({
      status: "ready",
      suspensionId: LEASE,
      expiresAtMs: 1_000 + SUSPEND_TTL_MS,
    });
    expect(isGatewayWorkAdmissionClosed()).toBe(true);

    expect(
      prepare({
        inspect: { getQueueSize: () => 99 },
        nowMs: () => 2_000,
      }),
    ).toMatchObject({
      status: "ready",
      suspensionId: LEASE,
      expiresAtMs: 2_000 + SUSPEND_TTL_MS,
    });
    expect(prepare({ requestId: "request-other" }).status).toBe("conflict");

    expect(resumeGatewaySuspend("wrong-id")).toEqual({
      ok: false,
      reason: "suspension-mismatch",
    });
    expect(resumeGatewaySuspend(LEASE)).toEqual(resumed);
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
      const ttlMs = drain ? DRAIN_BUDGET_MS : SUSPEND_TTL_MS;
      const expiresAtMs = Date.now() + ttlMs;
      expect(
        prepare({
          drain,
          inspect: {
            getQueueSize: () => {
              vi.advanceTimersByTime(preparationMs);
              if (rollbackClock) {
                vi.setSystemTime(Date.now() - preparationMs);
              }
              return Number(drain);
            },
          },
        }),
      ).toMatchObject({ status: drain ? "draining" : "ready", expiresAtMs });

      vi.advanceTimersByTime(ttlMs - preparationMs - 1);
      expect(resumeScheduling).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(resumeScheduling).toHaveBeenCalledOnce();
      expect(isGatewayWorkAdmissionClosed()).toBe(false);
      expect(getGatewaySuspendStatus(LEASE)).toEqual({ status: "running" });
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
      const params = {
        drain: true,
        inspect: {
          getQueueSize: vi
            .fn()
            .mockReturnValueOnce(1)
            .mockImplementation(() => {
              // Synchronous inspection prevents an expired timer from being delivered.
              vi.setSystemTime(Date.now() + SUSPEND_TTL_MS);
              return remainingWork;
            }),
        },
      };
      expect(prepare(params)).toMatchObject({ status: "draining" });
      if (operation === "status") {
        expect(getGatewaySuspendStatus(LEASE)).toEqual({ status: "running" });
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
      expect(() =>
        prepare({
          drain,
          inspect: {
            getQueueSize: () => {
              if (phase === "inspection") {
                vi.advanceTimersByTime(SUSPEND_TTL_MS);
              }
              return Number(drain);
            },
          },
          createSuspensionId: () => {
            if (phase === "lease setup") {
              vi.advanceTimersByTime(SUSPEND_TTL_MS);
            }
            return LEASE;
          },
        }),
      ).toThrow("gateway suspension expired during preparation");
      expect(resumeScheduling).toHaveBeenCalledOnce();
      expect(isGatewayWorkAdmissionClosed()).toBe(false);
      expect(getGatewaySuspendStatus(LEASE)).toEqual({ status: "running" });
    },
  );
});
describe("external restart handoff", () => {
  const setup = (draining = true) => {
    const state = { now: 1_000, pending: 0, work: Number(draining), mutations: 0, current: true };
    const owner: GatewaySuspendHandoffOwner = { isCurrent: () => state.current };
    const commitStop = vi.fn(() => {
      const consumed = consumeGatewaySuspendHandoff(owner);
      if (!consumed.ok || !consumed.value) {
        throw new Error("host did not consume its suspension");
      }
      markGatewayRestartDraining();
      state.current = false;
    });
    owner.commitStop = commitStop;
    const params = {
      drain: true,
      pauseScheduling: vi.fn(),
      resumeScheduling: vi.fn(),
      inspect: {
        getRootRequests: () => state.work,
        getTerminalPersistence: () => state.pending,
        getSessionMutations: () => state.mutations,
      },
      nowMs: () => state.now,
      createSuspensionId: () => LEASE,
    };
    expect(prepare(params).status).toBe(draining ? "draining" : "ready");
    return {
      owner,
      state,
      commitStop,
      params,
      status: () => getGatewaySuspendStatus(LEASE),
      resume: () => resumeGatewaySuspend(LEASE),
      prepare: () => prepare(params),
      arm: () => armGatewaySuspendHandoff({ suspensionId: LEASE, owner }),
      consume: () => consumeGatewaySuspendHandoff(owner),
      commit: (overrides: Partial<Parameters<typeof armGatewaySuspendHandoff>[0]> = {}) =>
        armGatewaySuspendHandoff({ suspensionId: LEASE, owner, commit: true, ...overrides }),
    };
  };

  it("commits the host's one-way shutdown before acknowledging and preserves it after expiry", () => {
    const fixture = setup(false);
    expect(fixture.commit()).toEqual({
      ok: true,
      value: { status: "committed", suspensionId: LEASE, expiresAtMs: 46_000 },
    });
    expect(fixture.commitStop).toHaveBeenCalledOnce();
    expect(fixture.resume()).toEqual({ ok: false, reason: "gateway-restarting" });
    fixture.state.now += DRAIN_BUDGET_MS + 1;
    expect(getGatewaySuspendStatus(LEASE, true)).toMatchObject({
      status: "draining",
      phase: "interrupting",
    });
    expect(tryBeginGatewayRootWorkAdmission()).toBeNull();
    expect(fixture.params.resumeScheduling).not.toHaveBeenCalled();
  });

  it("reconciles a lost committed reply without committing twice or adopting another host", () => {
    const fixture = setup();
    const committed = fixture.commit();
    expect(committed.ok).toBe(true);
    fixture.state.now += DRAIN_BUDGET_MS + 1;
    expect(fixture.commit()).toEqual(committed);
    expect(fixture.commitStop).toHaveBeenCalledOnce();
    expect(fixture.commit({ suspensionId: "another-lease" }).ok).toBe(false);
    expect(
      fixture.commit({
        owner: { isCurrent: () => true, commitStop: fixture.commitStop },
      }).ok,
    ).toBe(false);
    expect(fixture.commitStop).toHaveBeenCalledOnce();
    expect(isGatewayWorkAdmissionClosed()).toBe(true);
  });

  it.each(["expired", "resumed", "write custody", "old host"] as const)(
    "refuses committed shutdown for %s without invoking the host exit owner",
    (reason) => {
      const fixture = setup();
      if (reason === "expired") {
        fixture.state.now += DRAIN_BUDGET_MS;
      } else if (reason === "resumed") {
        fixture.resume();
      } else if (reason === "write custody") {
        fixture.state.mutations = 1;
      } else {
        delete fixture.owner.commitStop;
      }
      expect(fixture.commit().ok).toBe(false);
      expect(fixture.commitStop).not.toHaveBeenCalled();
    },
  );

  it("does not acknowledge a host callback that leaves suspension reversible", () => {
    const fixture = setup(false);
    fixture.owner.commitStop = () => {};
    expect(fixture.commit().ok).toBe(false);
    expect(fixture.status().status).toBe("ready");
    expect(fixture.resume()).toMatchObject({ ok: true, resumed: true });
  });

  it("consumes one explicit arm without renewing it", () => {
    const fixture = setup();
    expect(fixture.consume()).toEqual({ ok: true, value: false });
    expect(fixture.arm()).toEqual({
      ok: true,
      value: { status: "armed", suspensionId: LEASE, expiresAtMs: 46_000 },
    });
    fixture.state.now += 30_000;
    expect(fixture.prepare()).toMatchObject({ expiresAtMs: 46_000 });
    expect(fixture.arm()).toMatchObject({ ok: true, value: { expiresAtMs: 46_000 } });
    expect(fixture.consume()).toEqual({ ok: true, value: true });
    expect(fixture.consume()).toEqual({ ok: true, value: false });
    expect(isGatewayWorkAdmissionClosed()).toBe(true);
    expect(fixture.params.resumeScheduling).not.toHaveBeenCalled();
  });

  it.each(["expiry", "resume", "replacement", "host", "restart", "disarm"])(
    "refuses a previously armed handoff after %s",
    (change) => {
      const fixture = setup();
      expect(fixture.arm().ok).toBe(true);
      if (change === "expiry") {
        fixture.state.now += DRAIN_BUDGET_MS;
      }
      if (change === "resume" || change === "replacement") {
        fixture.resume();
      }
      if (change === "replacement") {
        fixture.prepare();
      }
      if (change === "host") {
        fixture.state.current = false;
      }
      if (change === "restart") {
        markGatewayRestartDraining();
      }
      if (change === "disarm") {
        disarmGatewaySuspendHandoff(fixture.owner);
      }
      expect(fixture.consume()).not.toEqual({ ok: true, value: true });
      expect(fixture.consume()).toEqual({ ok: true, value: false });
    },
  );

  it("refreshes final-chat custody after a lease becomes ready", () => {
    const fixture = setup();
    fixture.state.work = 0;
    expect(fixture.status().status).toBe("ready");
    expect(fixture.arm().ok).toBe(true);
    fixture.state.pending = 1;
    const pending = {
      status: "draining",
      activeCount: 1,
      blockers: [expect.objectContaining({ kind: "terminal-persistence", count: 1 })],
    };
    expect(fixture.prepare()).toMatchObject(pending);
    expect(fixture.status()).toMatchObject(pending);
    expect(getGatewaySuspendAdmissionPhase()).toBe("prepared");
    expect(tryBeginGatewayRootWorkAdmission()).toBeNull();
    expect(fixture.consume()).toEqual({
      ok: false,
      error: "gateway terminal persistence is still pending",
    });
    expect(fixture.consume()).toEqual({ ok: true, value: false });
    expect(fixture.arm().ok).toBe(false);

    fixture.state.pending = 0;
    expect(fixture.prepare()).toMatchObject({ status: "ready", activeCount: 0, blockers: [] });
    expect(getGatewaySuspendAdmissionPhase()).toBe("prepared");
    expect(fixture.params.resumeScheduling).not.toHaveBeenCalled();
  });
});
