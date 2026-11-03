/**
 * Carries the semantic cause a stuck-session recovery acted on (e.g.
 * `blocked_tool_call`) from the recovery path to cron run finalization, which
 * otherwise only sees a cause-free literal when the embedded run has no error
 * message.
 *
 * Keyed by the operation instance so recovery and finalization agree on identity
 * without adding state to the operation factory (the factory is under a
 * line-cap ratchet). The operation object itself is the stable key: the recovery
 * runtime and `run.ts` read the same `getCurrentSessionControllerOwner()` instance.
 */
const recoveryClassificationByOperation = new WeakMap<object, string>();

export function recordRecoveryClassification(operation: object, reason: string): void {
  recoveryClassificationByOperation.set(operation, reason);
}

export function getRecoveryClassification(operation: object): string | undefined {
  return recoveryClassificationByOperation.get(operation);
}
