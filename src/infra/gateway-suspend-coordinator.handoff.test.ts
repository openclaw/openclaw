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
      let current = true;
      const owner = { isCurrent: () => current };
      const params = {
        requestId: "external-host",
        drain: true,
        pauseScheduling: vi.fn(),
        resumeScheduling: vi.fn(),
        inspect: inspectors({ getRootRequests: () => work, getTerminalPersistence: () => pending }),
        nowMs: () => now,
        createSuspensionId: () => "external-lease",
      };
      expect(prepareGatewaySuspend(params).status).toBe(draining ? "draining" : "ready");
      return {
        owner,
        params,
        arm: () =>
          armGatewaySuspendHandoff({
            suspensionId: "external-lease",
            owner,
          }),
        consume: () => consumeGatewaySuspendHandoff(owner),
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

    it.each([false, true])(
      "consumes one explicit arm without renewing it (draining: %s)",
      (draining) => {
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
      },
    );

    it.each(["expiry", "resume", "replacement", "host", "restart", "disarm", "persistence"])(
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
        if (change === "persistence") {
          fixture.persist();
        }
        expect(fixture.consume()).not.toEqual({ ok: true, value: true });
        expect(fixture.consume()).toEqual({ ok: true, value: false });
      },
    );

    it.each([false, true])(
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
