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
const drainExpiry = 1_000 + DRAIN_BUDGET_MS;
const emptyWork = { activeCount: 0, blockers: [], writeCustody: [] };
const replyBlocker = { kind: "reply", count: 1, message: "1 pending reply delivery operation(s)" };
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

function expectReopened(resume = resumeScheduling) {
  expect(resume).toHaveBeenCalledOnce();
  expect(isGatewayWorkAdmissionClosed()).toBe(false);
}

function expectFenced(phase: "draining" | "prepared", resume = resumeScheduling) {
  expect(getGatewaySuspendAdmissionPhase()).toBe(phase);
  expect(tryBeginGatewayRootWorkAdmission()).toBeNull();
  expect(resume).not.toHaveBeenCalled();
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
  it.each([
    { action: "reset", drain: false },
    { action: "reset", drain: true },
    { action: "resume", drain: true },
  ])(
    "$action resumes the scheduler before clearing admission (drain: $drain)",
    ({ action, drain }) => {
      const resumeWhileClosed = vi.fn(() => {
        expect(isGatewayWorkAdmissionClosed()).toBe(true);
        if (action === "resume") {
          expect(getGatewaySuspendAdmissionPhase()).toBe("draining");
        }
      });
      expect(
        prepare({
          drain,
          resumeScheduling: resumeWhileClosed,
          inspect: { getQueueSize: () => Number(drain) },
        }),
      ).toMatchObject({ status: drain ? "draining" : "ready" });

      if (action === "reset") {
        markGatewayRestartDraining();
        expect(resumeWhileClosed).not.toHaveBeenCalled();
        expect(isGatewayWorkAdmissionClosed()).toBe(true);
        resetGatewaySuspendCoordinatorForLifecycleRestart();
        expect(resumeWhileClosed).toHaveBeenCalledOnce();
        resetGatewayWorkAdmission();
      } else {
        expect(resumeGatewaySuspend(LEASE)).toEqual(resumed);
      }
      expectReopened(resumeWhileClosed);
    },
  );

  it("reopens admission after refusing hidden background work until its process exits", () => {
    const session = createProcessSessionFixture({
      id: "private-background-session",
      command: "private command",
    });
    addSession(session);
    markBackgrounded(session);
    deleteSession(session.id);
    const events: string[] = [];
    const params = {
      pauseScheduling: () => events.push("pause"),
      resumeScheduling: () => events.push("resume"),
      inspect: {
        getBackgroundExecSessions: () => {
          events.push("inspect");
          return getActiveBackgroundExecSessionCount();
        },
      },
    };
    expect(prepare(params)).toMatchObject({
      status: "busy",
      reason: "active-work",
      retryAfterMs: SUSPEND_BUSY_RETRY_AFTER_MS,
      activeCount: 1,
      writeCustody: [],
      blockers: [{ kind: "background-exec", count: 1 }],
    });
    expect(events).toEqual(["pause", "inspect", "resume"]);
    expect(isGatewayWorkAdmissionClosed()).toBe(false);
    markExited(session, 0, null, "completed");
    expect(prepare(params)).toMatchObject({ status: "ready", activeCount: 0, blockers: [] });
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
    ).toMatchObject({
      status: "draining",
      activeCount: 3,
      writeCustody: [{ phase: "terminal-persistence", count: 1 }],
      blockers: [
        { kind: "reply", count: 1 },
        { kind: "terminal-persistence", count: 1 },
        { kind: "terminal-session", count: 1 },
      ],
    });
    expect(pauseScheduling).toHaveBeenCalledOnce();
    expectFenced("draining");
    expect(tryBeginGatewayPreparedRestartRootWorkAdmission()).toBeNull();

    terminalPersistence = 0;
    terminalSessions = 0;
    expect(getGatewaySuspendStatus(LEASE)).toEqual({
      status: "draining",
      expiresAtMs: drainExpiry,
      retryAfterMs: 5_000,
      activeCount: 1,
      blockers: [replyBlocker],
      writeCustody: [],
    });
    expect(getGatewaySuspendAdmissionPhase()).toBe("draining");

    pendingReplies = 0;
    expect(getGatewaySuspendStatus(LEASE)).toEqual({
      status: "ready",
      expiresAtMs: drainExpiry,
      writeCustody: [],
    });
    expectFenced("prepared");
    expect(resumeGatewaySuspend(LEASE)).toEqual(resumed);
    expectReopened();
  });

  it.each([
    { terminalPolicy: "preserve", drain: true },
    { terminalPolicy: "terminate", drain: true },
    { terminalPolicy: "preserve", drain: false },
  ] as const)(
    "renews only freeze leases and rejects conflicting owners or modes ($terminalPolicy, drain=$drain)",
    ({ terminalPolicy, drain }) => {
      let queued = 2;
      let nowMs = 1_000;
      const params = {
        terminalPolicy,
        drain,
        inspect: {
          getQueueSize: () => (drain ? queued : 0),
          getTerminalSessions: () => (terminalPolicy === "terminate" ? 2 : 0),
        },
        nowMs: () => nowMs,
      };

      expect(prepare(params)).toMatchObject({
        status: drain ? "draining" : "ready",
        suspensionId: LEASE,
        expiresAtMs: 1_000 + (drain ? DRAIN_BUDGET_MS : SUSPEND_TTL_MS),
        activeCount: drain ? 2 : 0,
      });

      nowMs = 2_000;
      queued = 1;
      const expiresAtMs = drain ? drainExpiry : nowMs + SUSPEND_TTL_MS;
      expect(prepare({ ...params, inspect: { getQueueSize: () => 99 } })).toMatchObject({
        status: drain ? "draining" : "ready",
        suspensionId: LEASE,
        expiresAtMs,
        activeCount: drain ? 1 : 0,
      });
      const otherTerminalPolicy = terminalPolicy === "preserve" ? "terminate" : "preserve";
      for (const conflict of [
        { requestId: "request-other" },
        { drain: !drain },
        { terminalPolicy: otherTerminalPolicy },
      ] satisfies Partial<SuspendOptions>[]) {
        expect(prepare({ ...params, ...conflict })).toEqual({
          status: "conflict",
          expiresAtMs,
        });
      }
      expect(pauseScheduling).toHaveBeenCalledOnce();

      nowMs = 3_000;
      queued = 0;
      expect(prepare(params)).toEqual({
        status: "ready",
        suspensionId: LEASE,
        expiresAtMs: drain ? drainExpiry : nowMs + SUSPEND_TTL_MS,
        ...emptyWork,
      });
      expectFenced("prepared");
      expect(pauseScheduling).toHaveBeenCalledOnce();
      expect(resumeGatewaySuspend("wrong-id")).toEqual({
        ok: false,
        reason: "suspension-mismatch",
      });
      expect(resumeGatewaySuspend(LEASE)).toEqual(resumed);
      expectReopened();
    },
  );

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
    expectReopened();
  });

  it.each([
    { drain: false, preparationMs: 0, rollbackClock: false },
    { drain: true, preparationMs: 0, rollbackClock: false },
    { drain: false, preparationMs: SUSPEND_TTL_MS / 2, rollbackClock: true },
    { drain: true, preparationMs: DRAIN_BUDGET_MS / 2, rollbackClock: false },
  ])(
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
      expectReopened();
      expect(getGatewaySuspendStatus(LEASE)).toEqual({ status: "running" });
    },
  );

  it.each(["status", "renewal"])(
    "expires after a slow draining inspection during %s",
    (operation) => {
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
              return 1;
            }),
        },
      };
      expect(prepare(params)).toMatchObject({ status: "draining" });
      if (operation === "status") {
        expect(getGatewaySuspendStatus(LEASE)).toEqual({ status: "running" });
      } else {
        expect(() => prepare(params)).toThrow("gateway suspension changed during preparation");
      }
      expectReopened();
    },
  );

  it.each([
    { drain: false, phase: "inspection" },
    { drain: true, phase: "lease setup" },
  ])(
    "resumes instead of returning an already-expired lease (drain: $drain, phase: $phase)",
    ({ drain, phase }) => {
      vi.useFakeTimers();
      const expire = () => {
        vi.advanceTimersByTime(SUSPEND_TTL_MS);
        return Number(drain);
      };
      expect(() =>
        prepare({
          drain,
          inspect: { getQueueSize: phase === "inspection" ? expire : () => Number(drain) },
          createSuspensionId: () => {
            if (phase === "lease setup") {
              expire();
            }
            return LEASE;
          },
        }),
      ).toThrow("gateway suspension expired during preparation");
      expectReopened();
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

  it.each([false, true])("commits shutdown once before acknowledging (draining=%s)", (draining) => {
    const fixture = setup(draining);
    const committed = fixture.commit();
    expect(committed).toEqual({
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
    expect(fixture.commit()).toEqual(committed);
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

  it("consumes one arm without renewal and rechecks late terminal custody after becoming ready", () => {
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
    expectFenced("prepared", fixture.params.resumeScheduling);
    expect(fixture.consume()).toEqual({
      ok: false,
      error: "gateway terminal persistence is still pending",
    });
    expect(fixture.consume()).toEqual({ ok: true, value: false });
    expect(fixture.arm().ok).toBe(false);
    fixture.state.pending = 0;
    expect(fixture.prepare()).toMatchObject({ status: "ready", activeCount: 0, blockers: [] });
    expectFenced("prepared", fixture.params.resumeScheduling);
  });

  const invalidate = {
    expiry: (fixture) => (fixture.state.now += DRAIN_BUDGET_MS),
    resume: (fixture) => fixture.resume(),
    replacement: (fixture) => {
      fixture.resume();
      fixture.prepare();
    },
    host: (fixture) => (fixture.state.current = false),
    restart: () => markGatewayRestartDraining(),
    disarm: (fixture) => disarmGatewaySuspendHandoff(fixture.owner),
  } satisfies Record<string, (fixture: ReturnType<typeof setup>) => unknown>;
  it.each(Object.entries(invalidate))(
    "refuses a previously armed handoff after %s",
    (_change, invalidateHandoff) => {
      const fixture = setup();
      expect(fixture.arm().ok).toBe(true);
      invalidateHandoff(fixture);
      expect(fixture.consume()).not.toEqual({ ok: true, value: true });
      expect(fixture.consume()).toEqual({ ok: true, value: false });
    },
  );
});
