import { AsyncLocalStorage } from "node:async_hooks";
import { createSqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
import { createDeferredCore } from "../shared/deferred.js";
import { AgentDatabaseExecutionAdmissionClosedError } from "./agent-database-admission-error.js";
import type { AgentDatabaseRegistryChange } from "./openclaw-agent-db-contract.js";
import type { AgentDatabaseRequestExecutionSource } from "./openclaw-agent-execution-admission-contract.js";

/** Physical preparation outlives individual waits; registry notifications retain caller context. */
export function createSharedAgentDatabasePreparation(assertCurrent: () => void) {
  const pending = new Set<Promise<void>>();
  let pendingNativeOpen: Promise<void> | undefined;
  const observers = new Set<{
    assertCurrent: () => void;
    notify: (change: AgentDatabaseRegistryChange) => void;
  }>();
  const changes: AgentDatabaseRegistryChange[] = [];
  const source: AgentDatabaseRequestExecutionSource = {
    assertCurrent() {
      assertCurrent();
      let refused: { error: unknown } | undefined;
      for (const observer of observers) {
        try {
          observer.assertCurrent();
          return;
        } catch (error) {
          refused ??= { error };
        }
      }
      if (refused) {
        throw refused.error;
      }
      throw new AgentDatabaseExecutionAdmissionClosedError(
        "Agent database preparation has no current caller",
      );
    },
    onRegistryChange(change) {
      changes.push(change);
      for (const observer of observers) {
        observer.notify(change);
      }
    },
    createAdmission: (binding) => () => ({
      nativeLocations: binding.nativeLocations,
      admission: createSqliteWorkerOperationAdmission((request, grant) => {
        binding.authorize(request);
        if (!grant()) {
          throw new Error("Agent database shared opening admission expired");
        }
      }, binding.attachment),
    }),
  };
  return {
    source,
    retain() {
      const preparation = createDeferredCore();
      pending.add(preparation.promise);
      return () => {
        pending.delete(preparation.promise);
        preparation.resolve();
      };
    },
    beginNativeOpen() {
      const opening = createDeferredCore();
      pendingNativeOpen = opening.promise;
      return () => {
        pendingNativeOpen = undefined;
        opening.resolve();
      };
    },
    getPendingNativeOpen: () => pendingNativeOpen,
    getPendingPreparation: () => {
      if (pending.size === 0) {
        return undefined;
      }
      return (async () => {
        while (pending.size > 0) {
          await Promise.all(pending);
        }
      })();
    },
    follow(caller: AgentDatabaseRequestExecutionSource, assertCallerCurrent: () => void) {
      const inCaller = AsyncLocalStorage.snapshot();
      let failure: { error: unknown } | undefined;
      const notify = (change: AgentDatabaseRegistryChange) => {
        try {
          inCaller(() => caller.onRegistryChange?.(change));
        } catch (error) {
          failure = { error };
        }
      };
      for (const change of changes) {
        notify(change);
      }
      const observer = { notify, assertCurrent: () => inCaller(assertCallerCurrent) };
      observers.add(observer);
      return {
        assertPublished() {
          if (failure) {
            throw failure.error;
          }
        },
        release() {
          observers.delete(observer);
        },
      };
    },
  };
}
