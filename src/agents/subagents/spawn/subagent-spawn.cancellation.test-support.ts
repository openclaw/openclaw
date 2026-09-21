import { expectDefined } from "@openclaw/normalization-core";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { it, expect, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { OpenClawConfig } from "../../../config/config.js";
import type { CallGatewayOptions } from "../../../gateway/call.js";
import type { createGatewayInstanceRuntime } from "../../../gateway/server-instance-runtime.js";
import type { GatewayRequestContext } from "../../../gateway/server-methods/types.js";
import { dispatchGatewayMethodInProcess } from "../../../gateway/server-plugin-in-process-dispatch.js";
import { createSyntheticPluginRuntimeClient } from "../../../gateway/server-plugin-runtime-client.js";
import { createHookRunner } from "../../../plugins/hooks.js";
import { createPluginRecord } from "../../../plugins/loader-records.js";
import { createRuntimeTestRegistry } from "../../../plugins/registry-runtime.test-helpers.js";
import { setActivePluginRegistry } from "../../../plugins/runtime.js";
import { createPluginRuntime } from "../../../plugins/runtime/index.js";
import { createPluginSubagentRequesterContext } from "../../../plugins/runtime/subagent-requester-context.js";
import {
  beginSessionWorkAdmission,
  SESSION_WORK_ADMISSION_DRAIN_TIMEOUT_MS,
  startSessionWorkAdmissionInterruption,
  type SessionWorkAdmissionLease,
} from "../../../sessions/session-lifecycle-admission.js";
import { getDetachedTaskLifecycleRuntime } from "../../../tasks/detached-task-runtime.js";
import {
  setDetachedTaskLifecycleRuntime,
  resetDetachedTaskLifecycleRuntimeForTests,
} from "../../../tasks/detached-task-runtime.test-support.js";
import { findTaskByRunId, getTaskById } from "../../../tasks/runtime-internal.js";
import { onTaskRegistryChange } from "../../../tasks/task-registry.store.js";
import { createAgentRunDirectAbortError } from "../../run-termination.js";
import { createSubagentsTool } from "../../tools/subagents-tool.js";
import { subagentRuns } from "../registry/subagent-registry-memory.js";
import {
  registerSubagentRun,
  testing as registryTesting,
} from "../registry/subagent-registry.test-helpers.js";

type GatewayRuntime = ReturnType<typeof createGatewayInstanceRuntime>;

export function registerNativeCancellationCases<
  Bound extends { cfg: OpenClawConfig; context: unknown; storePath: string },
>(options: {
  createBoundParent: () => Promise<Bound>;
  createBoundGateway: (bound: Bound) => Promise<{ runtime: GatewayRuntime }>;
  closeBoundGateway: (
    bound: Bound,
    runtime: GatewayRuntime,
    childRunId?: string,
  ) => Promise<unknown[]>;
  throwBoundFailures: (failures: unknown[]) => void;
  parentSessionKey: string;
  parentRunId: string;
  assertNoModelExecution: () => void;
}) {
  const {
    createBoundParent,
    createBoundGateway,
    closeBoundGateway,
    throwBoundFailures,
    parentSessionKey,
    parentRunId,
    assertNoModelExecution,
  } = options;
  it.each([
    "before interruption",
    "after interruption",
    "already interrupted",
    "blocked drain",
  ] as const)("separates native stop acceptance from caller revocation %s", async (transition) => {
    const bound = await createBoundParent();
    const { createGatewaySubagentRuntime } =
      await import("../../../gateway/server-plugin-subagent-runtime.js");
    const context = bound.context as unknown as GatewayRequestContext;
    context.resolveGatewayContext = () => context;
    const plugins = createRuntimeTestRegistry(
      createPluginRuntime({
        subagent: createGatewaySubagentRuntime(() => context),
        allowGatewaySubagentBinding: true,
      }),
    );
    const plugin = createPluginRecord({
      id: "native-cancellation-producer",
      source: "native-cancellation-producer.test.ts",
      origin: "bundled",
      enabled: true,
      configSchema: false,
    });
    const api = plugins.createApi(plugin, { config: bound.cfg });
    setActivePluginRegistry(plugins.registry);
    const { runtime } = await createBoundGateway(bound);
    const requester = "agent:main:telegram:direct:native-cancellation";
    const nextRunId = "native-cancellation-ancestor-next";
    const targetKey = "agent:main:subagent:native-cancellation-target";
    const targetRunId = "native-cancellation-target";
    const releaseTerminal = createDeferred();
    const terminalReady = createDeferred<unknown>();
    const entered = createDeferred();
    const releaseCancellation = createDeferred();
    const waitCleanup = new AbortController();
    const waitFacade = await runtime.createAgentTurnFacade({
      client: createSyntheticPluginRuntimeClient({ operatorRoleActor: { kind: "system" } }),
    });
    registryTesting.setDepsForTest({
      callGateway: async <T>(request: CallGatewayOptions): Promise<T> => {
        const params = asOptionalRecord(request.params);
        if (request.method !== "agent.wait" || typeof params?.runId !== "string") {
          throw new Error("Unexpected native cancellation fixture request");
        }
        const response = await waitFacade.wait<T>(
          {
            runId: params.runId,
            timeoutMs: typeof params.timeoutMs === "number" ? params.timeoutMs : undefined,
          },
          request.timeoutMs ?? undefined,
          waitCleanup.signal,
        );
        if (params.runId === targetRunId) {
          terminalReady.resolve(response);
          await releaseTerminal.promise;
        }
        return response;
      },
    });
    registerSubagentRun({
      runId: parentRunId,
      childSessionKey: parentSessionKey,
      requesterSessionKey: requester,
      controllerSessionKey: requester,
      requesterDisplayKey: requester,
      task: "Own the selected native task",
      cleanup: "keep",
      expectsCompletionMessage: false,
    });
    const ancestor = subagentRuns.get(parentRunId)!;
    api.on("before_dispatch", async () => {
      await api.runtime.subagent.run({
        sessionKey: parentSessionKey,
        message: "Continue the ancestor session",
        completionDelivery: "current-requester",
        idempotencyKey: nextRunId,
        disableTools: true,
      });
      return { handled: true };
    });
    const requesterContext = expectDefined(
      createPluginSubagentRequesterContext({
        sessionKey: requester,
        origin: { channel: "telegram", to: "telegram:native-cancellation" },
      }),
      "native cancellation requester",
    );
    const hookRunner = createHookRunner(plugins.registry, { catchErrors: false });
    const failures: unknown[] = [];
    let pending: ReturnType<ReturnType<typeof createSubagentsTool>["execute"]> | undefined;
    let blockedAdmission: SessionWorkAdmissionLease | undefined;
    let stopObserving: (() => void) | undefined;
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      await dispatchGatewayMethodInProcess(
        "agent",
        {
          sessionKey: targetKey,
          message: "Wait for native cancellation",
          idempotencyKey: targetRunId,
        },
        {
          resolveGatewayContext: () => context,
          agentRunTracking: "native_subagent",
          operatorRoleActor: { kind: "system" },
        },
      );
      registerSubagentRun({
        runId: targetRunId,
        childSessionKey: targetKey,
        requesterSessionKey: parentSessionKey,
        controllerSessionKey: parentSessionKey,
        requesterDisplayKey: parentSessionKey,
        task: "Selected native task",
        cleanup: "keep",
        expectsCompletionMessage: false,
      });
      const task = expectDefined(findTaskByRunId(targetRunId), "selected task");
      const target = expectDefined(context.chatAbortControllers.get(targetRunId), "target run");
      const onAbort = vi.fn(() => entered.resolve());
      target.controller.signal.addEventListener("abort", onAbort, { once: true });
      if (transition === "blocked drain") {
        blockedAdmission = await beginSessionWorkAdmission({
          scope: bound.storePath,
          identities: [targetKey, target.sessionId],
          assertAllowed: () => {},
        });
      }
      if (transition === "already interrupted") {
        startSessionWorkAdmissionInterruption({
          scope: bound.storePath,
          identities: [targetKey, target.sessionId],
          reason: createAgentRunDirectAbortError(),
        });
      }
      if (transition === "before interruption") {
        const taskRuntime = getDetachedTaskLifecycleRuntime();
        setDetachedTaskLifecycleRuntime({
          ...taskRuntime,
          cancelDetachedTaskRunById: async (params) => {
            entered.resolve();
            await releaseCancellation.promise;
            return taskRuntime.cancelDetachedTaskRunById(params);
          },
        });
      }
      const tool = createSubagentsTool({ config: bound.cfg, agentSessionKey: requester });
      pending = tool.execute("native-cancel", { action: "cancel", taskId: task.taskId });
      await entered.promise;
      if (transition === "already interrupted") {
        let cancellationSettled = false;
        void pending.then(
          () => {
            cancellationSettled = true;
          },
          () => {
            cancellationSettled = true;
          },
        );
        while (!subagentRuns.get(targetRunId)?.killIntent) {
          if (cancellationSettled) {
            throw new Error("Cancellation returned before admission interruption");
          }
          await new Promise<void>((resolve) => {
            setImmediate(resolve);
          });
        }
      }
      await vi.advanceTimersByTimeAsync(1);
      if (transition !== "blocked drain") {
        await hookRunner.runBeforeDispatch(
          { content: "Change ancestor control" },
          { sessionKey: requester },
          requesterContext,
        );
        const replacement = expectDefined(subagentRuns.get(nextRunId), "new ancestor");
        expect(replacement.generation).toBeGreaterThan(ancestor.generation!);
        expect(replacement).toMatchObject({
          controllerSessionKey: "agent:main:main",
          requesterSessionKey: requester,
        });
      }
      expect(getTaskById(task.taskId)).toMatchObject({
        taskId: task.taskId,
        runId: task.runId,
        childSessionKey: task.childSessionKey,
        ownerKey: task.ownerKey,
        detail: task.detail,
      });
      const accepted = transition === "after interruption";
      const interrupted = transition !== "before interruption";
      if (interrupted) {
        await vi.advanceTimersByTimeAsync(9);
        expect(await terminalReady.promise).toMatchObject({
          stopReason: "rpc",
          timeoutPhase: "queue",
          providerStarted: false,
        });
      }
      releaseCancellation.resolve();
      if (transition === "blocked drain") {
        const originalClaim = expectDefined(
          subagentRuns.get(targetRunId)?.killIntent,
          "accepted native kill claim",
        );
        expect(target.controller.signal.aborted).toBe(true);
        expect(onAbort).toHaveBeenCalledOnce();
        await vi.advanceTimersByTimeAsync(SESSION_WORK_ADMISSION_DRAIN_TIMEOUT_MS);
        const cancellation = await pending;
        expect(subagentRuns.get(targetRunId)?.killIntent).toBe(originalClaim);
        expect(cancellation.details).toMatchObject({
          status: "error",
          cancelled: false,
          reason: expect.stringContaining("cleanup is pending"),
        });
        expect(blockedAdmission?.isActive()).toBe(true);
        expect(getTaskById(task.taskId)?.status).toBe("running");
        const settled = createDeferred();
        stopObserving = onTaskRegistryChange(() => {
          if (getTaskById(task.taskId)?.status === "cancelled") {
            settled.resolve();
          }
        });
        blockedAdmission?.release();
        releaseTerminal.resolve();
        await settled.promise;
        expect(getTaskById(task.taskId)?.status).toBe("cancelled");
        expect(subagentRuns.get(targetRunId)?.killIntent).toBeUndefined();
        expect(subagentRuns.get(targetRunId)?.killReconciliation).toMatchObject({
          killedAt: originalClaim.requestedAt,
          taskCancellationAccepted: true,
        });
        assertNoModelExecution();
      } else {
        expect((await pending).details).toMatchObject({ cancelled: accepted });
        expect(target.controller.signal.aborted).toBe(interrupted);
        expect(onAbort).toHaveBeenCalledTimes(Number(interrupted));
        expect(getTaskById(task.taskId)?.status).toBe(accepted ? "cancelled" : "running");
        expect(subagentRuns.get(targetRunId)?.killIntent).toBeUndefined();
        assertNoModelExecution();
        releaseTerminal.resolve();
      }
    } catch (error) {
      failures.push(error);
    } finally {
      stopObserving?.();
      blockedAdmission?.release();
      releaseCancellation.resolve();
      releaseTerminal.resolve();
      for (const entry of context.chatAbortControllers.values()) {
        entry.controller.abort(new Error("native cancellation fixture cleanup"));
      }
      await vi.advanceTimersByTimeAsync(20);
      vi.useRealTimers();
      waitCleanup.abort(new Error("native cancellation wait cleanup"));
      if (pending) {
        await pending.catch((error: unknown) => failures.push(error));
      }
      resetDetachedTaskLifecycleRuntimeForTests();
      failures.push(...(await closeBoundGateway(bound, runtime, targetRunId)));
      throwBoundFailures(failures);
    }
  });
}
