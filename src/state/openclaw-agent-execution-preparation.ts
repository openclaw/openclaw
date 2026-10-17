import { AsyncLocalStorage } from "node:async_hooks";
import { createSqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
import type { AgentDatabaseRegistryChange } from "./openclaw-agent-db-contract.js";
import type { AgentDatabaseRequestExecutionSource } from "./openclaw-agent-execution-admission-contract.js";

/** Physical preparation outlives individual waits; registry notifications retain caller context. */
export function createSharedAgentDatabasePreparation(assertCurrent: () => void) {
  const observers = new Set<(change: AgentDatabaseRegistryChange) => void>();
  const changes: AgentDatabaseRegistryChange[] = [];
  const source: AgentDatabaseRequestExecutionSource = {
    assertCurrent,
    onRegistryChange(change) {
      changes.push(change);
      for (const notify of observers) {
        notify(change);
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
    follow(caller: AgentDatabaseRequestExecutionSource) {
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
      observers.add(notify);
      return {
        assertPublished() {
          if (failure) {
            throw failure.error;
          }
        },
        release() {
          observers.delete(notify);
        },
      };
    },
  };
}
