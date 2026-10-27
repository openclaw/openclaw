import type { loadRuntimePluginCandidate } from "./loader-runtime-candidate.js";
import { getPluginCache } from "./plugin-cache.js";
import { PluginInventoryRetiredError } from "./plugin-instance-error.js";

type CandidateSteps = ReturnType<typeof loadRuntimePluginCandidate>;
type RunCandidate = <T>(run: () => T) => T;
export type PendingPluginPreparation = {
  id: string;
  steps: CandidateSteps;
  prepare: () => Promise<void>;
};

export function* finishPluginCandidate(
  steps: CandidateSteps,
  initialStep: IteratorResult<(() => Promise<void>) | undefined, void>,
  runCandidate: RunCandidate,
): Generator<(() => Promise<void>) | undefined, void> {
  let step = initialStep;
  while (!step.done) {
    const prepare = step.value;
    try {
      yield prepare && (() => runCandidate(prepare));
      step = runCandidate(() => steps.next());
    } catch (error) {
      step = runCandidate(() => steps.throw(error));
    }
  }
}
export function* finishPluginPreparations(
  preparing: PendingPluginPreparation[],
  runCandidate: RunCandidate,
): Generator<(() => Promise<void>) | undefined, void> {
  if (!preparing.length) {
    return;
  }
  const batch = preparing.splice(0);
  let outcomes: PromiseSettledResult<void>[] | undefined;
  // Only acquisition overlaps. Consume every result through its original candidate
  // so registration, diagnostics, and rollback retain manifest order.
  yield async () => {
    outcomes = await Promise.allSettled(
      batch.map(({ prepare }) => Promise.resolve().then(() => runCandidate(prepare))),
    );
  };
  let completed = 0;
  try {
    if (getPluginCache().retirement) {
      throw new PluginInventoryRetiredError();
    }
    for (const { steps } of batch) {
      const outcome = outcomes?.[completed];
      completed++;
      const step = runCandidate(() =>
        outcome?.status === "rejected" ? steps.throw(outcome.reason) : steps.next(),
      );
      yield* finishPluginCandidate(steps, step, runCandidate);
      yield;
      if (getPluginCache().retirement) {
        throw new PluginInventoryRetiredError();
      }
    }
  } catch (error) {
    // Prepared instances are not in registry.plugins until their continuation runs.
    // On an aborted load, let each suspended candidate roll back its own capture.
    const failures: unknown[] = [error];
    for (const { steps } of batch.slice(completed)) {
      try {
        steps.throw(new PluginInventoryRetiredError());
      } catch (cleanupError) {
        failures.push(cleanupError);
      }
    }
    if (failures.length > 1) {
      throw new AggregateError(failures, "Plugin preparation and rollback failed", {
        cause: error,
      });
    }
    throw error;
  }
}
