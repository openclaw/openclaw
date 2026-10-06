import { executeExistingOpenClawStateRead } from "../../state/openclaw-state-db-readonly.js";
import type { OpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.types.js";
import type { WorktreeRegistryListOptions } from "./registry-read.kernel.js";
import { captureWorktreeRunEndContext } from "./run-end-lifecycle.js";
import type {
  CreateManagedWorktreeParams,
  ManagedWorktreeOwnerKind,
  ManagedWorktreeRecord,
  ProvisionedFileState,
} from "./types.js";

export async function readLiveRegistryWorktreeByOwner(
  context: OpenClawStateWorkerContext,
  ownerKind: ManagedWorktreeOwnerKind,
  ownerId: string,
): Promise<ManagedWorktreeRecord | undefined> {
  const { executeOpenClawStateWorker } = await import("../../state/openclaw-state-worker-store.js");
  return await executeOpenClawStateWorker(context, {
    type: "worktrees.findLiveByOwner",
    input: { ownerKind, ownerId },
  });
}

export async function readRegistryWorktree(
  context: OpenClawStateWorkerContext,
  id: string,
): Promise<ManagedWorktreeRecord | undefined> {
  const { executeOpenClawStateWorker } = await import("../../state/openclaw-state-worker-store.js");
  return await executeOpenClawStateWorker(context, { type: "worktrees.get", input: { id } });
}

export async function readLiveRegistryWorktreeByPath(
  context: OpenClawStateWorkerContext,
  path: string,
): Promise<ManagedWorktreeRecord | undefined> {
  const { executeOpenClawStateWorker } = await import("../../state/openclaw-state-worker-store.js");
  return await executeOpenClawStateWorker(context, {
    type: "worktrees.findLiveByPath",
    input: { path },
  });
}

/** Resolve the exact target before lock admission without borrowing Gateway-thread SQLite. */
export async function readRegistryWorktreeForMutation(
  params: { env: NodeJS.ProcessEnv; id: string } & Pick<
    CreateManagedWorktreeParams,
    "signal" | "commitGuard"
  >,
): Promise<ManagedWorktreeRecord | undefined> {
  const assertCurrent = () => {
    params.signal?.throwIfAborted();
    params.commitGuard?.();
  };
  assertCurrent();
  const record = await readRegistryWorktree(captureWorktreeRunEndContext(params.env), params.id);
  assertCurrent();
  return record;
}

export function requireActiveWorktreeRecord(
  id: string,
  record: ManagedWorktreeRecord | undefined,
): ManagedWorktreeRecord {
  if (!record || record.removedAt !== undefined) {
    throw new Error(`unknown active worktree: ${id}`);
  }
  return record;
}

export async function readRegistryWorktrees(
  env: NodeJS.ProcessEnv,
  options: WorktreeRegistryListOptions = {},
): Promise<ManagedWorktreeRecord[]> {
  const context = captureWorktreeRunEndContext(env);
  const input = { liveOnly: options.liveOnly };
  const { executeOpenClawStateWorker } = await import("../../state/openclaw-state-worker-store.js");
  return await executeOpenClawStateWorker(context, { type: "worktrees.list", input });
}

export async function readLiveRegistryWorktreeIds(env: NodeJS.ProcessEnv): Promise<string[]> {
  const context = captureWorktreeRunEndContext(env);
  const { executeOpenClawStateWorker } = await import("../../state/openclaw-state-worker-store.js");
  return await executeOpenClawStateWorker(context, { type: "worktrees.liveIds", input: undefined });
}

export async function getRegistryWorktreeProvisionedPaths(
  env: NodeJS.ProcessEnv,
  id: string,
): Promise<string[] | undefined> {
  const context = captureWorktreeRunEndContext(env);
  const { executeOpenClawStateWorker } = await import("../../state/openclaw-state-worker-store.js");
  return await executeOpenClawStateWorker(context, {
    type: "worktrees.provisionedPaths",
    input: { id },
  });
}

export async function getRegistryWorktreeProvisionedState(
  env: NodeJS.ProcessEnv,
  id: string,
): Promise<ProvisionedFileState[] | undefined> {
  const context = captureWorktreeRunEndContext(env);
  const { executeOpenClawStateWorker } = await import("../../state/openclaw-state-worker-store.js");
  return await executeOpenClawStateWorker(context, {
    type: "worktrees.provisionedState",
    input: { id },
  });
}

export async function getRegistryWorktreeProvisionedChunk(
  env: NodeJS.ProcessEnv,
  params: { worktreeId: string; path: string; chunkIndex: number },
): Promise<Uint8Array | undefined> {
  const context = captureWorktreeRunEndContext(env);
  const input = { ...params };
  const { executeOpenClawStateWorker } = await import("../../state/openclaw-state-worker-store.js");
  return await executeOpenClawStateWorker(context, {
    type: "worktrees.provisionedChunk",
    input,
  });
}

export async function readWorktreeCleanupState(env: NodeJS.ProcessEnv) {
  const reply = await executeExistingOpenClawStateRead(
    { env },
    { type: "worktrees.cleanupState" },
    { current: true },
  );
  if (!reply) {
    return { records: [], leases: { liveScopes: [], staleScopes: [] } };
  }
  if (!reply.ok || reply.type !== "worktrees.cleanupState") {
    throw new Error("Worktree cleanup state read failed");
  }
  return reply;
}
