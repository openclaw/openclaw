import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { readGatewayLockProcessNamespace } from "../../infra/gateway-lock-payload.js";
import { getFileLockProcessStartTime } from "../../shared/pid-alive.js";
import type { PendingWorktreeSlot } from "./pending-slots.worker.js";
import { readWorktreeRegistryCommand } from "./registry-read.js";
import { runWorktreeRunEndCommand } from "./registry-run-end.js";
import { captureWorktreeRunEndContext } from "./run-end-lifecycle.js";
import type { ManagedWorktreeRecord, WorktreeWorkerAuthority } from "./types.js";

export async function readWorktreeSlotCount(env: NodeJS.ProcessEnv): Promise<number> {
  const context = captureWorktreeRunEndContext(env);
  return (
    (
      await readWorktreeRegistryCommand(context, {
        type: "worktrees.slotCount",
        input: undefined,
      })
    )?.count ?? 0
  );
}

export async function readPendingWorktrees(env: NodeJS.ProcessEnv): Promise<PendingWorktreeSlot[]> {
  const context = captureWorktreeRunEndContext(env);
  return (
    (
      await readWorktreeRegistryCommand(context, {
        type: "worktrees.pendingSlots",
        input: undefined,
      })
    )?.records ?? []
  );
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
            processNamespace: readGatewayLockProcessNamespace(),
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
