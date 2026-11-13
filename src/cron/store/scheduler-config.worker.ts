import type { CronSchedulerSnapshot } from "./scheduler-actor.types.js";

const snapshots = new Map<string, CronSchedulerSnapshot>();

/** Install between commands, before any synchronous transaction starts. */
export function installCronSchedulerSnapshot(
  storeKey: string,
  snapshot: CronSchedulerSnapshot,
  databasePath: string,
): CronSchedulerSnapshot {
  // Config changes are best effort: the last worker command's coherent facts win.
  snapshots.set(JSON.stringify([databasePath, storeKey]), snapshot);
  return snapshot;
}

export function getCronSchedulerSnapshot(
  storeKey: string,
  databasePath: string,
): CronSchedulerSnapshot | undefined {
  return snapshots.get(JSON.stringify([databasePath, storeKey]));
}

export function removeCronSchedulerSnapshot(storeKey: string, databasePath: string): void {
  snapshots.delete(JSON.stringify([databasePath, storeKey]));
}
