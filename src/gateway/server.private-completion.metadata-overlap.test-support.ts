import { AsyncLocalStorage } from "node:async_hooks";
import { expect, vi } from "vitest";
import * as killSession from "../agents/subagents/registry/subagent-control-session.js";
import * as bookkeeping from "../agents/subagents/registry/subagent-registry-lifecycle-bookkeeping.js";
import { applySessionEntryExactReplacements } from "../config/sessions/session-accessor.sqlite-replacement-projection.js";
import { runWithGatewayIndependentRootWorkAdmission } from "../process/gateway-work-admission.js";
import { runOutsideAsyncWorkScope } from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import * as writerQueue from "../shared/store-writer-queue.js";
import type { AgentDatabaseExecutionScope } from "../state/openclaw-agent-execution-contract.js";
import * as executionOwner from "../state/openclaw-agent-execution.js";
import { SQLITE_SESSION_WRITER_QUEUES } from "../state/openclaw-agent-write-admission-state.js";

export function holdMetadataThroughSubagentStop(target: {
  sessionKey: string;
  sessionId: string;
  storePath: string;
  signal: AbortSignal;
}) {
  const producerScope = new AsyncLocalStorage<boolean>();
  const markerScope = new AsyncLocalStorage<boolean>();
  const nativeResultHeld = createDeferredCore();
  const releaseResult = createDeferredCore();
  const restores: Array<() => void> = [];
  const label = `concurrent metadata ${target.sessionId}`;
  let intercepted = false;
  let resultHeld = false;
  let bookkeepingReturned = false;
  let markerEnqueued = false;
  let producerPath: string | undefined;
  let releaseReason: "marker-enqueued" | "bookkeeping-error" | "cleanup" | "test-abort" | undefined;
  let producer: Promise<void> | undefined;
  let producerOutcome: Promise<{ ok: true } | { ok: false; error: unknown }> | undefined;
  let disposal: Promise<void> | undefined;
  const release = (reason: NonNullable<typeof releaseReason>) => {
    if (releaseReason === undefined) {
      releaseReason = reason;
      releaseResult.resolve();
    }
  };
  const onAbort = () => release("test-abort");
  target.signal.addEventListener("abort", onAbort, { once: true });

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
  restores.push(() => queueSpy.mockRestore());

  const captureExecution = executionOwner.captureOpenClawAgentDatabaseExecution;
  const executionSpy = vi
    .spyOn(executionOwner, "captureOpenClawAgentDatabaseExecution")
    .mockImplementation((...args) => {
      const execution = captureExecution(...args);
      if (producerScope.getStore() !== true) {
        return execution;
      }
      const runExisting: typeof execution.runExisting = (source, operation, options) =>
        execution.runExisting(
          source,
          (scope) => {
            const wrapped: AgentDatabaseExecutionScope = {
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
    });
  restores.push(() => executionSpy.mockRestore());

  const persistMarker = killSession.persistSubagentAbortedLastRun;
  const markerSpy = vi
    .spyOn(killSession, "persistSubagentAbortedLastRun")
    .mockImplementation((params) => {
      if (
        params.childSessionKey !== target.sessionKey ||
        !params.abortedLastRun ||
        !bookkeepingReturned
      ) {
        return persistMarker(params);
      }
      return markerScope.run(true, () => persistMarker(params));
    });
  restores.push(() => markerSpy.mockRestore());

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
      // A new root alone retains the RPC's AsyncWorkScope. This producer must not block
      // that scope while waiting for the mandatory marker which the RPC has yet to enqueue.
      producer = runOutsideAsyncWorkScope(() =>
        runWithGatewayIndependentRootWorkAdmission(
          () =>
            producerScope.run(true, () =>
              applySessionEntryExactReplacements({
                agentId: "main",
                storePath: target.storePath,
                sessionKeys: [target.sessionKey],
                activeSessionKey: target.sessionKey,
                skipMaintenance: true,
                requireWriteSuccess: true,
                update(entries) {
                  const row = entries.find((entry) => entry.sessionKey === target.sessionKey);
                  if (
                    !row ||
                    row.entry.sessionId !== target.sessionId ||
                    row.entry.label === label
                  ) {
                    throw new Error("Concurrent metadata writer lost its original child");
                  }
                  return {
                    result: undefined,
                    replacements: [{ sessionKey: row.sessionKey, entry: { ...row.entry, label } }],
                  };
                },
              }),
            ),
          "test:private-completion-metadata",
          target.signal,
        ),
      );
      producerOutcome = producer.then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      try {
        await Promise.race([
          nativeResultHeld.promise,
          producer.then(() => {
            throw new Error("Metadata writer finished without its native-result barrier");
          }),
        ]);
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
  restores.push(() => bookkeepingSpy.mockRestore());

  return {
    label,
    async assertCompleted() {
      expect(intercepted).toBe(true);
      expect(resultHeld).toBe(true);
      expect(bookkeepingReturned).toBe(true);
      expect(markerEnqueued).toBe(true);
      expect(releaseReason).toBe("marker-enqueued");
      expect(await producerOutcome).toEqual({ ok: true });
    },
    releaseForCleanup() {
      release("cleanup");
    },
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
          for (const restore of restores.toReversed()) {
            restore();
          }
          producerScope.disable();
          markerScope.disable();
        }
      })();
      return disposal;
    },
  };
}
