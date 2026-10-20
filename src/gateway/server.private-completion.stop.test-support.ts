import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect, it, onTestFinished, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import type { AgentCommandOpts } from "../agents/command/types.js";
import { SubagentLifecycleController } from "../agents/subagents/registry/subagent-registry-lifecycle.js";
import { subagentRuns } from "../agents/subagents/registry/subagent-registry-memory.js";
import { listRunsForControllerFromRuns } from "../agents/subagents/registry/subagent-registry-queries.js";
import { loadSubagentRegistryFromSqlite } from "../agents/subagents/registry/subagent-registry-state.fixture.test-support.js";
import { registerSubagentRun } from "../agents/subagents/registry/subagent-registry.js";
import {
  writeSubagentSessionEntry,
  settleSubagentRegistryPersistenceWork,
} from "../agents/subagents/registry/subagent-registry.persistence.test-support.js";
import {
  getCurrentSessionControllerOwner,
  SESSION_CONTROLLER_DRAIN_TIMEOUT_MS,
} from "../sessions/session-controller.lifecycle.js";
import { isRpcSourceExecuting } from "../sessions/session-controller.rpc-sources.js";
import type { RpcSourceRef } from "../sessions/session-controller.rpc-sources.js";
import { markReplyOperationExecutionStarted } from "../sessions/session-controller.state.js";
import type { UserTurnTranscriptRecorder } from "../sessions/user-turn-transcript.types.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import * as agentJobs from "./agent-turn/agent-job.js";
import { waitForChatAbortControllerRemoval } from "./chat-abort-lifecycle-internal.js";
import * as chatAbort from "./chat-abort.js";
import { dispatchGatewayMethodInProcess } from "./server-plugin-in-process-dispatch.js";
import { holdMetadataThroughSubagentStop } from "./server.private-completion.metadata-overlap.test-support.js";
import { loadSessionEntryAsync } from "./session-entry-load.test-support.js";
import * as lifecycleState from "./session-lifecycle-state.js";
import { createPreparedLifecycleWriteTracker } from "./session-lifecycle-state.test-support.js";
import type { agentCommandMock as gatewayAgentCommandMock } from "./test-helpers.js";

type PrivateCompletionStopFixture = {
  kernel: Awaited<ReturnType<(typeof import("./server-kernel.js"))["createGatewayKernel"]>>;
  sequence: number;
  sessionKey: string;
  sessionId: string;
  runId: string;
  storePath: string;
  recorder: (input: unknown) => UserTurnTranscriptRecorder;
  dispatch: (message?: string, onAccepted?: () => void) => Promise<Record<string, unknown>>;
  completions: () => Record<string, unknown>[];
  pending: () => Record<string, unknown>[];
  restart: () => Promise<void>;
  source: (runId?: string) => RpcSourceRef | undefined;
  agentCommandMock: typeof gatewayAgentCommandMock;
};

