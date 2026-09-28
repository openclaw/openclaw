import { computeBackoff, sleepWithAbort } from "../infra/backoff.js";
import {
  isSqliteLockError,
  isSqliteNativeOpenFailure,
  sqliteExtendedResultCode,
} from "../infra/sqlite-error-diagnostics.js";
import { isSqliteWorkerError } from "../infra/sqlite-worker-contract.js";
import {
  OpenClawStateLeaseAcquisitionError,
  OpenClawStateLeaseError,
} from "./openclaw-state-lease-error.js";
import { STATE_LEASE_WRITE_BACKOFF } from "./openclaw-state-lease-storage.js";
import type { OpenClawStateLeaseAcquisition } from "./openclaw-state-lease-store.js";

/** Wait for recorded holders; each storage owner admits and settles its own write. */
export async function acquireOpenClawStateLease(params: {
  label: string;
  waitMs: number;
  signal?: AbortSignal;
  assertCurrent(): void;
  prepare?(this: void): void;
  acquire(assertCurrent: () => void, signal?: AbortSignal): Promise<OpenClawStateLeaseAcquisition>;
  acquired(expiresAt: number): void;
}): Promise<void> {
  const startedAt = performance.now();
  let deadline = startedAt + params.waitMs;
  let preparation = params.prepare;
  let attempt = 0;
  const cancellation = params.signal ? new AbortController() : undefined;
  let aborted: OpenClawStateLeaseAcquisitionError | undefined;
  const abort = () => {
    aborted ??= new OpenClawStateLeaseAcquisitionError(
      params.label,
      {
        kind: "aborted",
        reason: "caller-signal",
        elapsedMs: Math.max(0, Math.round(performance.now() - startedAt)),
      },
      params.signal?.reason,
    );
    cancellation?.abort(aborted);
    return aborted;
  };
  const assertCurrent = () => {
    params.assertCurrent();
    if (params.signal?.aborted) {
      throw abort();
    }
  };
  params.signal?.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      assertCurrent();
      let outcome: OpenClawStateLeaseAcquisition;
      try {
        if (preparation) {
          const prepare = preparation;
          preparation = undefined;
          prepare();
          deadline = performance.now() + params.waitMs;
        }
        outcome = await params.acquire(assertCurrent, cancellation?.signal);
      } catch (error) {
        if (
          !(
            error instanceof OpenClawStateLeaseError &&
            error.code === "OPENCLAW_STATE_LEASE_STORAGE_FAILED"
          ) &&
          !isSqliteLockError(error) &&
          !isSqliteNativeOpenFailure(error) &&
          sqliteExtendedResultCode(error) === undefined &&
          !isSqliteWorkerError(error, "unavailable") &&
          !isSqliteWorkerError(error, "overloaded") &&
          !isSqliteWorkerError(error, "closed")
        ) {
          throw error;
        }
        const failure = error instanceof OpenClawStateLeaseError ? error.cause : error;
        if (isSqliteLockError(failure)) {
          assertCurrent();
        }
        throw new OpenClawStateLeaseAcquisitionError(
          params.label,
          {
            kind: "store-unavailable",
            reason: isSqliteLockError(failure) ? "sqlite-busy" : "storage-error",
          },
          error,
        );
      }
      if (outcome.kind === "acquired") {
        // Publish cleanup custody before cancellation can reject callback entry.
        params.acquired(outcome.expiresAt);
        assertCurrent();
        return;
      }
      assertCurrent();
      const now = performance.now();
      if (now >= deadline) {
        throw new OpenClawStateLeaseAcquisitionError(params.label, outcome);
      }
      attempt += 1;
      try {
        await sleepWithAbort(
          Math.min(deadline - now, computeBackoff(STATE_LEASE_WRITE_BACKOFF, attempt)),
          params.signal,
        );
      } catch (error) {
        assertCurrent();
        throw error;
      }
    }
  } finally {
    params.signal?.removeEventListener("abort", abort);
  }
}
