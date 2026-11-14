import { materializeErrorStack } from "../../infra/error-graph-internal.js";
import type { OwnedRun, ReleasedProcess, ScopeCleanupOwner, SpawnInput } from "./types.js";

export function requiresProcessTree(scope: ScopeCleanupOwner, external: boolean): boolean {
  return scope.processTree === "required-all" || (scope.processTree === "owned-only" && !external);
}

/** Strict scopes (TUI shells, managed workers) still stop everything a command left behind. */
export function releasesOnRootExit(
  input: SpawnInput,
  cleanupOwners: readonly ScopeCleanupOwner[],
  external: boolean,
): boolean {
  return (
    input.mode === "child" &&
    input.releaseOnRootExit === true &&
    !external &&
    !cleanupOwners.some((scope) => scope.processTree === "required-all")
  );
}

export function recordScopeCleanupFailure(
  cleanupOwners: ScopeCleanupOwner[],
  error: unknown,
): void {
  // The scope and process-wide supervisor can outlive the failing callback's context.
  materializeErrorStack(error);
  for (const cleanupOwner of cleanupOwners) {
    cleanupOwner.failure ??= { error };
  }
}

/** Every matching run must hand off; otherwise the caller cancels instead. */
export async function releaseRuns(
  runs: Iterable<OwnedRun>,
  runId: string,
): Promise<ReleasedProcess[] | undefined> {
  const results = await Promise.all(
    [...runs].flatMap((run) => (run.runId === runId && run.release ? [run.release()] : [])),
  );
  return results.length > 0 && results.every(Boolean)
    ? results.flatMap((run) => run ?? [])
    : undefined;
}
