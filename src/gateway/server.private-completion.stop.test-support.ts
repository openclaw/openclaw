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

function observe<T>(pending: Promise<T>) {
  return pending.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
}

async function waitForStop(
  command: AgentCommandOpts,
  release: ReturnType<typeof createDeferred<void>>,
) {
  command.abortSignal!.addEventListener("abort", () => release.resolve(), { once: true });
  await release.promise;
  command.abortSignal!.throwIfAborted();
  throw new Error("operator stop must prevent further work");
}

function releaseOnAbort(signal: AbortSignal) {
  const release = createDeferred();
  signal.addEventListener("abort", () => release.resolve(), { once: true });
  return release;
}

export function registerPrivateCompletionStopTests(getFixture: () => PrivateCompletionStopFixture) {
  it.for([false, true])(
    "preserves an operator stop after private input consumption across retry and restart (terminal first=%s)",
    async (terminalFirst, { signal }) => {
      const f = getFixture();
      const { sessionKey, sessionId, runId, storePath, agentCommandMock } = f;
      const descendantRunId = `private-descendant-${f.sequence}`;
      const childSessionKey = `agent:main:subagent:${descendantRunId}`;
      const childSessionId = `${descendantRunId}-session`;
      const descendant = () =>
        listRunsForControllerFromRuns(loadSubagentRegistryFromSqlite(), sessionKey).find(
          (run) => run.runId === descendantRunId,
        );
      const abort = (key = sessionKey, id = runId) =>
        f.kernel.gatewayInstanceRuntime.recovery.dispatchSessionMethod("chat.abort", {
          sessionKey: key,
          runId: id,
        });
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
          expect(descendant()).toMatchObject({
            endedReason: "subagent-killed",
            execution: { status: "terminal" },
          });
        },
      });
      onTestFinished(() => metadataOverlap.dispose());
      const consumed = createDeferred();
      const release = releaseOnAbort(signal);
      agentCommandMock.mockImplementationOnce(async (input) => {
        const command = input as AgentCommandOpts;
        await command.onExecutionStarted?.();
        await f.recorder(input).persistApproved();
        consumed.resolve();
        return waitForStop(command, release);
      });
      const observed = observe(f.dispatch());
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
        onTestFinished(() => lock.mockRestore());
      }
      const childStarted = createDeferred();
      const releaseChild = releaseOnAbort(signal);
      let childAbortSignal: AbortSignal | undefined;
      await writeSubagentSessionEntry({
        stateDir: process.env.OPENCLAW_STATE_DIR!,
        agentId: "main",
        sessionKey: childSessionKey,
        defaultSessionId: childSessionId,
        lifecycleRevision: "private-descendant-original",
      });
      agentCommandMock.mockImplementationOnce(async (input) => {
        const command = input as AgentCommandOpts;
        expect(command).toMatchObject({ runId: descendantRunId, sessionId: childSessionId });
        childAbortSignal = command.abortSignal;
        await command.onExecutionStarted?.();
        await command.userTurnTranscriptRecorder?.persistApproved();
        childStarted.resolve();
        return waitForStop(command, releaseChild);
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
          resolveGatewayContext: () => f.kernel.gatewayRequestContext,
        },
      );
      const observedChild = observe(child);
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
      const releaseWaitAdmission = () => childWaitEntered.resolve();
      signal.addEventListener("abort", releaseWaitAdmission, { once: true });
      try {
        await awaitGateBeforeSettlement(
          childStarted.promise,
          observedChild,
          "continuation child finished before execution started",
        );
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
        await expect.poll(() => descendant() !== undefined).toBe(true);
        signal.throwIfAborted();
        await childWaitEntered.promise;
        signal.throwIfAborted();
        expect(await abort()).toMatchObject({ aborted: true });
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
          if (f.source(runId) !== undefined) {
            await abort();
          }
          if (f.source(descendantRunId) !== undefined) {
            await abort(childSessionKey, descendantRunId);
          }
          release.resolve();
          releaseChild.resolve();
          await Promise.all([observed, observedChild]);
        } finally {
          await metadataOverlap.dispose();
        }
      }
      await settleSubagentRegistryPersistenceWork();
      const stopped = { value: { status: "timeout", stopReason: "rpc" } };
      expect(await observedChild).toMatchObject(stopped);
      expect(descendant()).toBeUndefined();
      expect(f.completions()).toMatchObject([{ succeeded: 0 }]);
      expect(JSON.parse(String(f.completions()[0]?.outcome_json))).toMatchObject({
        reason: "cancelled",
        stopReason: "rpc",
      });
      expect(f.pending()).toEqual([]);
      expect(await observed).toMatchObject(stopped);
      // Retire only this run's process projection to exercise the durable receipt.
      f.kernel.gatewayRequestContext.dedupe.delete(`agent:${runId}`);
      expect(await f.dispatch()).toMatchObject({ status: "error", stopReason: "rpc" });
      await f.restart();
      expect(await f.dispatch()).toMatchObject({ status: "error", stopReason: "rpc" });
      const commands = agentCommandMock.mock.calls.map(([input]) => {
        const command = input as AgentCommandOpts;
        return { runId: command.runId, sessionId: command.sessionId };
      });
      expect(commands).toEqual([
        { runId, sessionId },
        { runId: descendantRunId, sessionId: childSessionId },
      ]);
    },
  );

  it.each(["resolved", "rejected", "abandoned"] as const)(
    "preserves executing private timeout facts (%s)",
    async (kind) => {
      const f = getFixture();
      const { kernel, sessionKey, runId } = f;
      const consumed = createDeferred<UserTurnTranscriptRecorder>();
      const release = createDeferred();
      let producerReturned = false;
      f.agentCommandMock.mockImplementationOnce(async (input) => {
        const command = input as AgentCommandOpts;
        const operation = expectDefined(getCurrentSessionControllerOwner(), "command owner");
        markReplyOperationExecutionStarted(operation);
        await command.onExecutionStarted?.();
        const inputRecorder = f.recorder(input);
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
      const observed = observe(f.dispatch());
      const inputRecorder = await consumed.promise;
      const active = expectDefined(f.source(runId), "executing controller");
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
          expectedEntry: expectDefined(f.source(runId), "private source"),
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
        runDeliveryQueueMediaGc: async () => undefined,
      });
      try {
        await clock.advanceBy(60_000);
        expect(active.input.abortSignal.aborted).toBe(true);
        expect(active.adapter.abortStopReason).toBe("timeout");
        expect(f.source(runId)).toBe(active);
        expect(f.completions()).toEqual([]);
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
          expect(f.source(runId)).toBe(active);
          expect(producerReturned).toBe(false);
          expect(active.adapter.projectSessionTerminalPending).toBe(true);
          expect(inputRecorder.getProcessingCompletion?.()).toBeUndefined();
          expect(f.completions()).toEqual([]);
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
      const outcome = JSON.parse(String(f.completions()[0]?.outcome_json));
      const timeout = { status: "timeout", stopReason: "timeout" };
      expect(response).toMatchObject({ value: timeout });
      expect(outcome).toMatchObject(timeout);
      expect(
        await waitForChatAbortControllerRemoval({
          targets: [{ runId, entry: active }],
          timeoutMs: SESSION_CONTROLLER_DRAIN_TIMEOUT_MS,
        }),
      ).toBe(true);
      expect(f.source(runId)).toBeUndefined();
      expect(active.adapter.projectSessionTerminalPersisted).toBe(true);
      if (kind !== "rejected") {
        const provider = { timeoutPhase: "provider", providerStarted: true };
        expect(outcome).toMatchObject({ reason: "hard_timeout", ...provider });
        expect(response).toMatchObject({ value: provider });
      } else {
        expect([outcome.reason, outcome.timeoutPhase, outcome.providerStarted]).toEqual([
          "timed_out",
          undefined,
          undefined,
        ]);
      }
      kernel.gatewayRequestContext.dedupe.delete(`agent:${runId}`);
      f.agentCommandMock.mockImplementationOnce(async (input) => {
        await f.recorder(input).persistApproved();
        return { payloads: [], meta: { durationMs: 1, terminalReply: { disposition: "empty" } } };
      });
      expect(await f.dispatch()).toMatchObject({ status: "ok", inputProcessingCompleted: true });
      expect(f.agentCommandMock).toHaveBeenCalledTimes(2);
    },
  );
}
