/**
 * Per-run lookup for the scheduled execution context. The admission owner binds
 * a context to its operational run instance; tool construction reads the
 * targets it needs. Leaf module: agent tools import it without cron's graph.
 */
import type { OperationalRunInstanceRef } from "../agents/operational-run-instance.js";
import type { ScheduledExecutionFacts } from "./execution-context.js";

const factsByRun = new WeakMap<OperationalRunInstanceRef, ScheduledExecutionFacts>();

/** Admission-only: binds an occurrence's facts to its admitted run. */
export function bindScheduledExecutionFacts(
  run: OperationalRunInstanceRef,
  facts: ScheduledExecutionFacts,
): () => void {
  factsByRun.set(run, facts);
  return () => {
    if (factsByRun.get(run) === facts) {
      factsByRun.delete(run);
    }
  };
}

/** Session keys a scheduled run's board, widget and media tools act on. */
export type ScheduledToolTargets = Readonly<{
  boardSessionKey: string;
  mediaSessionKey: string;
}>;

/**
 * Targets for the run its owner names (an admitted run context or tool options),
 * or undefined when that run was not admitted with an execution context.
 */
export function readScheduledToolTargets(
  owner: Readonly<{ operationalRunInstance?: OperationalRunInstanceRef }> | undefined,
): ScheduledToolTargets | undefined {
  const run = owner?.operationalRunInstance;
  const facts = run ? factsByRun.get(run) : undefined;
  return facts
    ? {
        boardSessionKey: facts.resources.boardSessionKey,
        mediaSessionKey: facts.resources.mediaSessionKey,
      }
    : undefined;
}
