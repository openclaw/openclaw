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
import { getGatewayProcessInstanceId } from "./process-instance.js";
import type { handleGatewayRequest } from "./server-methods.js";
import { dispatchSuspensionRequest as dispatch } from "./server-methods.suspension-admission.test-support.js";
import { suspendHandlers } from "./server-methods/suspend.js";

/** Register host handoff contracts under the caller's shared admission reset hooks. */
export function registerSuspensionHandoffLifecycleTests() {
  it.each(["handoff", "installation-replaced"] as const)(
    "keeps owned status through %s with 200 blocked admissions",
    async (restart) => {
      vi.useFakeTimers();
      const roots = Array.from({ length: 200 }, () => tryBeginGatewayRootWorkAdmission());
      const cron = {
        pauseScheduling: vi.fn(),
        resumeScheduling: vi.fn(),
        getSuspensionBlockerCount: () => 0,
      };
      const host = createGatewayHostLifecycle({
        processOwner: { ownsProcessLifecycle: true, supervisor: "external" },
        isCurrent: () => true,
        isServing: () => true,
        acceptStop: () => {},
      });
      const context = {
        cron,
        hostLifecycle: host.capability,
        logGateway: { warn: vi.fn() },
        chatAbortControllers: new Map(),
        chatQueuedTurns: new Map(),
      } as unknown as Parameters<typeof handleGatewayRequest>[0]["context"];
      const rpc = async (method: keyof typeof suspendHandlers, requestParams: unknown) => {
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
        const prepared = await rpc("gateway.suspend.prepare", {
          requestId: "release-update",
          terminalPolicy: "terminate",
          drain: true,
        });
        expect(prepared).toHaveBeenCalledWith(
          true,
          expect.objectContaining({ status: "draining", activeCount: 200 }),
        );
        const { suspensionId } = expectDefined(
          prepared.mock.calls[0],
          "suspension prepare response",
        )[1] as { suspensionId: string };
        const draining = await rpc("gateway.suspend.status", { suspensionId });
        expect(draining).toHaveBeenCalledWith(
          true,
          expect.objectContaining({ status: "draining", activeCount: 200 }),
        );
        const blocked = Promise.allSettled(
          Array.from({ length: 200 }, () => beginGatewayRootWorkAdmissionWhenOpen()),
        );
        await vi.advanceTimersByTimeAsync(30_000);
        if (restart === "handoff") {
          const armed = await rpc("gateway.suspend.handoff", {
            suspensionId,
            target: { pid: process.pid, processInstanceId: getGatewayProcessInstanceId() },
          });
          expect(armed).toHaveBeenCalledWith(true, expect.objectContaining({ status: "armed" }));
          expect(consumeGatewaySuspendHandoff(host.capability.externalRestart)).toEqual({
            ok: true,
            value: true,
          });
        }
        await host.retire();
        markGatewayRestartDraining(
          restart === "handoff"
            ? "stop (SIGTERM)"
            : "restart (SIGUSR2: gateway.installation_replaced)",
        );
        expect((await blocked).every((result) => result.status === "rejected")).toBe(true);
        const owned = await rpc("gateway.suspend.status", { suspensionId });
        expect(owned).toHaveBeenCalledWith(
          true,
          expect.objectContaining({
            status: "draining",
            activeCount: 200,
          }),
        );
        const legacy = expectDefined(owned.mock.calls[0], "legacy suspension status response")[1];
        expect(legacy).not.toHaveProperty("ownerId");
        expect(legacy).not.toHaveProperty("phase");
        const lifecycle = await rpc("gateway.suspend.status", {
          suspensionId,
          includeLifecycle: true,
        });
        expect(lifecycle).toHaveBeenCalledWith(
          true,
          expect.objectContaining({
            status: "draining",
            ownerId: "release-update",
            phase: "interrupting",
          }),
        );
        expect(
          validateGatewaySuspendStatusResult(
            expectDefined(owned.mock.calls[0], "owned suspension status response")[1],
          ),
        ).toBe(true);
        // Expiry cannot reopen a committed shutdown, even after all old roots settle.
        for (const root of roots) {
          root?.release();
        }
        await vi.advanceTimersByTimeAsync(120_000);
        const settled = await rpc("gateway.suspend.status", {
          suspensionId,
          includeLifecycle: true,
        });
        expect(settled).toHaveBeenCalledWith(
          true,
          expect.objectContaining({ phase: "interrupting", activeCount: 0, status: "draining" }),
        );
        const foreign = await rpc("gateway.suspend.status", { suspensionId: "foreign" });
        expect(foreign).toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({
            details: expect.objectContaining({ reason: "gateway-suspension-conflict" }),
          }),
        );
        expect(cron.resumeScheduling).not.toHaveBeenCalled();
        const resumed = await rpc("gateway.suspend.resume", { suspensionId });
        expect(resumed).toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({
            code: "UNAVAILABLE",
            message: "gateway shutdown is committed",
          }),
        );
        expect(consumeGatewaySuspendHandoff(host.capability.externalRestart)).toEqual({
          ok: true,
          value: false,
        });
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
    const host = createGatewayHostLifecycle({
      processOwner: { ownsProcessLifecycle: true, supervisor: "external" },
      isCurrent: () => true,
      isServing: () => true,
      acceptStop: () => {},
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
    const lease = prepareGatewaySuspend({
      requestId: "handoff-route",
      drain: true,
      pauseScheduling: () => {},
      resumeScheduling: () => {},
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
        clientScopes: [mode === "read-scope" ? "operator.read" : "operator.admin"],
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
        context: {
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
      if (mode === "armed") {
        expect(result.respond).toHaveBeenCalledWith(true, {
          status: "armed",
          suspensionId: lease.suspensionId,
          expiresAtMs: lease.expiresAtMs,
        });
        expect(consumeGatewaySuspendHandoff(host.capability.externalRestart)).toEqual({
          ok: true,
          value: true,
        });
      } else if (mode === "committed") {
        expect(result.respond).toHaveBeenCalledWith(true, {
          status: "committed",
          suspensionId: lease.suspensionId,
          expiresAtMs: lease.expiresAtMs,
        });
        expect(resumeGatewaySuspend(lease.suspensionId)).toEqual({
          ok: false,
          reason: "gateway-restarting",
        });
        expect(consumeGatewaySuspendHandoff(host.capability.externalRestart)).toEqual({
          ok: true,
          value: false,
        });
      } else {
        expect(result.respond).toHaveBeenCalledWith(false, undefined, expect.any(Object));
        expect(consumeGatewaySuspendHandoff(host.capability.externalRestart)).toEqual({
          ok: true,
          value: false,
        });
      }
    } finally {
      await host.retire();
      resumeGatewaySuspend(lease.suspensionId);
    }
  });
}
