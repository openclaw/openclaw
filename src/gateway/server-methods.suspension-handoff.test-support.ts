import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import { validateGatewaySuspendStatusResult } from "../../packages/gateway-protocol/src/index.js";
import { createGatewayHostLifecycle } from "../cli/gateway-cli/host-lifecycle.js";
import {
  consumeGatewaySuspendHandoff,
  getGatewaySuspendStatus,
  markGatewaySuspendExiting,
  prepareGatewaySuspend,
  resetGatewaySuspendCoordinatorForLifecycleRestart,
  resumeGatewaySuspend,
} from "../infra/gateway-suspend-coordinator.js";
import {
  beginGatewayRootWorkAdmissionWhenOpen,
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
  tryBeginGatewayRootWorkAdmission,
} from "../process/gateway-work-admission.js";
import { runExclusiveSessionLifecycleMutation } from "../sessions/session-lifecycle-admission.js";
import { createDeferredCore } from "../shared/deferred.js";
import { getGatewayProcessInstanceId } from "./process-instance.js";
import type { handleGatewayRequest } from "./server-methods.js";
import { dispatchSuspensionRequest as dispatch } from "./server-methods.suspension-admission.test-support.js";
import { suspendHandlers } from "./server-methods/suspend.js";

function expectStatus(respond: unknown, fields: Record<string, unknown>) {
  expect(respond).toHaveBeenCalledWith(true, expect.objectContaining(fields));
}

function expectFailure(respond: unknown, fields: Record<string, unknown>) {
  expect(respond).toHaveBeenCalledWith(false, undefined, expect.objectContaining(fields));
}

function expectHandoff(host: ReturnType<typeof createGatewayHostLifecycle>, value: boolean) {
  expect(consumeGatewaySuspendHandoff(host.capability.externalRestart)).toEqual({
    ok: true,
    value,
  });
}

function createHost(options: Partial<Parameters<typeof createGatewayHostLifecycle>[0]> = {}) {
  return createGatewayHostLifecycle({
    processOwner: { ownsProcessLifecycle: true, supervisor: "external" },
    isCurrent: () => true,
    isServing: () => true,
    acceptStop: () => {},
    ...options,
  });
}

function prepare(
  requestId: string,
  options: Partial<Parameters<typeof prepareGatewaySuspend>[0]> = {},
) {
  return prepareGatewaySuspend({
    requestId,
    pauseScheduling: () => {},
    resumeScheduling: () => {},
    ...options,
  });
}

