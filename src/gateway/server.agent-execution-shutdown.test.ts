import { setImmediate as nextTurn } from "node:timers/promises";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import { isAgentRunRestartAbortReason } from "../agents/run-termination.js";
import { deleteSubagentSessionForCleanup } from "../agents/subagents/registry/subagent-session-cleanup.js";
import { waitForGatewayActiveWork } from "../infra/gateway-active-work.js";
import { captureSessionTarget } from "../sessions/session-controller.lifecycle.js";
import { callGateway } from "./call.js";
import { registerChatAbortController } from "./chat-abort.js";
import { dispatchGatewayMethodInProcess } from "./server-plugin-in-process-dispatch.js";
import { captureGatewayKernel } from "./server.capture-kernel.test-support.js";
import { startGatewayServerHarness, type GatewayServerHarness } from "./server.e2e-ws-harness.js";
import { loadSessionEntryAsync } from "./session-entry-load.test-support.js";
import {
  agentCommandMock,
  installGatewayTestHooks,
  prepareGatewayReplyRuntimeForTest,
  rpcReq,
} from "./test-helpers.js";

for (const mode of ["stop", "restart", "graceful"] as const) {
  describe(`Gateway detached execution during ${mode}`, () => {
    let harness: GatewayServerHarness;
    let kernel: Awaited<ReturnType<(typeof import("./server-kernel.js"))["createGatewayKernel"]>>;
    let agentDispatch: typeof import("./agent-turn/agent-run-dispatch.js");
    let acquisition: Promise<GatewayServerHarness> | undefined;
    let restartMarkers: MockInstance<typeof markRestartAbortedMainSessions>;
    let markRestartAbortedMainSessions: (typeof import("../agents/main-session-recovery/main-session-restart-recovery.js"))["markRestartAbortedMainSessions"];
    installGatewayTestHooks({
      scope: "suite",
      setup: async () => {
        const recoveryModule =
          await import("../agents/main-session-recovery/main-session-restart-recovery.js");
        markRestartAbortedMainSessions = recoveryModule.markRestartAbortedMainSessions;
        restartMarkers = vi.spyOn(recoveryModule, "markRestartAbortedMainSessions");
        kernel = await captureGatewayKernel(async () => {
          acquisition = startGatewayServerHarness();
          harness = await acquisition;
          agentDispatch = await import("./agent-turn/agent-run-dispatch.js");
          const [{ coreGatewayHandlers }, { prepareGatewayRequestHandler }] = await Promise.all([
            import("./server-methods/core-handlers.js"),
            import("./server-methods/lazy-core-handlers.js"),
          ]);
          // Lazy module transformation belongs to fixture setup, outside the RPC deadline.
          await prepareGatewayRequestHandler(coreGatewayHandlers["sessions.create"]!);
        });
      },
      cleanup: async () => {
        const [result] = await Promise.allSettled([acquisition]);
        if (result.status === "fulfilled") {
          await result.value?.close();
        }
      },
    });
    beforeEach(async () => {
      vi.mocked(agentCommandMock).mockReset();
      await prepareGatewayReplyRuntimeForTest();
    });

    it("settles the original command and finalizer before retiring its Gateway", async ({
      signal,
    }) => {
      const runtime = kernel.gatewayInstanceRuntime;
      const commandStarted = createDeferred();
      const commandRelease = createDeferred();
      const finalizerEntered = createDeferred();
      const finalizerRelease = createDeferred();
      const terminalObserved = createDeferred();
      const drainEntered = createDeferred();
      const graceObserved = createDeferred();
      const runId = `gateway-${mode}-execution`;
      const order: string[] = [];
      const childSessionKey = `agent:main:subagent:${mode}-cleanup`;
      const { ws } = await harness.openClient();
      const created = await rpcReq<{
        entry: { sessionId: string; lifecycleRevision: string };
      }>(ws, "sessions.create", { key: childSessionKey });
      expect(created.ok).toBe(true);
      const child = created.payload!.entry;
      const cleanupErrors: string[] = [];
      const settlementWarnings = vi.spyOn(kernel.gatewayRequestContext.logGateway, "warn");
      const cleanup = (
        overrides: Partial<Parameters<typeof deleteSubagentSessionForCleanup>[0]> = {},
      ) =>
        deleteSubagentSessionForCleanup({
          callGateway,
          gatewayBinding: {
            resolveGatewayContext: kernel.gatewayRequestContext.resolveGatewayContext,
          },
          childSessionKey,
          expectedSessionId: child.sessionId,
          expectedLifecycleRevision: child.lifecycleRevision,
          isCurrent: () => true,
          onError: (error: unknown) => cleanupErrors.push(String(error)),
          ...overrides,
        });
      const cleanupOutcomes: string[] = [];
      const foreign = registerChatAbortController({
        target: captureSessionTarget({
          storeScope: "foreign-store",
          sessionKey: "agent:foreign:main",
          incarnation: "foreign-session",
          agentId: "foreign",
        }),
        runId,
        sessionId: "foreign-session",
        sessionKey: "agent:foreign:main",
        timeoutMs: 60_000,
        kind: "agent",
      });
      let terminalPayload: unknown;
      let runSignal: AbortSignal | undefined;
      const observed: Record<string, boolean | undefined> = {};
      let emergencyReleaseUsed = false;
      let closing: Promise<void> | undefined;
      let request: Promise<unknown> | undefined;
      let grace: ReturnType<typeof waitForGatewayActiveWork> | undefined;
      const release = () => {
        commandRelease.resolve();
        finalizerRelease.resolve();
      };
      signal.addEventListener("abort", release, { once: true });
      const dispatch = agentDispatch.dispatchAgentRunFromGateway;
      const observeDispatch = vi
        .spyOn(agentDispatch, "dispatchAgentRunFromGateway")
        .mockImplementation((params) => {
          runSignal = params.abortController.signal;
          return dispatch({
            ...params,
            onSettled: async (outcome) => {
              finalizerEntered.resolve();
              await finalizerRelease.promise;
              observed.finalizerAvailable = runtime.isAvailable();
              let cleanupCurrent = true;
              cleanupOutcomes.push(
                await cleanup({
                  prepareCurrent: async () => {
                    cleanupCurrent = false;
                    return true;
                  },
                  isCurrent: () => cleanupCurrent,
                }),
                await cleanup({ expectedLifecycleRevision: "superseded-child" }),
                await cleanup(),
              );
              order.push(
                (await loadSessionEntryAsync(childSessionKey)).entry
                  ? "child retained"
                  : "child deleted",
              );
              const result = await params.onSettled?.(outcome);
              order.push("finalizer settled");
              return result ?? true;
            },
            cleanupAbortController: async () => {
              await params.cleanupAbortController();
              order.push("run owner released");
            },
            io: {
              ...params.io,
              emitFinal: (...args) => {
                params.io.emitFinal(...args);
                terminalPayload = args[0][1];
                terminalObserved.resolve();
              },
            },
          });
        });
      vi.mocked(agentCommandMock).mockImplementationOnce(async (options) => {
        if (!isRecord(options) || !(options.abortSignal instanceof AbortSignal)) {
          throw new Error("the admitted Gateway command has no cancellation signal");
        }
        const abortSignal = options.abortSignal;
        const cancelled = createDeferred();
        const onAbort = () => cancelled.resolve();
        abortSignal.addEventListener("abort", onAbort, { once: true });
        try {
          if (typeof options.onExecutionStarted === "function") {
            options.onExecutionStarted();
          }
          commandStarted.resolve();
          await Promise.race([commandRelease.promise, cancelled.promise]);
          order.push("command settled");
          if (abortSignal.aborted) {
            throw abortSignal.reason;
          }
          return {
            payloads: [{ text: "completed during grace" }],
            meta: {
              durationMs: 1,
              terminalReply: { disposition: "visible", text: "completed during grace" },
            },
          };
        } finally {
          abortSignal.removeEventListener("abort", onAbort);
        }
      });
      try {
        request = kernel.connectionWork.track(() =>
          dispatchGatewayMethodInProcess(
            "agent",
            {
              message: "exercise the admitted command lifetime",
              sessionKey: "main",
              idempotencyKey: runId,
            },
            {
              forceSyntheticClient: true,
              resolveGatewayContext: kernel.gatewayRequestContext.resolveGatewayContext,
            },
          ),
        );
        expect(await request).toMatchObject({ status: "accepted", runId });
        await commandStarted.promise;
        expect(order).toEqual([]);
        expect(runSignal?.aborted).toBe(false);
        kernel.registerGatewayLifetimeSidecars({
          stop: () => {
            order.push("dependencies stopped");
          },
        });
        const drain = kernel.connectionWork.drain.bind(kernel.connectionWork);
        vi.spyOn(kernel.connectionWork, "drain").mockImplementationOnce(() => {
          observed.drainAborted = runSignal?.aborted;
          const operation = drain();
          drainEntered.resolve();
          return operation;
        });

        if (mode === "graceful") {
          // Freeze only the grace budget; keep the real polling and cleanup.
          vi.useFakeTimers({ toFake: ["Date"] });
          try {
            grace = waitForGatewayActiveWork(5_000, {
              onSnapshot: (snapshot) => {
                if (!snapshot.idle) {
                  graceObserved.resolve();
                }
              },
            });
            await withinTest(graceObserved.promise, signal);
            expect(runSignal?.aborted).toBe(false);
            release();
            await withinTest(terminalObserved.promise, signal);
            expect(await withinTest(grace, signal)).toMatchObject({ drained: true });
          } finally {
            vi.useRealTimers();
          }
        }
        restartMarkers.mockImplementationOnce(async (params) => {
          observed.beforeMarkAborted = runSignal?.aborted;
          observed.workAborted = kernel.connectionWork.signal.aborted;
          observed.markAvailable = runtime.isAvailable();
          observed.entryFenced = await runtime.recovery
            .dispatchAgent({
              message: "must not enter during shutdown",
              sessionKey: "main",
              idempotencyKey: `${runId}-late`,
            })
            .then(
              () => false,
              (error: unknown) => String(error).includes("Gateway request entry is closed"),
            );
          const result = await markRestartAbortedMainSessions(params);
          const { entry } = await loadSessionEntryAsync("main");
          observed.recoveryMarked = Boolean(entry?.mainRestartRecovery?.cycleId);
          observed.afterMarkAborted = runSignal?.aborted;
          return result;
        });
        closing = harness.server.close({
          reason: mode === "restart" ? "gateway restart" : "gateway stopping",
          restartExpectedMs: mode === "restart" ? 0 : null,
          ...(mode === "restart" ? { drainTimeoutMs: 0 } : {}),
        });
        await drainEntered.promise;
        await nextTurn();
        const beforeEmergencyRelease = [...order];
        if (mode !== "graceful" && !runSignal?.aborted) {
          emergencyReleaseUsed = true;
          commandRelease.resolve();
        }
        await finalizerEntered.promise;
        await nextTurn();
        const beforeFinalizerRelease = [...order];
        finalizerRelease.resolve();
        await terminalObserved.promise;
        await nextTurn();
        await closing;

        expect(cleanupOutcomes, cleanupErrors.join("\n")).toEqual(["failed", "changed", "deleted"]);
        await expect(cleanup()).resolves.toBe("failed");
        expect(foreign.controller.signal.aborted).toBe(false);
        expect(restartMarkers).toHaveBeenCalledOnce();
        // Closing entry must not revoke execution before its durable restart marker commits.
        expect(observed).toEqual({
          drainAborted: mode !== "graceful",
          beforeMarkAborted: false,
          workAborted: false,
          afterMarkAborted: false,
          markAvailable: true,
          finalizerAvailable: true,
          entryFenced: true,
          recoveryMarked: mode !== "graceful",
        });
        expect(
          settlementWarnings.mock.calls.filter(([message]) =>
            message.includes("failed to settle pending agent input"),
          ),
        ).toEqual([]);
        expect(runtime.isAvailable()).toBe(false);
        if (mode === "graceful") {
          expect(runSignal?.aborted).toBe(false);
          expect(terminalPayload).toMatchObject({ status: "ok" });
          expect(terminalPayload).not.toHaveProperty("stopReason");
        } else {
          expect(emergencyReleaseUsed).toBe(false);
          expect(beforeEmergencyRelease).not.toContain("dependencies stopped");
          expect(beforeFinalizerRelease).not.toContain("dependencies stopped");
          expect(isAgentRunRestartAbortReason(runSignal?.reason)).toBe(true);
          expect(terminalPayload).toMatchObject({
            status: "timeout",
            stopReason: "restart",
          });
        }
        expect(order).toEqual([
          "command settled",
          "child deleted",
          "finalizer settled",
          "run owner released",
          "dependencies stopped",
        ]);
      } finally {
        release();
        await Promise.allSettled([request, grace]);
        if (runSignal) {
          // A started command must publish its original terminal tail before fixture restoration.
          await terminalObserved.promise;
        }
        await Promise.allSettled([closing]);
        observeDispatch.mockRestore();
        vi.restoreAllMocks();
        foreign.cleanup();
        signal.removeEventListener("abort", release);
      }
    });
  });
}
