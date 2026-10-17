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

function reset() {
  resetProcessRegistryForTests();
  resetGatewaySuspendCoordinatorForLifecycleRestart();
  resetGatewayWorkAdmission();
}
beforeEach(reset);
afterEach(reset);

describe("gateway suspend coordinator", () => {
  describe("external restart handoff", () => {
    const setup = (draining: boolean) => {
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
        createSuspensionId: () => "external-lease",
      };
      expect(prepareGatewaySuspend(params).status).toBe(draining ? "draining" : "ready");
      return {
        owner,
        state,
        commitStop,
        params,
        arm: () => armGatewaySuspendHandoff({ suspensionId: "external-lease", owner }),
        consume: () => consumeGatewaySuspendHandoff(owner),
        commit: () =>
          armGatewaySuspendHandoff({ suspensionId: "external-lease", owner, commit: true }),
      };
    };

    it("commits the host's one-way shutdown before acknowledging and preserves it after expiry", () => {
      const fixture = setup(false);
      expect(fixture.commit()).toEqual({
        ok: true,
        value: { status: "committed", suspensionId: "external-lease", expiresAtMs: 46_000 },
      });
      expect(fixture.commitStop).toHaveBeenCalledOnce();
      expect(resumeGatewaySuspend("external-lease")).toEqual({
        ok: false,
        reason: "gateway-restarting",
      });
      fixture.state.now += SUSPEND_TTL_MS + 1;
      expect(getGatewaySuspendStatus("external-lease", true)).toMatchObject({
        status: "draining",
        phase: "interrupting",
      });
      expect(tryBeginGatewayRootWorkAdmission()).toBeNull();
      expect(fixture.params.resumeScheduling).not.toHaveBeenCalled();
    });

    it("reconciles a lost committed reply without committing twice or adopting another host", () => {
      const fixture = setup(true);
      const committed = fixture.commit();
      expect(committed.ok).toBe(true);
      fixture.state.now += SUSPEND_TTL_MS + 1;
      expect(fixture.commit()).toEqual(committed);
      expect(fixture.commitStop).toHaveBeenCalledOnce();
      expect(
        armGatewaySuspendHandoff({
          suspensionId: "another-lease",
          owner: fixture.owner,
          commit: true,
        }).ok,
      ).toBe(false);
      expect(
        armGatewaySuspendHandoff({
          suspensionId: "external-lease",
          owner: { isCurrent: () => true, commitStop: fixture.commitStop },
          commit: true,
        }).ok,
      ).toBe(false);
      expect(fixture.commitStop).toHaveBeenCalledOnce();
      expect(isGatewayWorkAdmissionClosed()).toBe(true);
    });

    it.each(["expired", "resumed", "write custody", "old host"] as const)(
      "refuses committed shutdown for %s without invoking the host exit owner",
      (reason) => {
        const fixture = setup(true);
        if (reason === "expired") {
          fixture.state.now += SUSPEND_TTL_MS;
        } else if (reason === "resumed") {
          resumeGatewaySuspend("external-lease");
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
      expect(getGatewaySuspendStatus("external-lease").status).toBe("ready");
      expect(resumeGatewaySuspend("external-lease")).toMatchObject({ ok: true, resumed: true });
    });

    it("consumes one explicit arm without renewing it", () => {
      const fixture = setup(true);
      expect(fixture.consume()).toEqual({ ok: true, value: false });
      expect(fixture.arm()).toEqual({
        ok: true,
        value: { status: "armed", suspensionId: "external-lease", expiresAtMs: 46_000 },
      });
      fixture.state.now += 30_000;
      expect(prepareGatewaySuspend(fixture.params)).toMatchObject({ expiresAtMs: 46_000 });
      expect(fixture.arm()).toMatchObject({ ok: true, value: { expiresAtMs: 46_000 } });
      expect(fixture.consume()).toEqual({ ok: true, value: true });
      expect(fixture.consume()).toEqual({ ok: true, value: false });
      expect(isGatewayWorkAdmissionClosed()).toBe(true);
      expect(fixture.params.resumeScheduling).not.toHaveBeenCalled();
    });

    it.each(["expiry", "resume", "replacement", "host", "restart", "disarm"])(
      "refuses a previously armed handoff after %s",
      (change) => {
        const fixture = setup(true);
        expect(fixture.arm().ok).toBe(true);
        if (change === "expiry") {
          fixture.state.now += SUSPEND_TTL_MS;
        }
        if (change === "resume" || change === "replacement") {
          resumeGatewaySuspend("external-lease");
        }
        if (change === "replacement") {
          prepareGatewaySuspend(fixture.params);
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
      const fixture = setup(true);
      fixture.state.work = 0;
      expect(getGatewaySuspendStatus("external-lease").status).toBe("ready");
      expect(fixture.arm().ok).toBe(true);
      fixture.state.pending = 1;
      const pending = {
        status: "draining",
        activeCount: 1,
        blockers: [expect.objectContaining({ kind: "terminal-persistence", count: 1 })],
      };
      expect(prepareGatewaySuspend(fixture.params)).toMatchObject(pending);
      expect(getGatewaySuspendStatus("external-lease")).toMatchObject(pending);
      expect(getGatewaySuspendAdmissionPhase()).toBe("prepared");
      expect(tryBeginGatewayRootWorkAdmission()).toBeNull();
      expect(fixture.consume()).toEqual({
        ok: false,
        error: "gateway terminal persistence is still pending",
      });
      expect(fixture.consume()).toEqual({ ok: true, value: false });
      expect(fixture.arm().ok).toBe(false);

      fixture.state.pending = 0;
      expect(prepareGatewaySuspend(fixture.params)).toMatchObject({
        status: "ready",
        activeCount: 0,
        blockers: [],
      });
      expect(getGatewaySuspendAdmissionPhase()).toBe("prepared");
      expect(fixture.params.resumeScheduling).not.toHaveBeenCalled();
    });
  });
});