/** Register host handoff contracts under the caller's shared admission reset hooks. */
export function registerSuspensionHandoffLifecycleTests() {
  it.each(["resume", "expiry", "replacement"] as const)(
    "reports held custody immediately and observes the lease after %s",
    async (change) => {
      vi.useFakeTimers();
      const prepared = prepare("settling-writes", {
        drain: true,
        inspect: { getTerminalPersistence: () => 1 },
      });
      if (prepared.status !== "draining") {
        throw new Error("expected a draining lease");
      }
      try {
        if (change === "expiry") {
          await vi.advanceTimersByTimeAsync(40_000);
        }
        const status = async () => {
          const result = dispatch({
            method: "gateway.suspend.status",
            requestParams: { suspensionId: prepared.suspensionId },
            scope: "operator.read",
            core: true,
            handler: suspendHandlers["gateway.suspend.status"]!,
          });
          await result.request;
          return result.respond;
        };
        expectStatus(await status(), {
          status: "draining",
          activeCount: 1,
          writeCustody: [{ phase: "terminal-persistence", count: 1 }],
        });
        if (change !== "expiry") {
          resumeGatewaySuspend(prepared.suspensionId);
          if (change === "replacement") {
            prepare("replacement");
          }
        }
        if (change === "expiry") {
          await vi.advanceTimersByTimeAsync(5_000);
        }
        const current = await status();
        if (change === "replacement") {
          expectFailure(current, {
            details: expect.objectContaining({ reason: "gateway-suspension-conflict" }),
          });
        } else {
          expect(current).toHaveBeenCalledWith(true, { status: "running" });
        }
      } finally {
        resetGatewaySuspendCoordinatorForLifecycleRestart();
        vi.useRealTimers();
      }
    },
  );

  it.each(["handoff", "installation-replaced"] as const)(
    "reports held and settled custody before %s without interrupting 200 admitted requests",
    async (restart) => {
      vi.useFakeTimers();
      const roots = Array.from({ length: 200 }, () => tryBeginGatewayRootWorkAdmission());
      const writing = createDeferredCore();
      const written = createDeferredCore();
      let mutation: Promise<void> | undefined;
      const cron = {
        pauseScheduling: vi.fn(),
        resumeScheduling: vi.fn(),
        getSuspensionBlockerCount: () => 0,
      };
      const host = createHost();
      const context = {
        getRuntimeConfig: () => ({}),
        cron,
        hostLifecycle: host.capability,
        logGateway: { warn: vi.fn(), info: vi.fn() },
        chatAbortControllers: new Map(),
        chatQueuedTurns: new Map(),
      } as unknown as Parameters<typeof handleGatewayRequest>[0]["context"];
      const request = async (method: keyof typeof suspendHandlers, requestParams: unknown) => {
        const result = dispatch({
          method,
          requestParams,
          scope: "operator.admin",
          core: true,
          handler: suspendHandlers[method]!,
          context,
        });
        await result.request;
        return result.respond;
      };
      try {
        const prepared = await request("gateway.suspend.prepare", {
          requestId: "release-update",
          terminalPolicy: "terminate",
          drain: true,
        });
        expectStatus(prepared, { status: "draining", activeCount: 200 });
        const { suspensionId } = expectDefined(
          prepared.mock.calls[0],
          "suspension prepare response",
        )[1] as { suspensionId: string };
        const status = (includeLifecycle = false) =>
          request("gateway.suspend.status", {
            suspensionId,
            ...(includeLifecycle ? { includeLifecycle } : {}),
          });
        const draining = await status();
        expectStatus(draining, { status: "draining", activeCount: 200 });
        const blocked = Promise.allSettled(
          Array.from({ length: 200 }, () => beginGatewayRootWorkAdmissionWhenOpen()),
        );
        await vi.advanceTimersByTimeAsync(30_000);
        mutation = runExclusiveSessionLifecycleMutation("patch", {
          scope: "suspension-status",
          identities: ["session"],
          run: async () => {
            writing.resolve();
            await written.promise;
          },
        });
        await writing.promise;
        expectStatus(await status(), {
          status: "draining",
          activeCount: 201,
          writeCustody: [{ phase: "session-mutation", count: 1 }],
        });
        written.resolve();
        await mutation;
        expectStatus(await status(), {
          status: "draining",
          activeCount: 200,
          writeCustody: [],
        });
        if (restart === "handoff") {
          const armed = await request("gateway.suspend.handoff", {
            suspensionId,
            target: { pid: process.pid, processInstanceId: getGatewayProcessInstanceId() },
          });
          expectStatus(armed, { status: "armed" });
          expectHandoff(host, true);
        }
        await host.retire();
        markGatewayRestartDraining(
          restart === "handoff"
            ? "stop (SIGTERM)"
            : "restart (SIGUSR2: gateway.installation_replaced)",
        );
        expect((await blocked).every((result) => result.status === "rejected")).toBe(true);
        const owned = await status();
        expectStatus(owned, { status: "draining", activeCount: 200 });
        const legacy = expectDefined(owned.mock.calls[0], "legacy suspension status response")[1];
        expect(legacy).not.toHaveProperty("ownerId");
        expect(legacy).not.toHaveProperty("phase");
        const lifecycle = await status(true);
        expectStatus(lifecycle, {
          status: "draining",
          ownerId: "release-update",
          phase: "interrupting",
        });
        expect(validateGatewaySuspendStatusResult(legacy)).toBe(true);
        // Expiry cannot reopen a committed shutdown, even after all old roots settle.
        for (const root of roots) {
          root?.release();
        }
        await vi.advanceTimersByTimeAsync(120_000);
        const settled = await status(true);
        expectStatus(settled, { phase: "interrupting", activeCount: 0, status: "draining" });
        const foreign = await request("gateway.suspend.status", { suspensionId: "foreign" });
        expectFailure(foreign, {
          details: expect.objectContaining({ reason: "gateway-suspension-conflict" }),
        });
        expect(cron.resumeScheduling).not.toHaveBeenCalled();
        const resumed = await request("gateway.suspend.resume", { suspensionId });
        expectFailure(resumed, {
          code: "UNAVAILABLE",
          message: "gateway shutdown is committed",
        });
        expectHandoff(host, false);
        markGatewaySuspendExiting();
        expect(getGatewaySuspendStatus(suspensionId, true)).toMatchObject({
          status: "draining",
          ownerId: "release-update",
          phase: "exiting",
        });
        resetGatewayWorkAdmission();
        markGatewayRestartDraining();
        expect(getGatewaySuspendStatus(suspensionId)).toEqual({ status: "running" });
      } finally {
        written.resolve();
        await mutation;
        for (const root of roots) {
          root?.release();
        }
        await host.retire();
        resetGatewaySuspendCoordinatorForLifecycleRestart();
        vi.useRealTimers();
      }
    },
  );
}

