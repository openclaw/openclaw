// Covers external restart handoff authority, expiry, and final-write custody.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { resetProcessRegistryForTests } from "../agents/bash-process-registry.test-support.js";
import { createGatewayHostLifecycle } from "../cli/gateway-cli/host-lifecycle.js";
import { getGatewayProcessInstanceId } from "../gateway/process-instance.js";
import { suspendHandlers } from "../gateway/server-methods/suspend.js";
import type { GatewayReaderRequest } from "../gateway/server-public.js";
import { createGatewayRequestContext } from "../gateway/server-request-context.js";
import { makeContextParams } from "../gateway/server-request-context.test-support.js";
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
  prepareGatewaySuspendedReader,
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
  it("denies the ended requester response while its accepted native reader join finishes", async () => {
    await prepareGatewaySuspend({
      requestId: "reader-response",
      drain: true,
      terminalPolicy: "terminate",
      pauseScheduling: vi.fn(),
      resumeScheduling: vi.fn(),
      createSuspensionId: () => "reader-response-lease",
      inspect: inspectors(),
    });
    const entered = createDeferred();
    const joined = createDeferred();
    const response = createDeferred();
    let callerCurrent = true;
    let nativeFinished = false;
    const target = { pid: process.pid, processInstanceId: getGatewayProcessInstanceId() };
    const expiresAtMs = Date.now() + 30_000;
    const context = createGatewayRequestContext(makeContextParams());
    const host = createGatewayHostLifecycle({
      isCurrent: () => true,
      isServing: () => true,
      acceptStop: () => {},
      processOwner: { ownsProcessLifecycle: true, supervisor: null },
      prepareReader: async (_request, assertCurrent) => {
        assertCurrent();
        entered.resolve();
        await joined.promise;
        assertCurrent();
        nativeFinished = true;
        return {
          version: 1,
          status: "reader-ready",
          ...target,
          bootId: "response-boot",
          frozenSourceGeneration: "response-generation",
          retiredAtMs: Date.now(),
          expiresAtMs,
        };
      },
    });
    context.hostLifecycle = host.capability;
    const respond = vi.fn(() => response.resolve());
    const handler = suspendHandlers["gateway.suspend.reader"]!;
    await handler({
      req: { type: "req", id: "reader-response-request", method: "gateway.suspend.reader" },
      params: { suspensionId: "reader-response-lease", target, expiresAtMs },
      context,
      client: null,
      respond,
      isWebchatConnect: () => false,
      hasCurrentClientAuthority: () => callerCurrent,
    });
    await entered.promise;
    callerCurrent = false;
    joined.resolve();
    await response.promise;
    expect(nativeFinished).toBe(true);
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "UNAVAILABLE" }),
    );
    await host.retire();
  });
  it("finishes accepted reader custody after the initiating request ends without renewing its owner or deadline", async () => {
    await prepareGatewaySuspend({
      requestId: "reader-request-lifetime",
      drain: true,
      terminalPolicy: "terminate",
      pauseScheduling: vi.fn(),
      resumeScheduling: vi.fn(),
      createSuspensionId: () => "reader-request-lease",
      inspect: inspectors(),
    });
    let requestCurrent = true;
    const entered = createDeferred();
    const joined = createDeferred();
    const expiresAtMs = Date.now() + 30_000;
    const target = { pid: process.pid, processInstanceId: "reader-request-instance" };
    const receipt = {
      version: 1 as const,
      status: "reader-ready" as const,
      ...target,
      bootId: "reader-request-boot",
      frozenSourceGeneration: "reader-request-generation",
      retiredAtMs: Date.now(),
      expiresAtMs,
    };
    const owner = {
      isCurrent: () => true,
      prepareReader: vi.fn(async (_request: GatewayReaderRequest, assertCurrent: () => void) => {
        assertCurrent();
        entered.resolve();
        await joined.promise;
        assertCurrent();
        return receipt;
      }),
    };
    const pending = prepareGatewaySuspendedReader({
      suspensionId: "reader-request-lease",
      request: { target, expiresAtMs },
      owner,
      assertCurrent: () => {
        if (!requestCurrent) {
          throw new Error("Request lifetime ended");
        }
      },
    });
    await entered.promise;
    requestCurrent = false;
    joined.resolve();
    await expect(pending).resolves.toEqual(receipt);
    expect(owner.prepareReader).toHaveBeenCalledOnce();
    await expect(
      prepareGatewaySuspendedReader({
        suspensionId: "reader-request-lease",
        request: { target, expiresAtMs },
        owner,
        assertCurrent: () => {
          throw new Error("Requester response is unauthorized");
        },
      }),
    ).rejects.toThrow("Requester response is unauthorized");
    await expect(
      prepareGatewaySuspendedReader({
        suspensionId: "reader-request-lease",
        request: { target, expiresAtMs },
        owner,
        assertCurrent: () => {},
      }),
    ).resolves.toEqual(receipt);
    expect(owner.prepareReader).toHaveBeenCalledOnce();
    expect(resumeGatewaySuspend("reader-request-lease")).toEqual({
      ok: false,
      reason: "gateway-restarting",
    });
  });
  it.each(["initial refusal", "owner loss", "deadline", "native failure"] as const)(
    "keeps reader admission and custody fenced after %s",
    async (failure) => {
      await prepareGatewaySuspend({
        requestId: "reader-denial",
        drain: true,
        terminalPolicy: "terminate",
        pauseScheduling: vi.fn(),
        resumeScheduling: vi.fn(),
        createSuspensionId: () => "reader-denial-lease",
        inspect: inspectors(),
      });
      const entered = createDeferred();
      const joined = createDeferred();
      let ownerCurrent = true;
      const expiresAtMs = Date.now() + 30_000;
      const target = { pid: process.pid, processInstanceId: "reader-denial-instance" };
      const nativeFailure = new Error("Native writer did not join");
      const owner = {
        isCurrent: () => ownerCurrent,
        prepareReader: vi.fn(async (_request: GatewayReaderRequest, assertCurrent: () => void) => {
          assertCurrent();
          entered.resolve();
          await joined.promise;
          assertCurrent();
          if (failure === "native failure") {
            throw nativeFailure;
          }
          return {
            version: 1 as const,
            status: "reader-ready" as const,
            ...target,
            bootId: "reader-denial-boot",
            frozenSourceGeneration: "reader-denial-generation",
            retiredAtMs: Date.now(),
            expiresAtMs,
          };
        }),
      };
      const params = {
        suspensionId: "reader-denial-lease",
        request: { target, expiresAtMs },
        owner,
        assertCurrent: () => {
          if (failure === "initial refusal") {
            throw new Error("No admission authority");
          }
        },
      };
      const pending = prepareGatewaySuspendedReader(params);
      if (failure === "initial refusal") {
        await expect(pending).rejects.toThrow("No admission authority");
        expect(owner.prepareReader).not.toHaveBeenCalled();
        return;
      }
      await entered.promise;
      const clock =
        failure === "deadline" ? vi.spyOn(Date, "now").mockReturnValue(expiresAtMs) : undefined;
      try {
        if (failure === "owner loss") {
          ownerCurrent = false;
        }
        joined.resolve();
        await expect(pending).rejects.toThrow(
          failure === "native failure" ? nativeFailure.message : "custody is no longer current",
        );
        await expect(
          prepareGatewaySuspendedReader({ ...params, assertCurrent: () => {} }),
        ).rejects.toThrow();
        expect(owner.prepareReader).toHaveBeenCalledOnce();
        expect(resumeGatewaySuspend(params.suspensionId)).toEqual({
          ok: false,
          reason: "gateway-restarting",
        });
      } finally {
        clock?.mockRestore();
        joined.resolve();
      }
    },
  );
  it("reports captured reader custody without calling retired application inspectors", async () => {
    let retired = false;
    const inspectWork = vi.fn(() => {
      if (retired) {
        throw new Error("synthetic retired work inspector");
      }
      return 0;
    });
    await prepareGatewaySuspend({
      requestId: "reader-status",
      drain: true,
      terminalPolicy: "terminate",
      pauseScheduling: vi.fn(),
      resumeScheduling: vi.fn(),
      createSuspensionId: () => "reader-status-lease",
      inspect: inspectors({ getSessionMutations: inspectWork }),
    });
    const target = { pid: process.pid, processInstanceId: "reader-status-instance" };
    const expiresAtMs = Date.now() + 30_000;
    await prepareGatewaySuspendedReader({
      suspensionId: "reader-status-lease",
      request: { target, expiresAtMs },
      assertCurrent: () => {},
      owner: {
        isCurrent: () => true,
        prepareReader: async () => {
          retired = true;
          return {
            version: 1,
            status: "reader-ready",
            ...target,
            expiresAtMs,
            bootId: "reader-status-boot",
            frozenSourceGeneration: "reader-status-generation",
            retiredAtMs: Date.now(),
          };
        },
      },
    });
    const inspected = inspectWork.mock.calls.length;
    expect(getGatewaySuspendStatus("reader-status-lease")).toMatchObject({
      status: "ready",
      expiresAtMs,
    });
    expect(inspectWork).toHaveBeenCalledTimes(inspected);
  });

  describe("external restart handoff", () => {
    const setup = async (draining: boolean) => {
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

    it.each([false, true])(
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
