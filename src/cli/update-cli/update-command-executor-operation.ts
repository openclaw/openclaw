import { withCommandProcessScope } from "../../process/exec-spawn.js";
import type { createChildOwner } from "./update-command-executor-children.js";

const asUpdateError = (cause: unknown, message = "Update execution failed") =>
  cause instanceof Error ? cause : new Error(message, { cause });

/** Join every admitted descendant before the command scope settles. */
export async function runUpdateCommandExecutorOperation<T>(params: {
  operation: () => Promise<T>;
  children: ReturnType<typeof createChildOwner>;
  assertCurrent: () => void;
}): Promise<{ result: T } | { error: Error }> {
  try {
    return {
      result: await withCommandProcessScope(async () => {
        let operationOutcome: { result: T } | { error: Error };
        try {
          operationOutcome = { result: await params.operation() };
        } catch (cause) {
          operationOutcome = { error: asUpdateError(cause) };
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
                : asUpdateError(cause, "Update settlement failed"),
          };
        }
        if ("error" in operationOutcome) {
          throw operationOutcome.error;
        }
        return operationOutcome.result;
      }),
    };
  } catch (cause) {
    return { error: asUpdateError(cause) };
  }
}