export function registerSuspensionHandoffAuthorizationTests() {
  it.each([
    "armed",
    "committed",
    "unsupported-commit",
    "read-scope",
    "other-pid",
    "new-process-same-pid",
    "retired-host",
  ])("binds an external handoff to the authenticated live owner: %s", async (mode) => {
    const host = createHost({
      commitExternalStop:
        mode === "committed"
          ? () => {
              const handoff = consumeGatewaySuspendHandoff(host.capability.externalRestart);
              if (!handoff.ok || !handoff.value) {
                throw new Error("Missing current suspension handoff");
              }
              markGatewayRestartDraining("stop (SIGTERM)");
            }
          : undefined,
    });
    const lease = prepare("handoff-route", {
      drain: true,
      inspect: { getRootRequests: () => 1, getTerminalPersistence: () => 0 },
    });
    if (lease.status !== "draining") {
      throw new Error("expected a held drain");
    }
    try {
      const result = dispatch({
        method: "gateway.suspend.handoff",
        scope: "operator.admin",
        core: true,
        handler: suspendHandlers["gateway.suspend.handoff"]!,
        requestParams: {
          suspensionId: lease.suspensionId,
          ...(["committed", "unsupported-commit"].includes(mode) ? { commit: true } : {}),
          target: {
            pid: mode === "other-pid" ? process.pid + 1 : process.pid,
            processInstanceId:
              mode === "new-process-same-pid" ? "different-process" : getGatewayProcessInstanceId(),
          },
        },
        clientScopes: [mode === "read-scope" ? "operator.read" : "operator.admin"],
        context: {
          getRuntimeConfig: () => ({}),
          hostLifecycle: host.capability,
          logGateway: { warn: vi.fn() },
        } as unknown as Parameters<typeof handleGatewayRequest>[0]["context"],
      });
      // The request has crossed an async dispatch boundary, but the original
      // host must still own its iteration when the synchronous handler commits.
      if (mode === "retired-host") {
        await host.retire();
      }
      await result.request;
      if (mode === "armed" || mode === "committed") {
        expect(result.respond).toHaveBeenCalledWith(true, {
          status: mode,
          suspensionId: lease.suspensionId,
          expiresAtMs: lease.expiresAtMs,
        });
      }
      if (mode === "committed") {
        expect(resumeGatewaySuspend(lease.suspensionId)).toEqual({
          ok: false,
          reason: "gateway-restarting",
        });
      } else if (mode !== "armed") {
        expect(result.respond).toHaveBeenCalledWith(false, undefined, expect.any(Object));
      }
      expectHandoff(host, mode === "armed");
    } finally {
      await host.retire();
      resumeGatewaySuspend(lease.suspensionId);
    }
  });
}
