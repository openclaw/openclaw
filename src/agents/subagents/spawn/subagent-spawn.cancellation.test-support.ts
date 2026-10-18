import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, onTestFinished, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../../test/helpers/promise.js";
import type { OpenClawConfig } from "../../../config/config.js";
import { loadSessionEntry } from "../../../config/sessions/session-accessor.js";
import type { createGatewayInstanceRuntime } from "../../../gateway/server-instance-runtime.js";
import type { GatewayRequestContext } from "../../../gateway/server-methods/types.js";
import { dispatchGatewayMethodInProcess } from "../../../gateway/server-plugin-in-process-dispatch.js";
import { createSyntheticPluginRuntimeClient } from "../../../gateway/server-plugin-runtime-client.js";
import { createHookRunner } from "../../../plugins/hooks.js";
import { createPluginRecord } from "../../../plugins/loader-records.js";
import { createRuntimeTestRegistry } from "../../../plugins/registry-runtime.test-helpers.js";
import { setActivePluginRegistry } from "../../../plugins/runtime.js";
import { withPluginRuntimeGatewayRequestScope } from "../../../plugins/runtime/gateway-request-scope.js";
import { createPluginRuntime } from "../../../plugins/runtime/index.js";
import { createPluginSubagentRequesterContext } from "../../../plugins/runtime/subagent-requester-context.js";
import {
  beginSessionWorkAdmission,
  SESSION_WORK_ADMISSION_DRAIN_TIMEOUT_MS,
  startSessionWorkAdmissionInterruption,
  type SessionWorkAdmissionLease,
} from "../../../sessions/session-lifecycle-admission.js";
import { createAgentRunDirectAbortError } from "../../run-termination.js";
import { createSubagentsTool } from "../../tools/subagents-tool.js";
import * as nativeControl from "../registry/subagent-control.js";
import { subagentRuns } from "../registry/subagent-registry-memory.js";
import { subscribeSubagentRunChanges } from "../registry/subagent-registry-publication.js";
import { observeRootWork } from "../registry/subagent-registry.browser-cleanup.test-support.js";
import { registerSubagentRun } from "../registry/subagent-registry.test-helpers.js";
import { resolveSubagentSessionStatus } from "../registry/subagent-session-metrics.js";

