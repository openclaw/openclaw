import { AsyncLocalStorage } from "node:async_hooks";
import { expect, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../test/helpers/promise.js";
import * as killSession from "../agents/subagents/registry/subagent-control-session.js";
import * as bookkeeping from "../agents/subagents/registry/subagent-registry-lifecycle-bookkeeping.js";
import { applySessionEntryExactReplacements } from "../config/sessions/session-accessor.sqlite-replacement-projection.js";
import { runWithGatewayIndependentRootWorkAdmission } from "../process/gateway-work-admission.js";
import { runOutsideAsyncWorkScope } from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import * as writerQueue from "../shared/store-writer-queue.js";
import * as executionOwner from "../state/openclaw-agent-execution.js";
import { SQLITE_SESSION_WRITER_QUEUES } from "../state/openclaw-agent-write-admission-state.js";

export function holdMetadataThroughSubagentStop(target: {
  sessionKey: string;
  sessionId: string;
  storePath: string;
  signal: AbortSignal;
  beforeMetadata?: () => void;
}) {
  const producerScope = new AsyncLocalStorage<boolean>();
  const markerScope = new AsyncLocalStorage<boolean>();
  const nativeResultHeld = createDeferredCore();
  const releaseResult = createDeferredCore();
  const label = `concurrent metadata ${target.sessionId}`;
  let intercepted = false;
  let resultHeld = false;
  let bookkeepingReturned = false;
  let markerEnqueued = false;
  let producerPath: string | undefined;
  let releaseReason: "marker-enqueued" | "bookkeeping-error" | "cleanup" | "test-abort" | undefined;
  let producerOutcome: Promise<{ ok: true } | { ok: false; error: unknown }> | undefined;
  let disposal: Promise<void> | undefined;
  const release = (reason: NonNullable<typeof releaseReason>) => {
    releaseReason ??= reason;
    releaseResult.resolve();
  };
  const onAbort = () => release("test-abort");
  target.signal.addEventListener("abort", onAbort, { once: true });
  const writeMetadata = () =>
    applySessionEntryExactReplacements({
      agentId: "main",
      storePath: target.storePath,
      sessionKeys: [target.sessionKey],
      activeSessionKey: target.sessionKey,
      skipMaintenance: true,
      requireWriteSuccess: true,
      update(entries) {
        const row = entries.find((entry) => entry.sessionKey === target.sessionKey);
        if (!row || row.entry.sessionId !== target.sessionId || row.entry.label === label) {
          throw new Error("Concurrent metadata writer lost its original child");
        }
        return {
          result: undefined,
          replacements: [{ sessionKey: row.sessionKey, entry: { ...row.entry, label } }],
        };
      },
    });

  const runQueued = writerQueue.runQueuedStoreWrite;
  const queueSpy = vi.spyOn(writerQueue, "runQueuedStoreWrite").mockImplementation((params) => {
    if (params.queues !== SQLITE_SESSION_WRITER_QUEUES) {
      return runQueued(params);
    }
    if (producerScope.getStore() === true) {
      producerPath ??= params.storePath;
    }
    const selectingMarker =
      markerScope.getStore() === true &&
      bookkeepingReturned &&
      resultHeld &&
      releaseReason === undefined &&
      params.storePath === producerPath;
    const before = selectingMarker
      ? new Set(params.queues.get(params.storePath)?.pending ?? [])
      : undefined;
    const pending = runQueued(params);
    // Inspect only after the canonical queue has synchronously admitted its real waiter.
    if (
      before &&
      params.queues.get(params.storePath)?.pending.some((entry) => !before.has(entry))
    ) {
      markerEnqueued = true;
      release("marker-enqueued");
    }
    return pending;
  });

  const captureExecution = executionOwner.captureOpenClawAgentDatabaseExecution;
  const executionSpy = vi
    .spyOn(executionOwner, "captureOpenClawAgentDatabaseExecution")
    .mockImplementation((...args) => {
      const execution = captureExecution(...args);
      if (producerScope.getStore() !== true) {
        return execution;
      }
      // Captures return fresh borrowers, so only this producer's handle is wrapped.
      const runExisting = execution.runExisting.bind(execution);
      execution.runExisting = (source, operation, options) =>
        runExisting(
          source,
          (scope) =>
            operation({
              execute(command, commandOptions) {
                const pending = scope.execute(command, commandOptions);
                if (command.type !== "session.entries.replace" || resultHeld) {
                  return pending;
                }
                resultHeld = true;
                return pending.then(async (value) => {
                  nativeResultHeld.resolve();
                  await releaseResult.promise;
                  return value;
                });
              },
            }),
          options,
        );
      return execution;
    });

  const persistMarker = killSession.persistSubagentAbortedLastRun;
  const markerSpy = vi
    .spyOn(killSession, "persistSubagentAbortedLastRun")
    .mockImplementation((params) => {
      return params.childSessionKey === target.sessionKey &&
        params.abortedLastRun &&
        bookkeepingReturned
        ? markerScope.run(true, () => persistMarker(params))
        : persistMarker(params);
    });

  const completeBookkeeping = bookkeeping.completeCleanupBookkeeping;
  const bookkeepingSpy = vi
    .spyOn(bookkeeping, "completeCleanupBookkeeping")
    .mockImplementation(async (context, params) => {
      if (
        intercepted ||
        !params.provisionalKill ||
        params.entry.childSessionKey !== target.sessionKey
      ) {
        return completeBookkeeping(context, params);
      }
      intercepted = true;
      target.beforeMetadata?.();
      // A new root alone retains the RPC's AsyncWorkScope. This producer must not block
      // that scope while waiting for the mandatory marker which the RPC has yet to enqueue.
      const producer = runOutsideAsyncWorkScope(() =>
        runWithGatewayIndependentRootWorkAdmission(
          () => producerScope.run(true, writeMetadata),
          "test:private-completion-metadata",
          target.signal,
        ),
      );
      producerOutcome = producer.then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      try {
        await awaitGateBeforeSettlement(
          nativeResultHeld.promise,
          producer,
          "Metadata writer finished without its native-result barrier",
        );
        target.signal.throwIfAborted();
        await completeBookkeeping(context, params);
        bookkeepingReturned = true;
        // Success deliberately leaves the writer held until the real marker's FIFO enqueue.
      } catch (error) {
        release("bookkeeping-error");
        await producerOutcome;
        throw error;
      }
    });

  return {
    label,
    async assertCompleted() {
      const progress = [intercepted, resultHeld, bookkeepingReturned, markerEnqueued];
      expect(progress).toEqual([true, true, true, true]);
      expect(releaseReason).toBe("marker-enqueued");
      expect(await producerOutcome).toEqual({ ok: true });
    },
    releaseForCleanup: () => release("cleanup"),
    dispose(): Promise<void> {
      disposal ??= (async () => {
        release("cleanup");
        target.signal.removeEventListener("abort", onAbort);
        try {
          const outcome = await producerOutcome;
          if (outcome && !outcome.ok) {
            throw outcome.error;
          }
        } finally {
          for (const spy of [bookkeepingSpy, markerSpy, executionSpy, queueSpy]) {
            spy.mockRestore();
          }
          producerScope.disable();
          markerScope.disable();
        }
      })();
      return disposal;
    },
  };
}
