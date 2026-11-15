// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { useSubagentControlFixture } from "../../agents/subagents/registry/subagent-control.test-support.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { expect, it, vi } from "vitest";
import {
  controlMetadataProducer,
  createControlRunFixture,
  enqueueControlRun,
  holdControlSessionPublication,
} from "../../agents/subagents/registry/subagent-control.fixtures.test-support.js";
import * as lifecycleCompletion from "../../agents/subagents/registry/subagent-registry-lifecycle-completion.js";
import * as lifecycleDelivery from "../../agents/subagents/registry/subagent-registry-lifecycle-delivery.js";
import { subagentRuns } from "../../agents/subagents/registry/subagent-registry-memory.js";
import { markSubagentRunTerminated } from "../../agents/subagents/registry/subagent-registry.js";
import { isSwarmRunActive } from "../../agents/subagents/swarm/swarm-scheduler.js";
import { loadExactSessionEntryReadOnly } from "../../config/sessions/session-accessor.js";
import { emitAgentEvent } from "../../infra/agent-events.js";
import { createDeferredCore } from "../../shared/deferred.js";
import * as writerQueue from "../../shared/store-writer-queue.js";
import { SQLITE_SESSION_WRITER_QUEUES } from "../../state/openclaw-agent-write-admission-state.js";
import * as stateOperation from "../../state/openclaw-state-worker-operation.js";

const fixture = useSubagentControlFixture();
const runs = createControlRunFixture(() => fixture.stateDir);

it.for(["before commit", "after commit"] as const)(
  "retains collector completion through metadata publication %s",
  async (boundary, { signal }) => {
    const runId = "completion-publication";
    const {
      sessionKey: childKey,
      sessionId,
      storePath,
    } = await runs.seed(runId, { collect: true });
    await markSubagentRunTerminated({ runId, reason: "killed" });
    const delivery = subagentRuns.get(runId)!.delivery;
    let retainedDeliveryWhileQueued: boolean | undefined;
    const next = vi.fn(async () => {});
    enqueueControlRun(runId, "next", [runId], next);
    const completionScope = new AsyncLocalStorage<boolean>();
    const producerQueued = createDeferredCore();
    const completionDone = createDeferredCore<{ error?: unknown }>();
    const held = holdControlSessionPublication({
      signal,
      consumerScope: completionScope,
      onJoined: () => {
        retainedDeliveryWhileQueued = subagentRuns.get(runId)?.delivery === delivery;
        held.release();
      },
    });
    const { producerScope, nativeHeld, release, state } = held;
    let registryReceipt = false;
    const producer = controlMetadataProducer(
      held,
      { storePath, sessionKey: childKey, sessionId },
      signal,
    );
    let producerStart: Promise<unknown> | undefined;
    const runQueued = vi.mocked(writerQueue.runQueuedStoreWrite).getMockImplementation()!;
    vi.spyOn(writerQueue, "runQueuedStoreWrite").mockImplementation((params) => {
      const relevant = producerScope.getStore() && params.queues === SQLITE_SESSION_WRITER_QUEUES;
      const before = relevant
        ? new Set(params.queues.get(params.storePath)?.pending ?? [])
        : undefined;
      const result = runQueued(params);
      if (
        before &&
        params.queues.get(params.storePath)?.pending.some((entry) => !before.has(entry))
      ) {
        producerQueued.resolve();
        release();
      }
      return result;
    });
    const startProducer = () => {
      producerStart ??= producer.start().catch((error: unknown) => ({ error }));
    };
    const captureResult = lifecycleDelivery.captureSubagentRunResult;
    vi.spyOn(lifecycleDelivery, "captureSubagentRunResult").mockImplementation(async (...args) => {
      const result = await captureResult(...args);
      if (args[1].runId === runId && boundary === "before commit" && !producerStart) {
        startProducer();
        await nativeHeld.promise;
      }
      return result;
    });
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
      expect(await producerStart).toBeUndefined();
      expect(await producer.outcome).toEqual({ ok: true });
      expect(state.holdingResult).toBe(true);
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
      await producerStart;
      await producer.outcome;
      held.dispose();
    }
  },
);
