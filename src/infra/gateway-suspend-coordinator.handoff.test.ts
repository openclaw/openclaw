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

const SUSPEND_TTL_MS = 2 * 60_000;

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
  describe("external restart handoff", () => {
    const setup = (draining: boolean) => {
      let now = 1_000;
      let pending = 0;
      let work = Number(draining);
      let mutations = 0;
      let current = true;
      const owner: GatewaySuspendHandoffOwner = { isCurrent: () => current };
      const commitStop = vi.fn(() => {
        const consumed = consumeGatewaySuspendHandoff(owner);
        if (!consumed.ok || !consumed.value) {
          throw new Error("host did not consume its suspension");
        }
        markGatewayRestartDraining();
        current = false;
      });
      owner.commitStop = commitStop;
      const params = {
        requestId: "external-host",
        drain: true,
        pauseScheduling: vi.fn(),
        resumeScheduling: vi.fn(),
        inspect: inspectors({
          getRootRequests: () => work,
          getTerminalPersistence: () => pending,
          getSessionMutations: () => mutations,
        }),
        nowMs: () => now,
        createSuspensionId: () => "external-lease",
      };
      expect(prepareGatewaySuspend(params).status).toBe(draining ? "draining" : "ready");
      return {
        owner,
        commitStop,
        params,
        arm: () =>
          armGatewaySuspendHandoff({
            suspensionId: "external-lease",
            owner,
          }),
        consume: () => consumeGatewaySuspendHandoff(owner),
        commit: () =>
          armGatewaySuspendHandoff({ suspensionId: "external-lease", owner, commit: true }),
        mutate: () => {
          mutations = 1;
        },
        advance: (ms: number) => {
          now += ms;
        },
        persist: () => {
          pending = 1;
        },
        finishPersistence: () => {
          pending = 0;
        },
        replaceHost: () => {
          current = false;
        },
        finishWork: () => {
          work = 0;
        },
      };
    };

    it.each([false])(
      "commits the host's one-way shutdown before acknowledging and preserves it after expiry (draining: %s)",
      (draining) => {
        const fixture = setup(draining);
        expect(fixture.commit()).toEqual({
          ok: true,
          value: { status: "committed", suspensionId: "external-lease", expiresAtMs: 121_000 },
        });
        expect(fixture.commitStop).toHaveBeenCalledOnce();
        expect(resumeGatewaySuspend("external-lease")).toEqual({
          ok: false,
          reason: "gateway-restarting",
        });
        fixture.advance(SUSPEND_TTL_MS + 1);
        expect(getGatewaySuspendStatus("external-lease", true)).toMatchObject({
          status: "draining",
          phase: "interrupting",
        });
        expect(tryBeginGatewayRootWorkAdmission()).toBeNull();
        expect(fixture.params.resumeScheduling).not.toHaveBeenCalled();
      },
    );

    it("reconciles a lost committed reply without committing twice or adopting another host", () => {
      const fixture = setup(true);
      const committed = fixture.commit();
      expect(committed.ok).toBe(true);
      fixture.advance(SUSPEND_TTL_MS + 1);
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
          fixture.advance(SUSPEND_TTL_MS);
        } else if (reason === "resumed") {
          resumeGatewaySuspend("external-lease");
        } else if (reason === "write custody") {
          fixture.mutate();
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

    it.each([true])("consumes one explicit arm without renewing it (draining: %s)", (draining) => {
      const fixture = setup(draining);
      expect(fixture.consume()).toEqual({ ok: true, value: false });
      expect(fixture.arm()).toEqual({
        ok: true,
        value: { status: "armed", suspensionId: "external-lease", expiresAtMs: 121_000 },
      });
      fixture.advance(30_000);
      expect(prepareGatewaySuspend(fixture.params)).toMatchObject({ expiresAtMs: 121_000 });
      expect(fixture.arm()).toMatchObject({ ok: true, value: { expiresAtMs: 121_000 } });
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
          fixture.advance(SUSPEND_TTL_MS);
        }
        if (change === "resume" || change === "replacement") {
          resumeGatewaySuspend("external-lease");
        }
        if (change === "replacement") {
          prepareGatewaySuspend(fixture.params);
        }
        if (change === "host") {
          fixture.replaceHost();
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

    it.each([true])(
      "refreshes final-chat custody after a lease becomes ready (draining: %s)",
      (draining) => {
        const fixture = setup(draining);
        fixture.finishWork();
        expect(getGatewaySuspendStatus("external-lease").status).toBe("ready");
        expect(fixture.arm().ok).toBe(true);
        fixture.persist();
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

        fixture.finishPersistence();
        expect(prepareGatewaySuspend(fixture.params)).toMatchObject({
          status: "ready",
          activeCount: 0,
          blockers: [],
        });
        expect(getGatewaySuspendAdmissionPhase()).toBe("prepared");
        expect(fixture.params.resumeScheduling).not.toHaveBeenCalled();
      },
    );
  });
});
