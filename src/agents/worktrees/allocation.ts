import {
  OpenClawStateLeaseError,
  withOpenClawStateLease,
} from "../../state/openclaw-state-lease.js";
import type { WorktreeFilesystemOptions } from "./filesystem-backend.types.js";

const WORKTREE_CREATE_LEASE_SCOPE = "core:managed-worktrees:create";
const WORKTREE_CREATE_LEASE_MS = 60_000;
const WORKTREE_CREATE_LEASE_WAIT_MS = 10 * 60_000;

export type WorktreeAllocationGuard = WorktreeFilesystemOptions & {
  rollbackGuard: () => void;
};

/** Serialize managed worktree allocations across repositories and processes. */
export async function withWorktreeAllocationLease<T>(
  params: {
    env: NodeJS.ProcessEnv;
    signal?: AbortSignal;
    commitGuard?: () => void;
  },
  run: (guard: WorktreeAllocationGuard) => Promise<T>,
): Promise<T> {
  // Disk headroom is shared across repositories. Hold one renewable lease
  // through checkout, setup, snapshots, and publication, including CLI processes.
  const acquisition = new AbortController();
  const abortAcquisition = () => acquisition.abort(params.signal?.reason);
  params.signal?.addEventListener("abort", abortAcquisition, { once: true });
  if (params.signal?.aborted) {
    abortAcquisition();
  }
  try {
    return await withOpenClawStateLease(
      {
        scope: WORKTREE_CREATE_LEASE_SCOPE,
        key: "capacity",
        database: { scope: "shared", options: { env: params.env } },
        leaseMs: WORKTREE_CREATE_LEASE_MS,
        waitMs: WORKTREE_CREATE_LEASE_WAIT_MS,
        leaseLabel: "managed worktree allocation lease",
        operationLabel: "agents.worktrees.allocation",
        signal: acquisition.signal,
      },
      async (lease) => {
        // Caller cancellation stops new work; allocation ownership survives until
        // its subprocesses and rollback settle. Lease loss still fences both.
        params.signal?.removeEventListener("abort", abortAcquisition);
        const signal = params.signal
          ? AbortSignal.any([params.signal, lease.signal])
          : lease.signal;
        try {
          const result = await run({
            signal,
            commitGuard: () => {
              lease.assertOwned();
              signal.throwIfAborted();
              params.commitGuard?.();
            },
            rollbackGuard: () => lease.assertOwned(),
          });
          signal.throwIfAborted();
          return result;
        } catch (error) {
          if (params.signal?.aborted) {
            lease.assertOwned();
            throw new OpenClawStateLeaseError(
              "managed worktree allocation lease operation was aborted",
              {
                code: "OPENCLAW_STATE_LEASE_ABORTED",
                cause: params.signal.reason,
              },
            );
          }
          throw error;
        }
      },
    );
  } finally {
    params.signal?.removeEventListener("abort", abortAcquisition);
  }
}
