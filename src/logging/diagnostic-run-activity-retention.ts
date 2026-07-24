type SequencedRunEvent = {
  runId?: string;
  seq?: number;
};

type CompletedRunEvent = {
  runId: string;
  seq: number;
};

type DiagnosticRunActivityRetentionOptions<Activity> = {
  activities: Set<Activity>;
  deleteActivity: (activity: Activity) => void;
  hasPendingRunEvent: (event: CompletedRunEvent) => boolean;
  isIdle: (activity: Activity) => boolean;
  lastProgressAt: (activity: Activity) => number;
};

const SESSION_ACTIVITY_TTL_MS = 30 * 60 * 1000;
const SESSION_ACTIVITY_PRUNE_INTERVAL_MS = 60 * 1000;
const SESSION_ACTIVITY_MAX_ENTRIES = 2000;
const RUN_COMPLETION_TOMBSTONE_TTL_MS = 30 * 60 * 1000;
const RUN_COMPLETION_TOMBSTONE_MAX_ENTRIES = 10_000;

export function createDiagnosticRunActivityRetention<Activity>(
  options: DiagnosticRunActivityRetentionOptions<Activity>,
) {
  const completedRunTombstones = new Map<string, { completedAt: number; sequence: number }>();
  let lastPruneAt = 0;

  function canEvictCompletedRunTombstone(runId: string, sequence: number): boolean {
    return !options.hasPendingRunEvent({ runId, seq: sequence });
  }

  function pruneCompletedRunTombstones(now: number, pruneExpired: boolean): void {
    if (pruneExpired) {
      for (const [runId, tombstone] of completedRunTombstones) {
        if (
          now - tombstone.completedAt > RUN_COMPLETION_TOMBSTONE_TTL_MS &&
          canEvictCompletedRunTombstone(runId, tombstone.sequence)
        ) {
          completedRunTombstones.delete(runId);
        }
      }
    }
    const excess = completedRunTombstones.size - RUN_COMPLETION_TOMBSTONE_MAX_ENTRIES;
    if (excess <= 0) {
      return;
    }
    let removed = 0;
    for (const [runId, tombstone] of completedRunTombstones) {
      if (!canEvictCompletedRunTombstone(runId, tombstone.sequence)) {
        continue;
      }
      completedRunTombstones.delete(runId);
      removed += 1;
      if (removed >= excess) {
        break;
      }
    }
  }

  function prune(now = Date.now(), force = false): void {
    const pruneIntervalElapsed = now - lastPruneAt >= SESSION_ACTIVITY_PRUNE_INTERVAL_MS;
    const shouldPruneForSize =
      options.activities.size > SESSION_ACTIVITY_MAX_ENTRIES ||
      completedRunTombstones.size > RUN_COMPLETION_TOMBSTONE_MAX_ENTRIES;
    if (!force && !shouldPruneForSize && !pruneIntervalElapsed) {
      return;
    }
    lastPruneAt = now;
    pruneCompletedRunTombstones(now, force || pruneIntervalElapsed);

    for (const activity of options.activities) {
      if (
        options.isIdle(activity) &&
        now - options.lastProgressAt(activity) > SESSION_ACTIVITY_TTL_MS
      ) {
        options.deleteActivity(activity);
      }
    }

    const excess = options.activities.size - SESSION_ACTIVITY_MAX_ENTRIES;
    if (excess <= 0) {
      return;
    }
    const idleActivities = Array.from(options.activities)
      .filter(options.isIdle)
      .toSorted((a, b) => options.lastProgressAt(a) - options.lastProgressAt(b));
    for (let index = 0; index < excess; index += 1) {
      const activity = idleActivities[index];
      if (!activity) {
        break;
      }
      options.deleteActivity(activity);
    }
  }

  return {
    isCompletedRunEvent(event: SequencedRunEvent): boolean {
      if (!event.runId) {
        return false;
      }
      const tombstone = completedRunTombstones.get(event.runId);
      return Boolean(tombstone && (event.seq === undefined || event.seq <= tombstone.sequence));
    },
    prune,
    recordRunCompleted(event: CompletedRunEvent, now = Date.now()): void {
      completedRunTombstones.delete(event.runId);
      if (!options.hasPendingRunEvent(event)) {
        return;
      }
      completedRunTombstones.set(event.runId, { completedAt: now, sequence: event.seq });
    },
    reset(): void {
      completedRunTombstones.clear();
      lastPruneAt = 0;
    },
  };
}
