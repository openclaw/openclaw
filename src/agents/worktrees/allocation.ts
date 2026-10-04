import {
  collectNestedErrorCandidates,
  extractErrorCode,
} from "@openclaw/normalization-core/error-coercion";
import {
  OpenClawStateLeaseError,
  withOpenClawStateLease,
} from "../../state/openclaw-state-lease.js";
import type { WorktreeFilesystemOptions } from "./filesystem-backend.types.js";
import { captureWorktreeRunEndContext } from "./run-end-lifecycle.js";
import type { WorktreeWorkerAuthority } from "./types.js";

const WORKTREE_CREATE_LEASE_SCOPE = "core:managed-worktrees:create";
const WORKTREE_CREATE_LEASE_MS = 60_000;
const WORKTREE_CREATE_LEASE_WAIT_MS = 10 * 60_000;

export type WorktreeAllocationGuard = WorktreeFilesystemOptions & {
  rollbackGuard: () => void;
  workerAuthority?: WorktreeWorkerAuthority;
};

/** Serialize managed worktree allocations across repositories and processes. */
export async function withWorktreeAllocationLease<T>(
  params: {
    env: NodeJS.ProcessEnv;
    signal?: AbortSignal;
    commitGuard?: () => void;
    workerAuthority?: WorktreeWorkerAuthority;
  },
  run: (guard: WorktreeAllocationGuard) => Promise<T>,
): Promise<T> {
  const context = captureWorktreeRunEndContext(params.env);
  // Shared disk headroom requires holding this lease through multi-minute Git work.
  // Parent renewal (zero busy timeout, one attempt per tick) lost it under contention;
  // the worker retries contention and survives parent-thread stalls.
  const acquisition = new AbortController();
  const abortAcquisition = () => acquisition.abort(params.signal?.reason);
  params.signal?.addEventListener("abort", abortAcquisition, { once: true });
  if (params.signal?.aborted) {
    abortAcquisition();
  }
  try {
    params.commitGuard?.();
    return await withOpenClawStateLease(
      {
        scope: WORKTREE_CREATE_LEASE_SCOPE,
        key: "capacity",
        database: {
          scope: "shared",
          options: { path: context.admission.databasePath, env: context.environment },
        },
        leaseMs: WORKTREE_CREATE_LEASE_MS,
        waitMs: WORKTREE_CREATE_LEASE_WAIT_MS,
        heartbeat: "worker",
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
              context.admission.assertCurrent();
              lease.assertOwned();
              signal.throwIfAborted();
              params.commitGuard?.();
            },
            rollbackGuard: () => lease.assertOwned(),
            workerAuthority: {
              lease,
              predicates: params.workerAuthority?.predicates,
              assertCurrent: () => {
                context.admission.assertCurrent();
                signal.throwIfAborted();
                (params.workerAuthority
                  ? params.workerAuthority.assertCurrent
                  : params.commitGuard)?.();
              },
            },
          });
          signal.throwIfAborted();
          return result;
        } catch (error) {
          if (
            collectNestedErrorCandidates(error).some(
              (cause) => extractErrorCode(cause) === "outcome-unknown",
            )
          ) {
            throw error;
          }
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
