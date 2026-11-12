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
import type { GatewayActiveWorkInspectors } from "./gateway-active-work.js";
import {
  armGatewaySuspendHandoff,
  consumeGatewaySuspendHandoff,
  disarmGatewaySuspendHandoff,
  getGatewaySuspendStatus,
  prepareGatewaySuspend,
  requestGatewaySuspendHandoff,
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
  vi.useRealTimers();
});

describe("gateway suspend coordinator", () => {
  describe("external restart handoff", () => {
    const setup = (draining: boolean, drain = true) => {
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
      const inspect: Partial<GatewayActiveWorkInspectors> = inspectors({
        getRootRequests: () => work,
        getTerminalPersistence: () => pending,
        getSessionMutations: () => mutations,
      });
      const params = {
        requestId: "external-host",
        drain,
        pauseScheduling: vi.fn(),
        resumeScheduling: vi.fn(),
        inspect,
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

    it("keeps idle handoff immediate without starting a polling timer", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance", "Date"] });
      const fixture = setup(false);
      const timers = vi.getTimerCount();
      await expect(
        requestGatewaySuspendHandoff({
          suspensionId: "external-lease",
          owner: fixture.owner,
          assertCurrent: vi.fn(),
        }),
      ).resolves.toMatchObject({ ok: true, value: { status: "armed" } });
      expect(vi.getTimerCount()).toBe(timers);
    });

    it("commits terminal persistence settling at 24 seconds", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance", "Date"] });
      const fixture = setup(true);
      fixture.persist();
      const request = requestGatewaySuspendHandoff({
        suspensionId: "external-lease",
        owner: fixture.owner,
        commit: true,
        assertCurrent: vi.fn(),
      });
      await vi.advanceTimersByTimeAsync(23_750);
      expect(fixture.commitStop).not.toHaveBeenCalled();
      fixture.finishPersistence();
      await vi.advanceTimersByTimeAsync(250);
      await expect(request).resolves.toMatchObject({ ok: true, value: { status: "committed" } });
      expect(fixture.commitStop).toHaveBeenCalledOnce();
    });

    it("refuses at 25 seconds even while the 120-second lease keeps renewing", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance", "Date"] });
      const fixture = setup(true);
      fixture.persist();
      let settled = false;
      const request = requestGatewaySuspendHandoff({
        suspensionId: "external-lease",
        owner: fixture.owner,
        commit: true,
        assertCurrent: vi.fn(),
      }).then((result) => {
        settled = true;
        return result;
      });
      for (let renewal = 0; renewal < 4; renewal++) {
        await vi.advanceTimersByTimeAsync(5_000);
        fixture.advance(5_000);
        expect(prepareGatewaySuspend(fixture.params)).toMatchObject({
          expiresAtMs: 121_000 + (renewal + 1) * 5_000,
        });
      }
      await vi.advanceTimersByTimeAsync(4_999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(request).resolves.toMatchObject({
        ok: false,
        error: { details: { terminalPersistence: { count: 1 } } },
      });
      expect(fixture.commitStop).not.toHaveBeenCalled();
    });

    it.each(["wall", "monotonic"] as const)(
      "never waits past shorter %s lease expiry",
      async (clock) => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance", "Date"] });
        const fixture = setup(true);
        if (clock === "wall") {
          fixture.advance(119_000);
        } else {
          await vi.advanceTimersByTimeAsync(119_000);
        }
        fixture.persist();
        const request = requestGatewaySuspendHandoff({
          suspensionId: "external-lease",
          owner: fixture.owner,
          commit: true,
          assertCurrent: vi.fn(),
        });
        if (clock === "wall") {
          fixture.advance(1_000);
        }
        await vi.advanceTimersByTimeAsync(1_000);
        await expect(request).resolves.toMatchObject({ ok: false });
        expect(fixture.commitStop).not.toHaveBeenCalled();
      },
    );

    it.each(["host", "replacement", "recovering", "revoked", "cancelled"] as const)(
      "does not inspect or stop under changed %s ownership after await",
      async (change) => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance", "Date"] });
        const fixture = setup(true);
        fixture.persist();
        let authorized = true;
        const controller = new AbortController();
        const inspect = vi.spyOn(fixture.params.inspect, "getTerminalPersistence");
        const request = requestGatewaySuspendHandoff({
          suspensionId: "external-lease",
          owner: fixture.owner,
          commit: true,
          signal: controller.signal,
          assertCurrent: () => {
            if (!authorized) {
              throw new Error("revoked");
            }
          },
        }).catch((error: unknown) => error);
        const inspections = inspect.mock.calls.length;
        if (change === "host") {
          fixture.replaceHost();
        } else if (change === "replacement") {
          resumeGatewaySuspend("external-lease");
          prepareGatewaySuspend(fixture.params);
        } else if (change === "recovering") {
          fixture.params.resumeScheduling.mockImplementation(() => {
            throw new Error("resume failed");
          });
          expect(resumeGatewaySuspend("external-lease")).toMatchObject({
            reason: "scheduler-resume-failed",
          });
        } else if (change === "revoked") {
          authorized = false;
        } else {
          controller.abort();
        }
        // Replacement preparation may inspect, but the stale waiting request must not.
        const beforeWake = inspect.mock.calls.length;
        await vi.advanceTimersByTimeAsync(250);
        const result = await request;
        if (change === "revoked" || change === "cancelled") {
          expect(result).toBeInstanceOf(Error);
        } else {
          expect(result).toMatchObject({ ok: false });
        }
        expect(inspect.mock.calls.length).toBe(beforeWake);
        expect(inspections).toBeGreaterThan(0);
        expect(fixture.commitStop).not.toHaveBeenCalled();
      },
    );

    it("rechecks commit-time write custody after terminal settlement", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance", "Date"] });
      const fixture = setup(true);
      fixture.persist();
      const request = requestGatewaySuspendHandoff({
        suspensionId: "external-lease",
        owner: fixture.owner,
        commit: true,
        assertCurrent: vi.fn(),
      });
      fixture.finishPersistence();
      fixture.mutate();
      await vi.advanceTimersByTimeAsync(250);
      await expect(request).resolves.toMatchObject({
        ok: false,
        error: { message: "gateway write custody is still pending" },
      });
      expect(fixture.commitStop).not.toHaveBeenCalled();
    });

    it("refuses another armed host immediately even with new pending terminal writes", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance", "Date"] });
      const fixture = setup(true);
      expect(fixture.arm().ok).toBe(true);
      fixture.persist();
      const timers = vi.getTimerCount();
      await expect(
        requestGatewaySuspendHandoff({
          suspensionId: "external-lease",
          owner: { isCurrent: () => true },
          assertCurrent: vi.fn(),
        }),
      ).resolves.toMatchObject({
        ok: false,
        error: { message: "gateway suspension already belongs to another host iteration" },
      });
      expect(vi.getTimerCount()).toBe(timers);
    });

    it.each(["freeze", "inspector", "custody", "unsupported", "uncertain"] as const)(
      "does not turn immediate %s refusal into a wait or stop retry",
      async (reason) => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance", "Date"] });
        const fixture = setup(false, reason !== "freeze");
        if (reason === "freeze") {
          fixture.persist();
        } else if (reason === "inspector") {
          delete fixture.params.inspect.getTerminalPersistence;
        } else if (reason === "custody") {
          fixture.mutate();
        } else if (reason === "unsupported") {
          delete fixture.owner.commitStop;
        } else {
          fixture.commitStop.mockImplementation(() => {
            throw new Error("uncertain stop");
          });
        }
        const timers = vi.getTimerCount();
        await expect(
          requestGatewaySuspendHandoff({
            suspensionId: "external-lease",
            owner: fixture.owner,
            commit: true,
            assertCurrent: vi.fn(),
          }),
        ).resolves.toMatchObject({ ok: false });
        expect(vi.getTimerCount()).toBe(timers);
        expect(fixture.commitStop).toHaveBeenCalledTimes(reason === "uncertain" ? 1 : 0);
      },
    );

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
          error: expect.stringContaining("gateway terminal persistence is still pending"),
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
