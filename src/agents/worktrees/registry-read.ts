import { executeExistingOpenClawStateRead } from "../../state/openclaw-state-db-readonly.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.types.js";
import type { ManagedWorktreeRecord, ProvisionedFileState } from "./types.js";

export async function readRegistryWorktree(
  context: OpenClawStateWorkerContext,
  id: string,
): Promise<ManagedWorktreeRecord | undefined> {
  const { executeOpenClawStateWorker } = await import("../../state/openclaw-state-worker-store.js");
  return await executeOpenClawStateWorker(context, { type: "worktrees.get", input: { id } });
}

export async function readRegistryWorktrees(
  env: NodeJS.ProcessEnv,
): Promise<ManagedWorktreeRecord[]> {
  const context = captureOpenClawStateWorkerContext({ env });
  const { executeOpenClawStateWorker } = await import("../../state/openclaw-state-worker-store.js");
  return await executeOpenClawStateWorker(context, { type: "worktrees.list", input: undefined });
}

export async function readLiveRegistryWorktreeIds(env: NodeJS.ProcessEnv): Promise<string[]> {
  const context = captureOpenClawStateWorkerContext({ env });
  const { executeOpenClawStateWorker } = await import("../../state/openclaw-state-worker-store.js");
  return await executeOpenClawStateWorker(context, { type: "worktrees.liveIds", input: undefined });
}

export async function getRegistryWorktreeProvisionedPaths(
  env: NodeJS.ProcessEnv,
  id: string,
): Promise<string[] | undefined> {
  const context = captureOpenClawStateWorkerContext({ env });
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
  const context = captureOpenClawStateWorkerContext({ env });
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
  const context = captureOpenClawStateWorkerContext({ env });
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
