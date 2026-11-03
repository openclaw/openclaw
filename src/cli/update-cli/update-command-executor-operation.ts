import type { UpdateRecoveryFence } from "../../infra/update-run-recovery.js";
import { hasCommandProcessCleanupError } from "../../process/exec-result.js";
import { withCommandProcessScope } from "../../process/exec-spawn.js";
import type { createChildOwner } from "./update-command-executor-children.js";
import { terminalPreparations } from "./update-command-executor-state.js";

const asUpdateError = (cause: unknown, message = "Update execution failed") =>
  cause instanceof Error ? cause : new Error(message, { cause });

type ExecutorOperation<T> = {
  operation: () => Promise<T>;
  children: ReturnType<typeof createChildOwner>;
};

/** Preparation may itself launch native work; join it before retiring the same fence. */
export async function prepareUpdateCommandExecutorTerminal<T>(
  fence: UpdateRecoveryFence,
  outcome: { result: T } | { error: unknown },
): Promise<{ result: T } | { error: unknown }> {
  const prepare = terminalPreparations.get(fence);
  terminalPreparations.delete(fence);
  if (!prepare || ("error" in outcome && hasCommandProcessCleanupError(outcome.error))) {
    return outcome;
  }
  try {
    await withCommandProcessScope(async () => {
      fence.assertCurrent();
      await prepare("error" in outcome ? outcome.error : undefined);
      fence.assertCurrent();
    });
    fence.assertCurrent();
    return outcome;
  } catch (cause) {
    return {
      error:
        "error" in outcome && outcome.error !== cause
          ? new AggregateError([outcome.error, cause], "Update terminal preparation failed", {
              cause,
            })
          : cause,
    };
  }
}

/** Join admitted descendants before the command scope settles, retaining each owner's errors. */
export function withUpdateCommandExecutorOperation<T>(
  params: ExecutorOperation<T>,
  owner: "direct" | "delegated",
): Promise<T> {
  return withCommandProcessScope(async () => {
    let outcome: { result: T } | { error: unknown };
    try {
      outcome = { result: await params.operation() };
    } catch (cause) {
      outcome = { error: owner === "direct" ? asUpdateError(cause) : cause };
    }
    params.children.close();
    try {
      await params.children.settle();
    } catch (cause) {
      outcome = {
        error:
          "error" in outcome && outcome.error !== cause
            ? new AggregateError(
                [outcome.error, cause],
                owner === "direct"
                  ? "Update cleanup failed"
                  : "Unable to finish stopping the update process and its children",
                { cause },
              )
            : owner === "direct"
              ? asUpdateError(cause, "Update settlement failed")
              : cause,
      };
    }
    if ("error" in outcome) {
      throw outcome.error;
    }
    return outcome.result;
  });
}

export async function runUpdateCommandExecutorOperation<T>(
  params: ExecutorOperation<T>,
): Promise<{ result: T } | { error: Error }> {
  try {
    return { result: await withUpdateCommandExecutorOperation(params, "direct") };
  } catch (cause) {
    return { error: asUpdateError(cause) };
  }
}
