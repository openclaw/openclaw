// Covers external restart handoff authority, expiry, and final-write custody.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetProcessRegistryForTests } from "../agents/bash-process-registry.test-support.js";
import {
  getGatewaySuspendAdmissionPhase,
  isGatewayWorkAdmissionClosed,
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
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

const SUSPEND_TTL_MS = 45_000;
const LEASE = "external-lease";

function reset() {
  resetProcessRegistryForTests();
  resetGatewaySuspendCoordinatorForLifecycleRestart();
  resetGatewayWorkAdmission();
}
beforeEach(reset);
afterEach(reset);

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
      requestId: "external-host",
      drain: true,
      pauseScheduling: vi.fn(),
      resumeScheduling: vi.fn(),
      inspect: inspectors({
        getRootRequests: () => state.work,
        getTerminalPersistence: () => state.pending,
        getSessionMutations: () => state.mutations,
      }),
      nowMs: () => state.now,
      createSuspensionId: () => LEASE,
    };
    expect(prepareGatewaySuspend(params).status).toBe(draining ? "draining" : "ready");
    return {
      owner,
      state,
      commitStop,
      params,
      status: () => getGatewaySuspendStatus(LEASE),
      resume: () => resumeGatewaySuspend(LEASE),
      prepare: () => prepareGatewaySuspend(params),
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
    fixture.state.now += SUSPEND_TTL_MS + 1;
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
    fixture.state.now += SUSPEND_TTL_MS + 1;
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
        fixture.state.now += SUSPEND_TTL_MS;
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
        fixture.state.now += SUSPEND_TTL_MS;
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