export function registerPrivateCompletionStopTests(getFixture: () => PrivateCompletionStopFixture) {
  it.for([false, true])(
    "preserves an operator stop after private input consumption across retry and restart (terminal first=%s)",
    async (terminalFirst, { signal }) => {
      const {
        kernel,
        sequence,
        sessionKey,
        sessionId,
        runId,
        storePath,
        recorder,
        dispatch,
        completions,
        pending,
        restart,
        source,
        agentCommandMock,
      } = getFixture();
      const descendantRunId = `private-descendant-${sequence}`;
      const childSessionKey = `agent:main:subagent:${descendantRunId}`;
      const childSessionId = `${descendantRunId}-session`;
      let observedTerminal = false;
      const metadataOverlap = holdMetadataThroughSubagentStop({
        sessionKey: childSessionKey,
        sessionId: childSessionId,
        storePath,
        signal,
        beforeMetadata: () => {
          if (terminalFirst) {
            expect(observedTerminal).toBe(true);
          }
          expect(
            listRunsForControllerFromRuns(loadSubagentRegistryFromSqlite(), sessionKey).find(
              (run) => run.runId === descendantRunId,
            ),
          ).toMatchObject({ endedReason: "subagent-killed", execution: { status: "terminal" } });
        },
      });
      onTestFinished(() => metadataOverlap.dispose());
      const consumed = createDeferred();
      const release = createDeferred();
      signal.addEventListener("abort", () => release.resolve(), { once: true });
      agentCommandMock.mockImplementationOnce(async (input) => {
        const command = input as AgentCommandOpts;
        await command.onExecutionStarted?.();
        await recorder(input).persistApproved();
        consumed.resolve();
        command.abortSignal!.addEventListener("abort", () => release.resolve(), { once: true });
        await release.promise;
        command.abortSignal!.throwIfAborted();
        throw new Error("operator stop must prevent further work");
      });
      const first = dispatch();
      const observed = first.then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      await consumed.promise;
      if (terminalFirst) {
        const acquire = vi.spyOn(
          SubagentLifecycleController.prototype,
          "acquireTerminalCompletionLock",
        );
        acquire.mockRestore();
        const lock = vi
          .spyOn(SubagentLifecycleController.prototype, "acquireTerminalCompletionLock")
          .mockImplementation(async function (this: SubagentLifecycleController, targetRunId) {
            const unlock = await acquire.call(this, targetRunId);
            return () => {
              unlock();
              const entry = subagentRuns.get(targetRunId);
              if (
                targetRunId === descendantRunId &&
                entry?.endedReason === "subagent-killed" &&
                entry.killReconciliation?.taskCancellationAccepted === true
              ) {
                observedTerminal = true;
              }
            };
          });
        onTestFinished(() => {
          lock.mockRestore();
        });
      }
      const childStarted = createDeferred();
      const releaseChild = createDeferred();
      let childAbortSignal: AbortSignal | undefined;
      signal.addEventListener("abort", () => releaseChild.resolve(), { once: true });
      await writeSubagentSessionEntry({
        stateDir: process.env.OPENCLAW_STATE_DIR!,
        agentId: "main",
        sessionKey: childSessionKey,
        defaultSessionId: childSessionId,
        lifecycleRevision: "private-descendant-original",
      });
      agentCommandMock.mockImplementationOnce(async (input) => {
        const command = input as AgentCommandOpts;
        expect(command.runId).toBe(descendantRunId);
        expect(command.sessionId).toBe(childSessionId);
        childAbortSignal = command.abortSignal;
        await command.onExecutionStarted?.();
        await command.userTurnTranscriptRecorder?.persistApproved();
        childStarted.resolve();
        command.abortSignal!.addEventListener("abort", () => releaseChild.resolve(), {
          once: true,
        });
        await releaseChild.promise;
        command.abortSignal!.throwIfAborted();
        throw new Error("operator stop must interrupt the continuation child");
      });
      const child = dispatchGatewayMethodInProcess<Record<string, unknown>>(
        "agent",
        {
          sessionKey: childSessionKey,
          expectedExistingSessionId: childSessionId,
          idempotencyKey: descendantRunId,
          message: "Synthetic continuation child",
          deliver: false,
        },
        {
          expectFinal: true,
          forceSyntheticClient: true,
          operatorRoleActor: { kind: "system" },
          resolveGatewayContext: () => kernel.gatewayRequestContext,
        },
      );
      const observedChild = child.then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      const childWaitEntered = createDeferred();
      const waitForAgentJob = agentJobs.waitForAgentJob;
      const waitObservation = vi
        .spyOn(agentJobs, "waitForAgentJob")
        .mockImplementation((params) => {
          const wait = waitForAgentJob(params);
          if (params.runId === descendantRunId) {
            childWaitEntered.resolve();
          }
          return wait;
        });
      // Cancellation must release the admission barrier so cleanup can join both producers.
      const releaseWaitAdmission = () => childWaitEntered.resolve();
      signal.addEventListener("abort", releaseWaitAdmission, { once: true });
      try {
        await Promise.race([
          childStarted.promise,
          observedChild.then(() => {
            throw new Error("continuation child finished before execution started");
          }),
        ]);
        await registerSubagentRun({
          runId: descendantRunId,
          childSessionKey,
          childAgentId: "main",
          sessionEntry: (await loadSessionEntryAsync(childSessionKey)).entry,
          requesterSessionKey: sessionKey,
          requesterAgentId: "main",
          requesterTurnRunId: runId,
          requesterDisplayKey: sessionKey,
          task: "synthetic continuation child",
          cleanup: "keep",
          expectsCompletionMessage: false,
        });
        // Keep both producers live until the child's registration and wait request
        // are admitted; a slow socket handshake must not hide the outstanding wait.
        await expect
          .poll(() =>
            listRunsForControllerFromRuns(loadSubagentRegistryFromSqlite(), sessionKey).some(
              (run) => run.runId === descendantRunId,
            ),
          )
          .toBe(true);
        signal.throwIfAborted();
        await childWaitEntered.promise;
        signal.throwIfAborted();
        expect(
          await kernel.gatewayInstanceRuntime.recovery.dispatchSessionMethod("chat.abort", {
            sessionKey,
            runId,
          }),
        ).toMatchObject({ aborted: true });
        expect(childAbortSignal?.aborted).toBe(true);
        if (terminalFirst) {
          expect(observedTerminal).toBe(true);
        }
        await metadataOverlap.assertCompleted();
        expect((await loadSessionEntryAsync(childSessionKey)).entry).toMatchObject({
          sessionId: childSessionId,
          label: metadataOverlap.label,
          abortedLastRun: true,
        });
      } finally {
        metadataOverlap.releaseForCleanup();
        try {
          signal.removeEventListener("abort", releaseWaitAdmission);
          waitObservation.mockRestore();
          if (source(runId) !== undefined) {
            await kernel.gatewayInstanceRuntime.recovery.dispatchSessionMethod("chat.abort", {
              sessionKey,
              runId,
            });
          }
          if (source(descendantRunId) !== undefined) {
            await kernel.gatewayInstanceRuntime.recovery.dispatchSessionMethod("chat.abort", {
              sessionKey: childSessionKey,
              runId: descendantRunId,
            });
          }
          release.resolve();
          releaseChild.resolve();
          await Promise.all([observed, observedChild]);
        } finally {
          await metadataOverlap.dispose();
        }
      }
      await settleSubagentRegistryPersistenceWork();
      expect(await observedChild).toMatchObject({
        value: { status: "timeout", stopReason: "rpc" },
      });
      // The terminal marker is durable before metadata cleanup above. Confirmed
      // requester-wide Stop then retires the child's completion obligation.
      expect(
        listRunsForControllerFromRuns(loadSubagentRegistryFromSqlite(), sessionKey).find(
          (run) => run.runId === descendantRunId,
        ),
      ).toBeUndefined();
      expect(completions()).toMatchObject([{ succeeded: 0 }]);
      expect(JSON.parse(String(completions()[0]?.outcome_json))).toMatchObject({
        reason: "cancelled",
        stopReason: "rpc",
      });
      expect(pending()).toEqual([]);
      expect(await observed).toMatchObject({ value: { status: "timeout", stopReason: "rpc" } });
      // Retire only this run's process projection to exercise the durable receipt.
      // Matching pre-admission Stop cache replay is covered separately above.
      kernel.gatewayRequestContext.dedupe.delete(`agent:${runId}`);
      expect(await dispatch()).toMatchObject({ status: "error", stopReason: "rpc" });
      await restart();
      expect(await dispatch()).toMatchObject({ status: "error", stopReason: "rpc" });
      expect(
        agentCommandMock.mock.calls.map(([input]) => {
          const command = input as AgentCommandOpts;
          return { runId: command.runId, sessionId: command.sessionId };
        }),
      ).toEqual([
        { runId, sessionId },
        { runId: descendantRunId, sessionId: childSessionId },
      ]);
    },
  );

  it.each(["resolved", "rejected", "abandoned"] as const)(
    "preserves executing private timeout facts (%s)",
    async (kind) => {
      const {
        kernel,
        sessionKey,
        runId,
        recorder,
        dispatch,
        completions,
        source,
        agentCommandMock,
      } = getFixture();
      const consumed = createDeferred<ReturnType<typeof recorder>>();
      const release = createDeferred();
      let producerReturned = false;
      agentCommandMock.mockImplementationOnce(async (input) => {
        const command = input as AgentCommandOpts;
        const operation = getCurrentSessionControllerOwner();
        if (!operation) {
          throw new Error("Missing admitted command owner");
        }
        markReplyOperationExecutionStarted(operation);
        await command.onExecutionStarted?.();
        const inputRecorder = recorder(input);
        await inputRecorder.persistApproved();
        inputRecorder.markSentToProvider?.();
        consumed.resolve(inputRecorder);
        // Hold the producer after abort so lifecycle projection cannot stand
        // in for execution settlement; abandoned work also outlives the grace.
        await release.promise;
        producerReturned = true;
        if (kind === "rejected") {
          command.abortSignal!.throwIfAborted();
        }
        return {
          payloads: [],
          meta: {
            durationMs: 1,
            aborted: true,
            stopReason: "timeout",
            timeoutPhase: "provider",
            providerStarted: true,
          },
        };
      });
      const first = dispatch();
      const observed = first.then(
        (value) => ({ value }),
        (error: unknown) => ({ error: String(error) }),
      );
      const inputRecorder = await consumed.promise;
      const active = expectDefined(source(runId), "executing controller");
      expect(isRpcSourceExecuting(active)).toBe(true);
      const releaseTerminalWrite = createDeferred();
      const terminalWrites = createPreparedLifecycleWriteTracker();
      let terminalWrite: Promise<void> | undefined;
      const prepareLifecycle = lifecycleState.prepareGatewaySessionLifecycleEvent;
      const delayedTerminalWrite =
        kind === "abandoned"
          ? vi
              .spyOn(lifecycleState, "prepareGatewaySessionLifecycleEvent")
              .mockImplementation((params) => {
                const persist = prepareLifecycle(params);
                if (params.event.runId !== runId) {
                  return persist;
                }
                return terminalWrites.track(() => releaseTerminalWrite.promise.then(persist));
              })
          : undefined;
      expect(
        chatAbort.abortChatRunById(kernel.gatewayRequestContext, {
          runId,
          sessionKey,
          expectedEntry: expectDefined(source(runId), "private source"),
          stopReason: "timeout",
        }),
      ).toEqual({ aborted: true });
      const { startGatewayMaintenanceTimers } = await import("./server-maintenance.js");
      const { createGatewayMaintenanceStateForTest } =
        await import("./test-helpers.maintenance-state.js");
      const clock = createGatewaySchedulerClock(Date.now());
      const now = vi.spyOn(Date, "now").mockImplementation(clock.clock.now);
      const timers = startGatewayMaintenanceTimers({
        ...createGatewayMaintenanceStateForTest(),
        ...kernel.gatewayRequestContext,
        scheduler: createTestGatewayScheduler(clock.clock),
        logHealth: { info: vi.fn(), error: vi.fn() },
        runWorktreeGc: async () => undefined,
        runDeliveryQueueMediaGc: async () => undefined,
        runManagedOutgoingMediaGc: async () => undefined,
      });
      try {
        await clock.advanceBy(60_000);
        expect(active.input.abortSignal.aborted).toBe(true);
        expect(active.adapter.abortStopReason).toBe("timeout");
        expect(source(runId)).toBe(active);
        expect(completions()).toEqual([]);
        if (kind === "abandoned") {
          // Keep terminal projection and execution pending beyond the old abort grace.
          await terminalWrites.accepted;
          terminalWrite = active.adapter.projectSessionTerminalPersistence;
          expect(terminalWrite).toBeInstanceOf(Promise);
          await clock.advanceBy(60_000);
          await awaitGateBeforeSettlement(
            expectDefined(inputRecorder.waitForPendingInputSettlement?.(), "input settlement"),
            expectDefined(active.adapter.projectSessionTerminalPersistence, "terminal persistence"),
            "Terminal persistence settled before its held write was released",
          );
          expect(source(runId)).toBe(active);
          expect(producerReturned).toBe(false);
          expect(active.adapter.projectSessionTerminalPending).toBe(true);
          expect(inputRecorder.getProcessingCompletion?.()).toBeUndefined();
          expect(completions()).toEqual([]);
        }
      } finally {
        await timers.stopPeriodicTasks();
        await timers.skillUsageCleanup();
        now.mockRestore();
        releaseTerminalWrite.resolve();
        release.resolve();
        try {
          await terminalWrites.drain(...(terminalWrite ? [terminalWrite] : []));
        } finally {
          delayedTerminalWrite?.mockRestore();
        }
      }
      const response = await observed;
      const rows = completions();
      const outcome = JSON.parse(String(rows[0]?.outcome_json));
      expect(response).toMatchObject({ value: { status: "timeout", stopReason: "timeout" } });
      expect(outcome).toMatchObject({ status: "timeout", stopReason: "timeout" });
      expect(
        await waitForChatAbortControllerRemoval({
          targets: [{ runId, entry: active }],
          timeoutMs: SESSION_CONTROLLER_DRAIN_TIMEOUT_MS,
        }),
      ).toBe(true);
      expect(source(runId)).toBeUndefined();
      expect(active.adapter.projectSessionTerminalPersisted).toBe(true);
      if (kind !== "rejected") {
        expect(outcome).toMatchObject({
          reason: "hard_timeout",
          timeoutPhase: "provider",
          providerStarted: true,
        });
        expect(response).toMatchObject({
          value: { timeoutPhase: "provider", providerStarted: true },
        });
      } else {
        expect(outcome.reason).toBe("timed_out");
        expect(outcome.timeoutPhase).toBeUndefined();
        expect(outcome.providerStarted).toBeUndefined();
      }
      kernel.gatewayRequestContext.dedupe.delete(`agent:${runId}`);
      agentCommandMock.mockImplementationOnce(async (input) => {
        await recorder(input).persistApproved();
        return { payloads: [], meta: { durationMs: 1, terminalReply: { disposition: "empty" } } };
      });
      expect(await dispatch()).toMatchObject({ status: "ok", inputProcessingCompleted: true });
      expect(agentCommandMock).toHaveBeenCalledTimes(2);
    },
  );
}
