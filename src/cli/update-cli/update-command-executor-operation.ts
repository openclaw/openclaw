import { withCommandProcessScope } from "../../process/exec-spawn.js";
import type { createChildOwner } from "./update-command-executor-children.js";

/** Join every admitted descendant before the command scope settles. */
export async function runUpdateCommandExecutorOperation<T>(params: {
  operation: () => Promise<T>;
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
