import { resolveGlobalSingleton } from "../shared/global-singleton.js";

const failurePaths = resolveGlobalSingleton(
  Symbol.for("openclaw.stateDatabaseFailurePaths"),
  () => new WeakMap<Error, string>(),
);

/** Preserve the terminal admission owner's path through worker error transport. */
export function markOpenClawStateDatabaseFailure(error: Error, pathname: string): void {
  failurePaths.set(error, pathname);
}

export function readOpenClawStateDatabaseFailurePath(error: Error): string | undefined {
  return failurePaths.get(error);
}

/** Cleanup aggregates must retain the original refusal without attributing unrelated errors. */
export function findOpenClawStateDatabaseFailure(
  error: unknown,
  pathname: string,
): Error | undefined {
  const pending = [error];
  const seen = new Set<unknown>();
  for (const current of pending) {
    if (!(current instanceof Error) || seen.has(current)) {
      continue;
    }
    seen.add(current);
    if (failurePaths.get(current) === pathname) {
      return current;
    }
    pending.push(current.cause);
    if (current instanceof AggregateError) {
      pending.push(...current.errors);
    }
  }
  return undefined;
}