type GatewayRuntime = ReturnType<typeof createGatewayInstanceRuntime>;
const killNative = nativeControl.killSubagentRunAdmin;

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
  const { parentSessionKey, parentRunId } = options;
  it.for([
    "before interruption",
    "after interruption",
    "already interrupted",
    "blocked drain",
  ] as const)(
    "separates native stop acceptance from caller revocation %s",
    async (transition, { signal }) => {
      const bound = await options.createBoundParent();
      const { createGatewaySubagentRuntime } =
        await import("../../../gateway/server-plugin-subagent-runtime.js");
      const context = bound.context as unknown as GatewayRequestContext;
      context.resolveGatewayContext = () => context;
      const scoped = <T>(work: () => T) =>
        withPluginRuntimeGatewayRequestScope({ context, isWebchatConnect: () => false }, work);
      const wait = <T>(work: PromiseLike<T>) => withinTest(work, signal);
      const register = (runId: string, sessionKey: string, ownerKey: string) =>
        scoped(() =>
          registerSubagentRun({
            runId,
            childSessionKey: sessionKey,
            childAgentId: "main",
            sessionEntry: expectDefined(
              loadSessionEntry({ storePath: bound.storePath, sessionKey }),
              "registered session",
            ),
            requesterSessionKey: ownerKey,
            controllerSessionKey: ownerKey,
            requesterDisplayKey: ownerKey,
            task: runId,
            cleanup: "keep",
            expectsCompletionMessage: false,
          }),
        );
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
      const { runtime } = await options.createBoundGateway(bound);
      const requester = "agent:main:telegram:direct:native-cancellation";
      const nextRunId = "native-cancellation-ancestor-next";
      const targetKey = "agent:main:subagent:native-cancellation-target";
      const targetRunId = "native-cancellation-target";
      const releaseTerminal = createDeferred();
      const terminalReady = createDeferred<unknown>();
      const targetWait = createDeferred<{ completion: Promise<unknown> }>();
      const entered = createDeferred();
      const releaseCancellation = createDeferred();
      const waitCleanup = new AbortController();
      const waitFacade = await runtime.createAgentTurnFacade({
        client: createSyntheticPluginRuntimeClient({ operatorRoleActor: { kind: "system" } }),
      });
      const waitForAgent = vi
        .spyOn(runtime.recovery, "waitForAgent")
        .mockImplementation(
          <T>(
            params: Parameters<typeof runtime.recovery.waitForAgent>[0],
            timeoutMs?: number,
          ): Promise<T> => {
            const completion = waitFacade
              .wait<T>(params, timeoutMs, waitCleanup.signal)
              .then(async (response) => {
                if (params.runId === targetRunId) {
                  terminalReady.resolve(response);
                  await releaseTerminal.promise;
                }
                return response;
              });
            if (params.runId === targetRunId) {
              targetWait.resolve({ completion });
            }
            return completion;
          },
        );
      const failures: unknown[] = [];
      let pending: ReturnType<ReturnType<typeof createSubagentsTool>["execute"]> | undefined;
      let pendingSettled: Promise<PromiseSettledResult<unknown>[]> | undefined;
      let blockedAdmission: SessionWorkAdmissionLease | undefined;
      let stopObserving: (() => void) | undefined;
      let restoreNativeControl: (() => void) | undefined;
      let retired = false;
      const releaseFixtureWork = () => {
        releaseCancellation.resolve();
        releaseTerminal.resolve();
        stopObserving?.();
        blockedAdmission?.release();
        for (const entry of context.chatAbortControllers.values()) {
          entry.controller.abort(new Error("native cancellation fixture cleanup"));
        }
      };
      const retireFixture = () => {
        if (retired) {
          return;
        }
        retired = true;
        waitForAgent.mockRestore();
        restoreNativeControl?.();
        releaseFixtureWork();
        waitCleanup.abort(new Error("native cancellation wait cleanup"));
      };
      onTestFinished(retireFixture);
      const settleRootWork = observeRootWork();
      await register(parentRunId, parentSessionKey, requester);
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
        await register(targetRunId, targetKey, parentSessionKey);
        const target = expectDefined(context.chatAbortControllers.get(targetRunId), "target run");
        const onAbort = vi.fn(() => entered.resolve());
        target.controller.signal.addEventListener("abort", onAbort, { once: true });
        if (transition === "blocked drain") {
          blockedAdmission = await beginSessionWorkAdmission({
            scope: bound.storePath,
            identities: [targetKey, target.sessionId],
            run: {
              runId: targetRunId,
              sessionKey: targetKey,
              sessionId: target.sessionId,
              agentId: "main",
            },
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
        const nativeKillSpy = vi
          .spyOn(nativeControl, "killSubagentRunAdmin")
          .mockImplementation(async (...args) => {
            if (transition === "before interruption") {
              entered.resolve();
              await releaseCancellation.promise;
            }
            return await killNative(...args);
          });
        restoreNativeControl = () => nativeKillSpy.mockRestore();
        const tool = createSubagentsTool({ config: bound.cfg, agentSessionKey: requester });
        pending = tool.execute("native-cancel", { action: "cancel", runId: targetRunId });
        // Observe refusal immediately while the fixture controls the publication boundary.
        pendingSettled = Promise.allSettled([pending]);
        await wait(
          awaitGateBeforeSettlement(
            entered.promise,
            pending,
            `Native cancellation settled before the ${transition} interruption signal`,
          ),
        );
        if (transition === "already interrupted") {
          const claimed = createDeferred();
          const inspectClaim = () => {
            if (subagentRuns.get(targetRunId)?.killIntent) {
              claimed.resolve();
            }
          };
          const stopObservingClaim = subscribeSubagentRunChanges("persistence", inspectClaim);
          try {
            inspectClaim();
            await wait(
              awaitGateBeforeSettlement(
                claimed.promise,
                pending,
                "Cancellation returned before admission interruption",
              ),
            );
          } finally {
            stopObservingClaim();
          }
        }
        await vi.advanceTimersByTimeAsync(1);
        if (transition !== "blocked drain") {
          await wait(
            hookRunner.runBeforeDispatch(
              { content: "Change ancestor control" },
              { sessionKey: requester },
              requesterContext,
            ),
          );
          const replacement = expectDefined(subagentRuns.get(nextRunId), "new ancestor");
          expect(replacement.generation).toBeGreaterThan(ancestor.generation!);
          expect(replacement).toMatchObject({
            controllerSessionKey: "agent:main:main",
            requesterSessionKey: requester,
          });
        }
        const accepted = transition === "after interruption";
        const interrupted = transition !== "before interruption";
        if (interrupted) {
          await vi.advanceTimersByTimeAsync(9);
          expect(await wait(terminalReady.promise)).toMatchObject({
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
          const cancellation = await wait(pending);
          expect(subagentRuns.get(targetRunId)?.killIntent).toEqual(originalClaim);
          expect(cancellation.details).toMatchObject({
            killed: false,
            error: expect.stringContaining("cleanup is pending"),
          });
          expect(blockedAdmission?.isActive()).toBe(true);
          expect(resolveSubagentSessionStatus(subagentRuns.get(targetRunId))).toBe("running");
          const settled = createDeferred();
          stopObserving = subscribeSubagentRunChanges("persistence", () => {
            if (resolveSubagentSessionStatus(subagentRuns.get(targetRunId)) === "killed") {
              settled.resolve();
            }
          });
          blockedAdmission?.release();
          releaseTerminal.resolve();
          await wait(settled.promise);
          expect(resolveSubagentSessionStatus(subagentRuns.get(targetRunId))).toBe("killed");
          expect(subagentRuns.get(targetRunId)).toMatchObject({
            killIntent: undefined,
            killReconciliation: {
              killedAt: originalClaim.requestedAt,
              taskCancellationAccepted: true,
            },
          });
          options.assertNoModelExecution();
        } else {
          // Revocation refuses the caller result even when the native owner already
          // accepted the stop; the registry assertions below prove that settlement.
          await wait(expect(pending).rejects.toThrow("Subagent cancellation owner changed"));
          expect(target.controller.signal.aborted).toBe(interrupted);
          expect(onAbort).toHaveBeenCalledTimes(Number(interrupted));
          expect(resolveSubagentSessionStatus(subagentRuns.get(targetRunId))).toBe(
            accepted ? "killed" : "running",
          );
          expect(subagentRuns.get(targetRunId)?.killIntent).toBeUndefined();
          options.assertNoModelExecution();
          releaseTerminal.resolve();
        }
      } catch (error) {
        failures.push(error);
      } finally {
        try {
          releaseFixtureWork();
          await vi.advanceTimersByTimeAsync(20);
          // Pre-interruption cleanup produces the terminal response that the other cases observed.
          if (pending && !signal.aborted) {
            const { completion } = await wait(targetWait.promise);
            await wait(completion);
          }
        } catch (error) {
          failures.push(error);
        } finally {
          vi.useRealTimers();
          retireFixture();
        }
        await pendingSettled;
        failures.push(...(await options.closeBoundGateway(bound, runtime, targetRunId)));
        try {
          await settleRootWork(true);
        } catch (error) {
          failures.push(error);
        }
        options.throwBoundFailures(failures);
      }
    },
  );
}
