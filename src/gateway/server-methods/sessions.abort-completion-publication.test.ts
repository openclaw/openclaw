// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { useSubagentControlFixture } from "../../agents/subagents/registry/subagent-control.test-support.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { expect, it, vi } from "vitest";
import * as lifecycleCompletion from "../../agents/subagents/registry/subagent-registry-lifecycle-completion.js";
import * as lifecycleDelivery from "../../agents/subagents/registry/subagent-registry-lifecycle-delivery.js";
import { subagentRuns } from "../../agents/subagents/registry/subagent-registry-memory.js";
import * as registryState from "../../agents/subagents/registry/subagent-registry-state.js";
import {
  registerSubagentRun,
  markSubagentRunTerminated,
} from "../../agents/subagents/registry/subagent-registry.js";
import { writeSubagentSessionEntry } from "../../agents/subagents/registry/subagent-registry.persistence.test-support.js";
import { enqueueSwarmRun, isSwarmRunActive } from "../../agents/subagents/swarm/swarm-scheduler.js";
import { loadExactSessionEntryReadOnly } from "../../config/sessions/session-accessor.js";
import { applySessionEntryExactReplacements } from "../../config/sessions/session-accessor.sqlite-replacement-projection.js";
import { emitAgentEvent } from "../../infra/agent-events.js";
import { runWithGatewayIndependentRootWorkAdmission } from "../../process/gateway-work-admission.js";
import { runOutsideAsyncWorkScope } from "../../shared/async-work-scope.js";
import { createDeferredCore } from "../../shared/deferred.js";
import * as writerQueue from "../../shared/store-writer-queue.js";
import type { AgentDatabaseExecutionScope } from "../../state/openclaw-agent-execution-native.js";
import * as executionOwner from "../../state/openclaw-agent-execution.js";
import { SQLITE_SESSION_WRITER_QUEUES } from "../../state/openclaw-agent-write-admission.js";
import * as stateOperation from "../../state/openclaw-state-worker-operation.js";

const fixture = useSubagentControlFixture();
const nativeState = await vi.importActual<typeof registryState>(
  "../../agents/subagents/registry/subagent-registry-state.js",
);

