import { withOpenClawStateLeasesWorkerAdmission } from "../../state/openclaw-state-lease-worker-owner.js";
import {
  OpenClawStateLeaseError,
  withOpenClawStateLeaseAsync,
} from "../../state/openclaw-state-lease.js";
import { WORKTREE_CREATE_LEASE_SCOPE, WORKTREE_MUTATION_LEASE_SCOPE } from "./capacity-contract.js";
import {
  createWorktreeDiskAdmission,
  WORKTREE_CAPACITY_RESERVATION_SCOPE,
  type WorktreeCapacityContentionError,
} from "./capacity.js";
import { hasWorktreeUnknownOutcome } from "./errors.js";
import type { WorktreeFilesystemOptions } from "./filesystem-backend.types.js";
import { recoverPendingWorktrees } from "./pending-slots.js";
import {
  startWorktreePreparationPhase,
  timeWorktreePreparationPhase,
} from "./preparation-timing.js";
import { captureWorktreeRunEndContext, retainWorktreeRunEndFailure } from "./run-end-lifecycle.js";
import type { WorktreeLeaseSet, WorktreeWorkerAuthority } from "./types.js";

const WORKTREE_CREATE_LEASE_MS = 60_000;
// A dependency install can take 15 minutes; contenders also wait for checkout and cleanup.
export const WORKTREE_CREATE_LEASE_WAIT_MS = 30 * 60_000;

export type WorktreeWaitBudget = { remainingMs: number };

export type WorktreeAllocationGuard = WorktreeFilesystemOptions & {
  rollbackGuard: () => void;
  waitBudget?: WorktreeWaitBudget;
  workerAuthority: WorktreeWorkerAuthority & { leaseSet: WorktreeLeaseSet };
  requireDiskSpace: ReturnType<typeof createWorktreeDiskAdmission>["requireDiskSpace"];
};

type WorktreeLeaseParams = {
  env: NodeJS.ProcessEnv;
  id?: string;
  waitBudget?: WorktreeWaitBudget;
  signal?: AbortSignal;
  commitGuard?: () => void;
  rollbackGuard?: () => void;
  workerAuthority?: WorktreeWorkerAuthority;
};

/** Serialize slot admission and count-changing maintenance across repositories and processes. */
export async function withWorktreeAllocationLease<T>(
  params: WorktreeLeaseParams,
  run: (guard: WorktreeAllocationGuard) => Promise<T>,
): Promise<T> {
  return await withWorktreeLease(params, WORKTREE_CREATE_LEASE_SCOPE, "capacity", (guard) =>
    timeWorktreePreparationPhase("reservation", async () => {
      await recoverPendingWorktrees(params.env, guard.workerAuthority);
      return params.id
        ? withWorktreeMutationLease({ ...params, ...guard, id: params.id }, run)
        : run(guard);
    }),
  );
}

/** Registered retirement owns only its checkout; disk admission accounts for concurrent writes. */
export async function withWorktreeMutationLease<T>(
  params: WorktreeLeaseParams & { id: string },
  run: (guard: WorktreeAllocationGuard) => Promise<T>,
): Promise<T> {
  return await withWorktreeLease(params, WORKTREE_MUTATION_LEASE_SCOPE, params.id, run);
}

export async function waitForWorktreeCapacity(
  error: WorktreeCapacityContentionError,
  params: WorktreeLeaseParams,
): Promise<void> {
  params.commitGuard?.();
  const waiting = startWorktreeWait(params.waitBudget);
  const finishWait = startWorktreePreparationPhase("capacityWait");
  try {
    await withOpenClawStateLeaseAsync(
      {
        scope: WORKTREE_CAPACITY_RESERVATION_SCOPE,
        key: error.reservationKey,
        leaseMs: WORKTREE_CREATE_LEASE_MS,
        waitMs: waiting.waitMs,
        signal: params.signal,
        leaseLabel: "managed worktree disk admission",
        operationLabel: "agents.worktrees.capacity-wait",
      },
      captureWorktreeRunEndContext(params.env),
      async () => {
        waiting.end();
        finishWait();
        params.commitGuard?.();
      },
    );
  } catch (acquisitionError) {
    waiting.end(acquisitionError);
    throw acquisitionError;
  } finally {
    waiting.end();
    finishWait();
  }
}

