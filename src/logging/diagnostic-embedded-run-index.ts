// Re-arming a work key can advance its sequence without changing Map iteration order.
export function resolveCurrentDiagnosticRun<TOwner extends { runId: string; sequence: number }>(
  owners: Iterable<TOwner>,
): TOwner | undefined {
  let currentOwner: TOwner | undefined;
  for (const owner of owners) {
    if (!currentOwner || owner.sequence > currentOwner.sequence) {
      currentOwner = owner;
    }
  }
  return currentOwner;
}

export function resolveCurrentDiagnosticRunId(
  owners: Iterable<{ runId: string; sequence: number }>,
): string | undefined {
  return resolveCurrentDiagnosticRun(owners)?.runId;
}

type EmbeddedRunActivity<TRun extends { runId: string }> = {
  activeEmbeddedRuns: Map<string, TRun>;
};

export function createDiagnosticEmbeddedRunIndex<
  TRun extends { runId: string },
  TActivity extends EmbeddedRunActivity<TRun>,
>(runIdIndex: Map<string, TActivity>) {
  const remove = (activity: TActivity, workKey: string): TRun | undefined => {
    const embeddedRun = activity.activeEmbeddedRuns.get(workKey);
    if (!embeddedRun) {
      return undefined;
    }
    activity.activeEmbeddedRuns.delete(workKey);
    const runIdStillActive = Array.from(activity.activeEmbeddedRuns.values()).some(
      (candidate) => candidate.runId === embeddedRun.runId,
    );
    if (!runIdStillActive && runIdIndex.get(embeddedRun.runId) === activity) {
      runIdIndex.delete(embeddedRun.runId);
    }
    return embeddedRun;
  };
  const clear = (activity: TActivity): void => {
    // Every local owner is leaving; only retain indexes now owned by another activity.
    for (const { runId } of activity.activeEmbeddedRuns.values()) {
      if (runIdIndex.get(runId) === activity) {
        runIdIndex.delete(runId);
      }
    }
    activity.activeEmbeddedRuns.clear();
  };
  return { clear, remove };
}
