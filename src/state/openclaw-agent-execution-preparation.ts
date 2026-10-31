import { AsyncLocalStorage } from "node:async_hooks";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  createSqliteWorkerOperationAdmission,
  takeSqliteWorkerOperationAdmissionAttachment,
} from "../infra/sqlite-worker-operation-admission.js";
import { createDeferredCore } from "../shared/deferred.js";
import { AgentDatabaseExecutionAdmissionClosedError } from "./agent-database-admission-error.js";
import type { AgentDeletionWorkerGuard } from "./agent-deletion-worker-contract.js";
import type { AgentDatabaseRegistryChange } from "./openclaw-agent-db-contract.js";
import type { AgentDatabaseRequestExecutionSource } from "./openclaw-agent-execution-admission-contract.js";

export function readAgentDatabaseRequestPreparation(): {
  startupJournal: boolean;
  startupCancellation?: Int32Array<SharedArrayBuffer>;
  deletion?: AgentDeletionWorkerGuard;
} {
  const attachment = takeSqliteWorkerOperationAdmissionAttachment();
  if (
    !isRecord(attachment) ||
    attachment.kind !== "agent-execution" ||
    typeof attachment.startupJournal !== "boolean"
  ) {
    throw new Error("Agent execution requires its request-local preparation facts");
  }
  return {
    startupJournal: attachment.startupJournal,
    // SAFETY: The private host admission owns this Gateway-lifetime cancellation cell.
    startupCancellation: attachment.startupCancellation as
      | Int32Array<SharedArrayBuffer>
      | undefined,
    // SAFETY: The host sends this typed guard; its live owner compares it before SQL.
    deletion: attachment.deletion as AgentDeletionWorkerGuard | undefined,
  };
}

/** Cancellation belongs to Gateway startup, never the first caller of shared preparation. */
export function agentDatabaseStartupInspectionSignal(cancellation: Int32Array): AbortSignal {
  const controller = new AbortController();
  const abort = () =>
    controller.abort(new Error("Gateway stopped during agent database inspection"));
  if (Atomics.load(cancellation, 0) !== 0) {
    abort();
  } else {
    void Promise.resolve(Atomics.waitAsync(cancellation, 0, 0).value).then(abort);
  }
  return controller.signal;
}

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
