import type { createManagedHandoffLeaseStore } from "../../infra/update-managed-service-handoff-lease.js";
import { withCommandProcessScope } from "../../process/exec-spawn.js";
import type { createChildOwner } from "./update-command-executor-children.js";
import type { registerUpdateCommandGenerationOwner } from "./update-command-executor-generation.js";
import {
  revokeManagedUpdateCommandOutcome,
  type admitManagedUpdateCommandGeneration,
} from "./update-command-executor-managed.js";

/** Keep the selected reader through the original operation, including late cleanup. */
export function createUpdateCommandReadConnections() {
  let readConnection: Disposable | undefined;
  const lifetime = new DisposableStack();
  lifetime.defer(() => readConnection?.[Symbol.dispose]());
  return {
    retain(next: ReturnType<typeof createManagedHandoffLeaseStore>) {
      readConnection?.[Symbol.dispose]();
      readConnection = next.retainReadConnection();
      return next;
    },
    [Symbol.dispose]() {
      lifetime.dispose();
    },
  };
}

/** Join publication and every admitted descendant before the command scope settles. */
export async function runUpdateCommandExecutorOperation<T>(params: {
  operation: () => Promise<T>;
  managed: () => Awaited<ReturnType<typeof admitManagedUpdateCommandGeneration>> | undefined;
  generation: () => ReturnType<typeof registerUpdateCommandGenerationOwner> | undefined;
  children: ReturnType<typeof createChildOwner>;
  assertCurrent: () => void;
}) {
  let outcome: { result: T } | { error: Error };
  try {
    outcome = {
      result: await withCommandProcessScope(async () => {
        let operationOutcome: { result: T } | { error: Error };
        try {
          operationOutcome = { result: await params.operation() };
        } catch (cause) {
          operationOutcome = {
            error: cause instanceof Error ? cause : new Error("Update execution failed", { cause }),
          };
        }
        operationOutcome = await revokeManagedUpdateCommandOutcome(
          params.managed(),
          operationOutcome,
        );
        params.generation()?.closeAdmission();
        params.children.close();
        try {
          await params.generation()?.settle();
        } catch (cause) {
          operationOutcome = {
            error:
              "error" in operationOutcome && operationOutcome.error !== cause
                ? new AggregateError([operationOutcome.error, cause], "Update publication failed", {
                    cause,
                  })
                : cause instanceof Error
                  ? cause
                  : new Error("Update publication failed", { cause }),
          };
        }
        // Admitted children retain authority after the callback returns or
        // rejects. Join them before this scope stops its remaining commands.
        params.children.close();
        try {
          await params.children.settle();
          if ("result" in operationOutcome) {
            params.assertCurrent();
          }
        } catch (cause) {
          operationOutcome = {
            error:
              "error" in operationOutcome && operationOutcome.error !== cause
                ? new AggregateError([operationOutcome.error, cause], "Update cleanup failed", {
                    cause,
                  })
                : cause instanceof Error
                  ? cause
                  : new Error("Update settlement failed", { cause }),
          };
        }
        if ("error" in operationOutcome) {
          throw operationOutcome.error;
        }
        return operationOutcome.result;
      }),
    };
  } catch (cause) {
    outcome = {
      error: cause instanceof Error ? cause : new Error("Update execution failed", { cause }),
    };
  }
  return outcome;
}
