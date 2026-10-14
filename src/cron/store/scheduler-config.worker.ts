import type { CronSchedulerSnapshot } from "./scheduler-actor.types.js";

const snapshots = new Map<string, CronSchedulerSnapshot>();

/** Install between commands, before any synchronous transaction starts. */
export function installCronSchedulerSnapshot(
  storeKey: string,
  snapshot: CronSchedulerSnapshot,
  databasePath: string,
): CronSchedulerSnapshot {
  const key = JSON.stringify([databasePath, storeKey]);
  const current = snapshots.get(key);
  if (!current || snapshot.version > current.version) {
    snapshots.set(key, snapshot);
    return snapshot;
  }
  return current;
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