function startWorktreeWait(budget?: WorktreeWaitBudget) {
  const startedAt = performance.now();
  let active = true;
  return {
    waitMs: Math.max(0, Math.floor(budget?.remainingMs ?? WORKTREE_CREATE_LEASE_WAIT_MS)),
    end(error?: unknown) {
      if (!active) {
        return;
      }
      active = false;
      if (budget) {
        budget.remainingMs = Math.max(0, budget.remainingMs - (performance.now() - startedAt));
      }
      if (
        budget &&
        error instanceof OpenClawStateLeaseError &&
        error.code === "OPENCLAW_STATE_LEASE_HELD"
      ) {
        throw new Error(
          "Managed worktree creation timed out waiting for capacity or checkout custody; inspect openclaw worktrees list and run openclaw worktrees gc before retrying.",
          { cause: error },
        );
      }
    },
  };
}

async function withWorktreeLease<T>(
  params: WorktreeLeaseParams,
  scope: string,
  key: string,
  run: (guard: WorktreeAllocationGuard) => Promise<T>,
): Promise<T> {
  const acquisition = new AbortController();
  const abortAcquisition = () => acquisition.abort(params.signal?.reason);
  params.signal?.addEventListener("abort", abortAcquisition, { once: true });
  if (params.signal?.aborted) {
    abortAcquisition();
  }
  const waiting = startWorktreeWait(params.waitBudget);
  const finishWait = startWorktreePreparationPhase(
    scope === WORKTREE_CREATE_LEASE_SCOPE ? "allocationWait" : "mutationWait",
  );
  let finishRelease: (() => void) | undefined;
  try {
    params.commitGuard?.();
    const captured = captureWorktreeRunEndContext(params.env);
    const inherited = params.workerAuthority?.leaseSet;
    const context = inherited?.context ?? captured;
    if (context.admission.coordinationKey !== captured.admission.coordinationKey) {
      throw new Error("Managed worktree lease set belongs to another database");
    }
    return await withOpenClawStateLeaseAsync(
      {
        scope,
        key,
        leaseMs: WORKTREE_CREATE_LEASE_MS,
        waitMs: waiting.waitMs,
        heartbeat: "worker",
        leaseLabel: "managed worktree allocation lease",
        operationLabel: "agents.worktrees.allocation",
        signal: acquisition.signal,
      },
      context,
      (lease) => {
        waiting.end();
        const leaseSet: WorktreeLeaseSet = {
          context,
          leases: [...(inherited?.leases ?? []), lease],
          mutationWorktreeIds: [
            ...(inherited?.mutationWorktreeIds ?? []),
            ...(scope === WORKTREE_MUTATION_LEASE_SCOPE ? [key] : []),
          ],
        };
        return withOpenClawStateLeasesWorkerAdmission(
          leaseSet.leases,
          context,
          async (authority) => {
            finishWait();
            // Caller cancellation stops new work; ownership survives through native settlement.
            params.signal?.removeEventListener("abort", abortAcquisition);
            const signal = params.signal
              ? AbortSignal.any([params.signal, lease.signal])
              : lease.signal;
            const assertOwned = () => {
              // The lease owner checks its live phase, token custody, and shared heartbeat expiry.
              authority.assertCurrent();
            };
            const commitGuard = () => {
              assertOwned();
              signal.throwIfAborted();
              params.commitGuard?.();
            };
            const workerAuthority = {
              leaseSet,
              predicates: params.workerAuthority?.predicates,
              assertCurrent: () => {
                captured.admission.assertCurrent();
                signal.throwIfAborted();
                (params.workerAuthority
                  ? params.workerAuthority.assertCurrent
                  : params.commitGuard)?.();
              },
            };
            const capacity = createWorktreeDiskAdmission({
              env: params.env,
              workerAuthority,
              assertCurrent: commitGuard,
            });
            let releaseCapacity = true;
            try {
              const result = await run({
                signal,
                waitBudget: params.waitBudget,
                commitGuard,
                rollbackGuard: () => {
                  assertOwned();
                  params.rollbackGuard?.();
                },
                workerAuthority,
                requireDiskSpace: capacity.requireDiskSpace,
              });
              signal.throwIfAborted();
              return result;
            } catch (error) {
              if (hasWorktreeUnknownOutcome(error)) {
                releaseCapacity = false;
                retainWorktreeRunEndFailure(error);
                throw error;
              }
              if (params.signal?.aborted) {
                assertOwned();
                throw new OpenClawStateLeaseError(
                  "managed worktree allocation lease operation was aborted",
                  { code: "OPENCLAW_STATE_LEASE_ABORTED", cause: params.signal.reason },
                );
              }
              throw error;
            } finally {
              finishRelease = startWorktreePreparationPhase("leaseRelease");
              if (releaseCapacity) {
                await capacity.release();
              }
            }
          },
        );
      },
    );
  } catch (error) {
    waiting.end(error);
    throw error;
  } finally {
    waiting.end();
    finishWait();
    finishRelease?.();
    params.signal?.removeEventListener("abort", abortAcquisition);
  }
}