it.for(["before commit", "after commit"] as const)(
  "retains collector completion through metadata publication %s",
  async (boundary, { signal }) => {
    vi.mocked(registryState.persistSubagentRunsToDiskAsyncOrThrow).mockImplementation(
      nativeState.persistSubagentRunsToDiskAsyncOrThrow,
    );
    const runId = "completion-publication";
    const childKey = "agent:main:subagent:completion-publication";
    const sessionId = "completion-publication-session";
    const storePath = await writeSubagentSessionEntry({
      stateDir: fixture.stateDir,
      agentId: "main",
      sessionKey: childKey,
      defaultSessionId: sessionId,
    });
    await registerSubagentRun({
      runId,
      childSessionKey: childKey,
      requesterSessionKey: "agent:main:main",
      requesterAgentId: "main",
      requesterDisplayKey: "main",
      task: "complete while metadata publishes",
      cleanup: "keep",
      collect: true,
      expectsCompletionMessage: false,
    });
    await markSubagentRunTerminated({ runId, reason: "killed" });
    const delivery = subagentRuns.get(runId)!.delivery;
    let retainedDeliveryWhileQueued: boolean | undefined;
    const next = vi.fn(async () => {});
    enqueueSwarmRun({
      groupId: "completion-publication",
      runId: "next",
      start: next,
      activeRunIds: [runId],
      maxConcurrent: 1,
      onStartFailure: () => true,
    });
    const completionScope = new AsyncLocalStorage<boolean>();
    const producerScope = new AsyncLocalStorage<boolean>();
    const nativeHeld = createDeferredCore();
    const producerQueued = createDeferredCore();
    const releaseNative = createDeferredCore();
    const completionDone = createDeferredCore<{ error?: unknown }>();
    let holdingResult = false;
    let registryReceipt = false;
    let producer: Promise<void> | undefined;
    let producerOutcome: Promise<unknown> | undefined;
    const release = () => releaseNative.resolve();
    signal.addEventListener("abort", release, { once: true });
    const runQueued = writerQueue.runQueuedStoreWrite;
    vi.spyOn(writerQueue, "runQueuedStoreWrite").mockImplementation((params) => {
      const relevant = params.queues === SQLITE_SESSION_WRITER_QUEUES;
      const before = relevant
        ? new Set(params.queues.get(params.storePath)?.pending ?? [])
        : undefined;
      const result = runQueued(params);
      if (
        before &&
        params.queues.get(params.storePath)?.pending.some((entry) => !before.has(entry))
      ) {
        if (producerScope.getStore()) {
          producerQueued.resolve();
          release();
        } else if (completionScope.getStore() && holdingResult) {
          retainedDeliveryWhileQueued = subagentRuns.get(runId)?.delivery === delivery;
          release();
        }
      }
      return result;
    });
    const capture = executionOwner.captureOpenClawAgentDatabaseExecution;
    vi.spyOn(executionOwner, "captureOpenClawAgentDatabaseExecution").mockImplementation(
      (...args) => {
        const execution = capture(...args);
        if (!producerScope.getStore()) {
          return execution;
        }
        const runExisting: typeof execution.runExisting = (source, operation, options) =>
          execution.runExisting(
            source,
            (scope) => {
              const wrapped: AgentDatabaseExecutionScope = {
                execute(command, commandOptions) {
                  const pending = scope.execute(command, commandOptions);
                  if (command.type !== "session.entries.replace" || holdingResult) {
                    return pending;
                  }
                  holdingResult = true;
                  return pending.then(async (value) => {
                    nativeHeld.resolve();
                    await releaseNative.promise;
                    return value;
                  });
                },
              };
              return operation(wrapped);
            },
            options,
          );
        return new Proxy(execution, {
          get(original, key, receiver) {
            return key === "runExisting" ? runExisting : Reflect.get(original, key, receiver);
          },
        });
      },
    );
    const startProducer = () => {
      producer ??= runOutsideAsyncWorkScope(() =>
        runWithGatewayIndependentRootWorkAdmission(
          () =>
            producerScope.run(true, () =>
              applySessionEntryExactReplacements({
                agentId: "main",
                storePath,
                sessionKeys: [childKey],
                activeSessionKey: childKey,
                skipMaintenance: true,
                requireWriteSuccess: true,
                update(entries) {
                  const row = entries.find((entry) => entry.sessionKey === childKey);
                  if (!row || row.entry.sessionId !== sessionId) {
                    throw new Error("Metadata lost its child");
                  }
                  return {
                    result: undefined,
                    replacements: [
                      { sessionKey: childKey, entry: { ...row.entry, label: "metadata survived" } },
                    ],
                  };
                },
              }),
            ),
          "test:completion-pending-metadata",
          signal,
        ),
      );
      producerOutcome ??= producer.then(
        () => ({ ok: true }),
        (error: unknown) => ({ error }),
      );
    };
    const freeze = lifecycleDelivery.freezeRunResultAtCompletion;
    vi.spyOn(lifecycleDelivery, "freezeRunResultAtCompletion").mockImplementation(
      async (...args) => {
        const result = await freeze(...args);
        if (args[1].runId === runId && boundary === "before commit" && !producer) {
          startProducer();
          await nativeHeld.promise;
        }
        return result;
      },
    );
    const runState = stateOperation.runWithOpenClawStateWorkerStore;
    vi.spyOn(stateOperation, "runWithOpenClawStateWorkerStore").mockImplementation(
      (store, context, operation, ...rest) =>
        runState(
          store,
          context,
          (scope) =>
            operation({
              execute(command, options) {
                const pending = scope.execute(command, options);
                if (
                  !completionScope.getStore() ||
                  command.type !== "subagents.persistChanges" ||
                  boundary !== "after commit" ||
                  registryReceipt
                ) {
                  return pending;
                }
                registryReceipt = true;
                return pending.then(async (receipt) => {
                  startProducer();
                  await Promise.race([nativeHeld.promise, producerQueued.promise]);
                  return receipt;
                });
              },
            }),
          ...rest,
        ),
    );
    const complete = lifecycleCompletion.completeSubagentRunAttempt;
    vi.spyOn(lifecycleCompletion, "completeSubagentRunAttempt").mockImplementation(
      async (...args) => {
        try {
          await completionScope.run(true, () => complete(...args));
          completionDone.resolve({});
        } catch (error) {
          completionDone.resolve({ error });
          throw error;
        } finally {
          release();
        }
      },
    );
    try {
      emitAgentEvent({
        runId,
        sessionKey: childKey,
        sessionId,
        stream: "lifecycle",
        data: { phase: "end", aborted: true, stopReason: "aborted" },
      });
      const outcome = await completionDone.promise;
      release();
      expect(await producerOutcome).toEqual({ ok: true });
      expect(holdingResult).toBe(true);
      expect(outcome).toEqual({});
      if (boundary === "before commit") {
        expect(retainedDeliveryWhileQueued).toBe(true);
      }
      expect(isSwarmRunActive(runId)).toBe(false);
      expect(subagentRuns.get(runId)).toMatchObject({
        endedReason: "subagent-killed",
        collectorCompletion: expect.any(Object),
      });
      await fixture.settle();
      expect(next).toHaveBeenCalledOnce();
      expect(
        loadExactSessionEntryReadOnly({ storePath, sessionKey: childKey })?.entry,
      ).toMatchObject({ sessionId, label: "metadata survived" });
    } finally {
      release();
      await producerOutcome;
      signal.removeEventListener("abort", release);
      producerScope.disable();
      completionScope.disable();
    }
  },
);
