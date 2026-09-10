import { AsyncLocalStorage } from "node:async_hooks";
import { recordAgentCleanupFailure } from "../../agents/run-cleanup-timeout.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  AsyncWorkScope,
  captureAsyncWorkTracker,
  getAsyncWorkSignal,
} from "../../shared/async-work-scope.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { redactStatusSecrets } from "../status-all/format.js";

const log = createSubsystemLogger("models/probe");

/** Probe-owned files and locks follow actual work without extending run admission. */
export async function createAuthProbeWork(signal?: AbortSignal) {
  const parent = captureAsyncWorkTracker();
  const parentSignal = getAsyncWorkSignal();
  const ready = createDeferredCore();
  const completion = createDeferredCore();
  // Register before target setup: a sibling failure can end pMap while this probe still runs.
  void parent(() => {
    ready.resolve();
    return completion.promise;
  }).catch(ready.reject);
  await ready.promise;
  const work = new AsyncWorkScope();
  const context = work.run(() => AsyncLocalStorage.snapshot());
  const abortListeners = new Map<AbortSignal, () => void>();
  for (const source of [signal, parentSignal]) {
    if (!source || abortListeners.has(source)) {
      continue;
    }
    const abort = () => context(() => work.beginClose(source.reason));
    abortListeners.set(source, abort);
    source.addEventListener("abort", abort, { once: true });
    if (source.aborted) {
      abort();
    }
  }
  return {
    run<T>(operation: () => T | Promise<T>): Promise<T> {
      return work.track(operation);
    },
    async settle(cleanup: () => Promise<void>): Promise<void> {
      const finish = async () => {
        try {
          await AsyncWorkScope.runWhenAllIdle(
            () => [work],
            () => context(() => work.drain()),
          );
          await cleanup();
        } catch (error) {
          recordAgentCleanupFailure();
          completion.reject(error);
          throw error;
        } finally {
          for (const [source, abort] of abortListeners) {
            source.removeEventListener("abort", abort);
          }
          completion.resolve();
        }
      };
      if (!work.hasPendingWork) {
        await finish();
        return;
      }
      // The reported probe can return while its caller still owns this physical cleanup.
      void finish().catch((error: unknown) => {
        log.warn(`Auth probe cleanup failed: ${redactStatusSecrets(formatErrorMessage(error))}`);
      });
    },
  };
}
