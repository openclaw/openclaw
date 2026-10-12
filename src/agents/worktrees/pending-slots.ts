import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { getFileLockProcessStartTime } from "../../shared/pid-alive.js";
import type { PendingWorktreeSlot } from "./pending-slots.worker.js";
import { runWorktreeRunEndCommand } from "./registry-run-end.js";
import { captureWorktreeRunEndContext } from "./run-end-lifecycle.js";
import type { ManagedWorktreeRecord, WorktreeWorkerAuthority } from "./types.js";

export async function readWorktreeSlotCount(env: NodeJS.ProcessEnv): Promise<number> {
  const context = captureWorktreeRunEndContext(env);
  const { executeOpenClawStateWorker } = await import("../../state/openclaw-state-worker-store.js");
  return await executeOpenClawStateWorker(context, {
    type: "worktrees.slotCount",
    input: undefined,
  });
}

export async function readPendingWorktrees(env: NodeJS.ProcessEnv): Promise<PendingWorktreeSlot[]> {
  const context = captureWorktreeRunEndContext(env);
  const { executeOpenClawStateWorker } = await import("../../state/openclaw-state-worker-store.js");
  return await executeOpenClawStateWorker(context, {
    type: "worktrees.pendingSlots",
    input: undefined,
  });
}

export function reservePendingWorktree(
  env: NodeJS.ProcessEnv,
  record: ManagedWorktreeRecord,
  authority: WorktreeWorkerAuthority,
): Promise<void> {
  return runWorktreeRunEndCommand(
    captureWorktreeRunEndContext(env),
    {
      type: "worktrees.reservePending",
      input: {
        value: {
          record,
          owner: {
            pid: process.pid,
            host: hostname(),
            startedAt: getFileLockProcessStartTime(process.pid),
          },
        },
        receipt: randomUUID(),
      },
    },
    authority,
  );
}

export function releasePendingWorktree(
  env: NodeJS.ProcessEnv,
  id: string,
  authority: WorktreeWorkerAuthority,
): Promise<void> {
  return runWorktreeRunEndCommand(
    captureWorktreeRunEndContext(env),
    {
      type: "worktrees.releasePending",
      input: { value: { id }, receipt: randomUUID() },
    },
    authority,
  );
}

export function recoverPendingWorktrees(
  env: NodeJS.ProcessEnv,
  authority: WorktreeWorkerAuthority,
): Promise<void> {
  return runWorktreeRunEndCommand(
    captureWorktreeRunEndContext(env),
    {
      type: "worktrees.recoverPending",
      input: { value: undefined, receipt: randomUUID() },
    },
    authority,
  );
}
