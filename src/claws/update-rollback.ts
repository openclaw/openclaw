import { coerceErrorMessage } from "@openclaw/normalization-core";

type ClawRollbackStep =
  | (() => Promise<void>)
  | readonly [label: string, rollback: () => Promise<void>];

export async function collectClawRollbackFailures(
  steps: readonly ClawRollbackStep[],
): Promise<string[]> {
  const failures: string[] = [];
  // Callers own step order and partial-state policy; attempt every rollback sequentially.
  for (const step of steps) {
    const rollback = typeof step === "function" ? step : step[1];
    try {
      await rollback();
    } catch (error) {
      const message = coerceErrorMessage(error);
      failures.push(typeof step === "function" ? message : `${step[0]}: ${message}`);
    }
  }
  return failures;
}

export async function rollbackClawUpdate(
  steps: Array<() => Promise<void>>,
  ErrorType: new (message: string, partial: boolean) => Error,
  partial = false,
): Promise<void> {
  const failures = await collectClawRollbackFailures(steps.toReversed());
  if (failures.length > 0) {
    throw new ErrorType(failures.join("; "), partial);
  }
}
