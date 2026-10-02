import { worktreePathExists } from "./git.js";
import { retireMissingRegistryWorktree } from "./registry-retirement.js";
import type { ManagedWorktreeRecord } from "./types.js";

export async function reconcileListedWorktrees(
  env: NodeJS.ProcessEnv,
  records: readonly ManagedWorktreeRecord[],
  now: () => number,
): Promise<ManagedWorktreeRecord[]> {
  const listed: ManagedWorktreeRecord[] = [];
  for (const observed of records) {
    const record =
      observed.removedAt === undefined && !(await worktreePathExists(observed.path))
        ? (await retireMissingRegistryWorktree(env, observed, now())).record
        : observed;
    if (record && (record.removedAt === undefined || record.snapshotRef)) {
      listed.push(record);
    }
  }
  return listed;
}
