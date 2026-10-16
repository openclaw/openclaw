import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import {
  findLiveRegistryWorktreeByOwnerInDatabase,
  findLiveRegistryWorktreeByPathInDatabase,
  getRegistryWorktreeInDatabase,
  listRegistryWorktreesInDatabase,
} from "./registry-read.kernel.js";
import type { ManagedWorktreeOwnerKind, ManagedWorktreeRecord } from "./types.js";

export function getRegistryWorktree(
  env: NodeJS.ProcessEnv,
  id: string,
): ManagedWorktreeRecord | undefined {
  return getRegistryWorktreeInDatabase(openOpenClawStateDatabase({ env }).db, id);
}

export function findLiveRegistryWorktreeByOwner(
  env: NodeJS.ProcessEnv,
  ownerKind: ManagedWorktreeOwnerKind,
  ownerId: string,
): ManagedWorktreeRecord | undefined {
  return findLiveRegistryWorktreeByOwnerInDatabase(
    openOpenClawStateDatabase({ env }).db,
    ownerKind,
    ownerId,
  );
}

export function findLiveRegistryWorktreeByPath(
  env: NodeJS.ProcessEnv,
  worktreePath: string,
): ManagedWorktreeRecord | undefined {
  return findLiveRegistryWorktreeByPathInDatabase(
    openOpenClawStateDatabase({ env }).db,
    worktreePath,
  );
}

export function listRegistryWorktrees(env: NodeJS.ProcessEnv): ManagedWorktreeRecord[] {
  return listRegistryWorktreesInDatabase(openOpenClawStateDatabase({ env }).db);
}
