import "../test-utils/prepare-compiled-subprocesses.js";
import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, withinTest } from "../../test/helpers/promise.js";
import { runEmbeddedAgent } from "../agents/embedded-agent.js";
import { bindHostNativeGoal } from "../agents/harness/host-native-goal.js";
import { createAgentRunRestartAbortError } from "../agents/run-termination.js";
import * as dispatch from "../auto-reply/dispatch.js";
import * as custody from "../auto-reply/reply/goal-successor-custody.js";
import { persistGoalSuccessorCustody } from "../auto-reply/reply/goal-successor-custody.js";
import type { FollowupRun } from "../auto-reply/reply/queue/types.js";
import type {
  SessionEventOptions,
  SessionEventReceipt,
} from "../auto-reply/reply/session-event-contract.js";
import * as events from "../auto-reply/reply/session-event-handoff.js";
import {
  configureEventState,
  startEmbeddedTurn,
} from "../auto-reply/reply/session-event.test-support.js";
import {
  clearSessionGoal,
  createSessionGoal,
  updateSessionGoalStatus,
} from "../config/sessions/goals.js";
import {
  listSessionPendingInputs,
  loadExactSessionEntry,
  markSessionAbortTarget,
  replaceSessionEntry,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import { withPluginRuntimeGatewayContextResolver } from "../plugins/runtime/gateway-request-scope.js";
import { runWithGatewayIndependentRootWorkAdmission } from "../process/gateway-work-admission.js";
import { resolveActiveReplyOperationForSessionId } from "../sessions/session-controller.js";
import { createDeferredCore } from "../shared/deferred.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { pairedOperator, recoveryFixture } from "./operator-run-recovery.test-support.js";
import { persistGatewaySessionLifecycleEvent } from "./session-lifecycle-state.js";
import {
  persistRunningSessionsForRestart,
  resumeMarkedSessions,
} from "./session-restart-resume.js";

// mock-isolation: Only the provider is synthetic. Startup, source restoration,
// dispatch, adoption, pending-input custody and the pre-model fence stay real.
vi.mock("../agents/embedded-agent-runner/run.js", () => ({ runEmbeddedAgent: vi.fn() }));
const model = vi.mocked(runEmbeddedAgent);
await import("../auto-reply/reply/get-reply-from-config.runtime.js").then((runtime) =>
  runtime.prewarmConfigDrivenReplyRuntime(),
);

it.for([
  "running-native-complete",
  "restart-killed-native-complete",
  "second-restart",
  "stop",
  "pause",
  "clear",
  "replace",
  "replace-session",
  "native-complete",
  "pause-after-acquire",
  "compaction-native-complete",
] as const)(
  "rechecks an adopted recovery event before model execution: %s",
  async (action, { signal }) => {
    await withOpenClawTestState(
      { label: "goal-recovery-execution", env: { OPENCLAW_TEST_FAST: "0" } },
      async (state) => {
        const config = await configureEventState(state);
        const profile = ensureProfileForEmail("goal-execution@example.test");
        const fixture = await recoveryFixture(state.stateDir, profile.id, {
          device: pairedOperator(),
          config,
        });
        fixture.context.resolveGatewayContext = () => fixture.context;
        const target = fixture.target;
        const read = () => loadExactSessionEntry(target)!.entry;
        await createSessionGoal({ ...target, objective: "Finish the checked deliverable" });
        const source = await fixture.restore();
        if (!source) {
          throw new Error("Missing fixture source authority");
        }
        const base: FollowupRun = {
          prompt: "Continue",
          enqueuedAt: 1,
          operatorAuthority: source.authority,
          toolsAllow: ["read"],
          run: {
            agentId: target.agentId,
            agentDir: state.stateDir,
            sessionId: target.sessionId,
            sessionKey: target.sessionKey,
            sessionFile: target.sessionKey,
            workspaceDir: state.workspaceDir,
            config,
            provider: "mock-openai",
            model: "gpt-5.6-luna",
            timeoutMs: 1000,
            blockReplyBreak: "text_end",
            senderIsOwner: false,
            sessionEventOrigin: { deliver: false },
          },
        };
        const reached = createDeferredCore();
        const proceed = createDeferredCore();
        const acquiredBoundary = createDeferredCore();
        const publishRunning = createDeferredCore();
        const controller = new AbortController();
        const runSignal = AbortSignal.any([signal, controller.signal]);
        let receipt: SessionEventReceipt | undefined;
        let options: SessionEventOptions | undefined;
        let adopted = false;
        let acquired = false;
        let modelCalls = 0;
        const completes = action.endsWith("native-complete") || action === "second-restart";
        const interrupted = action !== "native-complete" && action !== "compaction-native-complete";
        const persist = custody.persistGoalSuccessorCustody;
        const running = vi
          .spyOn(custody, "persistGoalSuccessorCustody")
          .mockImplementation(async (input) => {
            if (
              input.phase === "running" &&
              input.sourceRunId !== "pre-restart" &&
              action === "pause-after-acquire"
            ) {
              acquiredBoundary.resolve();
              await withinTest(publishRunning.promise, runSignal);
            }
            return persist(input);
          });
        const enqueue = events.enqueueSessionEventForHost;
        const observe = vi
          .spyOn(events, "enqueueSessionEventForHost")
          .mockImplementation((text, input) => {
            options = input;
            expect(input.source).toBe("tool_handoff");
            expect(input.deliver).toBe(false);
            expect(input.expectedTarget?.toolsAllow).toEqual(["read"]);
            receipt = enqueue(text, {
              ...input,
              requiredGoal: input.requiredGoal
                ? {
                    ...input.requiredGoal,
                    onAcquired: (assertCurrent) => {
                      input.requiredGoal!.onAcquired(assertCurrent);
                      acquired = true;
                    },
                  }
                : undefined,
              onAdopted: async () => {
                await input.onAdopted?.();
                adopted = true;
              },
            });
            return receipt;
          });
        const realDispatch = dispatch.dispatchInboundMessageWithRoutedChannelDispatcher;
        const boundary = vi
          .spyOn(dispatch, "dispatchInboundMessageWithRoutedChannelDispatcher")
          .mockImplementation((input) => {
            const execution = input.replyOptions?.internalEventExecution;
            if (!execution) {
              return realDispatch(input);
            }
            return realDispatch({
              ...input,
              replyOptions: {
                ...input.replyOptions,
                internalEventExecution: {
                  ...execution,
                  beforeStart: async () => {
                    reached.resolve();
                    await withinTest(proceed.promise, runSignal);
                    await execution.beforeStart?.();
                  },
                },
              },
            });
          });
        model.mockReset().mockImplementation(async (params) => {
          modelCalls += 1;
          expect(read().abortedLastRun).not.toBe(true);
          await startEmbeddedTurn(params, "recovered goal execution");
          if (action === "second-restart" && modelCalls === 1) {
            expect(acquired).toBe(true);
            expect(read().goalSuccessor).toMatchObject({
              phase: "running",
              sourceRunId: params.runId,
            });
            await persistGatewaySessionLifecycleEvent({
              sessionKey: target.sessionKey,
              event: {
                runId: params.runId,
                sessionId: target.sessionId,
                ts: Date.now(),
                data: { phase: "start" },
              },
            });
            await persistRunningSessionsForRestart({ cfg: config });
            const pending = (await listSessionPendingInputs(target)).items;
            expect(pending).toMatchObject([{ runId: receipt!.id, state: "queued" }]);
            expect(read().resumeAfterRestart).toEqual({
              queuedInputIds: pending.map((input) => input.id),
            });
            const operation = resolveActiveReplyOperationForSessionId(params.sessionId);
            if (!operation) {
              throw new Error("Missing recovered execution owner");
            }
            operation.abortForRestart();
            await persistGatewaySessionLifecycleEvent({
              sessionKey: target.sessionKey,
              event: {
                runId: params.runId,
                sessionId: target.sessionId,
                ts: Date.now(),
                data: { phase: "end", aborted: true, stopReason: "restart" },
              },
            });
            throw createAgentRunRestartAbortError();
          }
          if (completes) {
            expect(acquired).toBe(true);
            expect(read().goalSuccessor?.phase).toBe("running");
            if (action === "compaction-native-complete") {
              await upsertSessionEntryCore(target, { ...read(), compactionCount: 1 });
            }
            if (!options?.assertCurrent) {
              throw new Error("Missing native goal owner");
            }
            // The mocked embedded runner stops before its normal transcript
            // target preparation. Supply this fixture's exact admitted target,
            // not a fabricated capability or an unguarded native status callback.
            expect(params.sessionId).toBe(target.sessionId);
            expect(params.sessionKey).toBe(target.sessionKey);
            const native = await bindHostNativeGoal(
              { ...target, expectedLifecycleRevision: read().lifecycleRevision },
              options.assertCurrent,
              params.abortSignal ?? runSignal,
            )();
            if (!native) {
              throw new Error("Recovered execution lost its native goal");
            }
            await native.onStatus({ status: "complete", reason: "Checked deliverable finished" });
            expect(native.signal.aborted).toBe(false);
          }
          return { payloads: [{ text: "Completed" }], meta: { durationMs: 1, stopReason: "stop" } };
        });
        const log = { warn: vi.fn() };
        let startup: Promise<void> | undefined;
        try {
          if (interrupted) {
            await persistGatewaySessionLifecycleEvent({
              sessionKey: target.sessionKey,
              event: {
                runId: "pre-restart",
                sessionId: target.sessionId,
                ts: Date.now(),
                data: { phase: "start" },
              },
            });
            expect(read().lifecycleRunId).toBe("pre-restart");
          }
          expect(
            await persistGoalSuccessorCustody({
              base,
              entry: read(),
              sessionKey: target.sessionKey,
              storePath: target.storePath,
              sourceRunId: "pre-restart",
              phase: interrupted ? "running" : "pending",
              assertCurrent: source.authority.assertCurrent,
            }),
          ).toBe(true);
          if (action === "restart-killed-native-complete") {
            await persistGatewaySessionLifecycleEvent({
              sessionKey: target.sessionKey,
              event: {
                runId: "pre-restart",
                sessionId: target.sessionId,
                ts: Date.now(),
                data: { phase: "end", aborted: true, stopReason: "restart" },
              },
            });
            expect(read()).toMatchObject({
              status: "killed",
              abortedLastRun: true,
              goal: { status: "active" },
            });
            expect(read().lifecycleRunId).toBeUndefined();
          }
          startup = runWithGatewayIndependentRootWorkAdmission(
            () =>
              withPluginRuntimeGatewayContextResolver(
                () => fixture.context,
                () => resumeMarkedSessions({ context: fixture.context, signal: runSignal, log }),
              ),
            "startup:session-resume",
            runSignal,
          );
          await withinTest(startup, signal);
          expect(receipt, JSON.stringify(log.warn.mock.calls)).toBeDefined();
          if (!receipt) {
            throw new Error("Startup did not admit recovery");
          }
          expect(await receipt.accepted).toEqual({ ok: true });
          await withinTest(
            awaitGateBeforeSettlement(
              reached.promise,
              receipt.settled,
              "Recovery settled before the execution fence",
            ),
            signal,
          );
          expect(adopted).toBe(true);
          expect(model).not.toHaveBeenCalled();
          expect(acquired).toBe(false);
          if (action === "pause-after-acquire") {
            proceed.resolve();
            await withinTest(
              awaitGateBeforeSettlement(
                acquiredBoundary.promise,
                receipt.settled,
                "Recovery settled before running publication",
              ),
              signal,
            );
            expect(acquired).toBe(true);
            expect(model).not.toHaveBeenCalled();
            await updateSessionGoalStatus({ ...target, status: "paused" });
            publishRunning.resolve();
          }
          if (action === "stop") {
            expect((await markSessionAbortTarget({ scope: target }))?.persisted).toBe(true);
          }
          if (action === "pause") {
            await updateSessionGoalStatus({ ...target, status: "paused" });
          }
          if (action === "clear") {
            await clearSessionGoal(target);
          }
          if (action === "replace") {
            await clearSessionGoal(target);
            await createSessionGoal({ ...target, objective: "A different goal" });
          }
          if (action === "replace-session") {
            await replaceSessionEntry(target, {
              ...read(),
              sessionId: "replacement-session",
              lifecycleRevision: "replacement-lifecycle",
            });
          }
          proceed.resolve();
          let outcome = await withinTest(receipt.settled, signal);
          if (action === "second-restart") {
            expect(outcome, outcome.error).toMatchObject({
              interruptedByRestart: true,
              executionStarted: true,
            });
            expect(modelCalls).toBe(1);
            expect(read()).toMatchObject({
              status: "killed",
              abortedLastRun: true,
              goal: { status: "active" },
              goalSuccessor: { phase: "running" },
            });
            const predecessor = read().goalSuccessor!;
            const firstReceipt = receipt;
            const firstOptions = options!;
            expect(() => firstOptions.assertCurrent!()).toThrow();
            // New Gateway lifetime, same physical store and durable receipt. No state reseeding.
            const restartedContext = { ...fixture.context };
            restartedContext.resolveGatewayContext = () => restartedContext;
            acquired = false;
            startup = runWithGatewayIndependentRootWorkAdmission(
              () =>
                withPluginRuntimeGatewayContextResolver(
                  () => restartedContext,
                  () => resumeMarkedSessions({ context: restartedContext, signal: runSignal, log }),
                ),
              "startup:session-resume",
              runSignal,
            );
            await withinTest(startup, signal);
            expect(receipt).not.toBe(firstReceipt);
            expect(options?.sourceRunId).toBe(predecessor.sourceRunId);
            expect(await receipt.accepted).toEqual({ ok: true });
            outcome = await withinTest(receipt.settled, signal);
            expect(() => firstOptions.assertCurrent!()).toThrow();
          }
          if (completes) {
            expect(model, outcome.error).toHaveBeenCalledTimes(action === "second-restart" ? 2 : 1);
            expect(outcome, outcome.error).toMatchObject({
              status: "completed",
              executionStarted: true,
            });
            expect(read().goal?.status).toBe("complete");
          } else {
            expect(model).not.toHaveBeenCalled();
            expect(outcome.executionStarted).toBe(false);
            expect(outcome.status).not.toBe("completed");
          }
        } finally {
          controller.abort();
          proceed.resolve();
          publishRunning.resolve();
          await Promise.allSettled([startup, receipt?.settled]);
          running.mockRestore();
          boundary.mockRestore();
          observe.mockRestore();
          source.release();
        }
      },
    );
  },
);
