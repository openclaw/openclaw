import type { WorkerProvider } from "../../plugins/types.js";
import type { createDedicatedNodeLeaseAttestations } from "./dedicated-node-lease-attestations.js";
import { workerEnvironmentServiceError as serviceError } from "./environment-errors.js";
import type { WorkerProviderLifecycleOptions } from "./provider-lifecycle.types.js";
import type { createWorkerProviderOwnerLifecycle } from "./provider-owner-lifecycle.js";
import type { WorkerEnvironmentRecord } from "./store.js";

export const ORPHANED_LEASE_ERROR = "Worker provider no longer recognizes the lease";

export function createWorkerLeaseInspection(
  options: Pick<WorkerProviderLifecycleOptions, "store" | "saveError" | "isStopping"> &
    Pick<
      ReturnType<typeof createWorkerProviderOwnerLifecycle>,
      "lifecycleLease" | "stopOwner" | "beginDrain" | "finishProvenDestroy" | "finishDestroy"
    > & {
      ownerSignal: AbortSignal;
      providerFor: (providerId: string) => WorkerProvider;
      dedicatedLeases: ReturnType<typeof createDedicatedNodeLeaseAttestations>;
    },
) {
  const {
    store,
    saveError,
    lifecycleLease,
    stopOwner,
    beginDrain,
    finishProvenDestroy,
    finishDestroy,
    providerFor,
    dedicatedLeases,
  } = options;
  /** Maintenance and fresh turn admission share the existing loss/cleanup owner. */
  const settleLostLease = async (
    record: WorkerEnvironmentRecord,
    provider: WorkerProvider,
    status: "destroyed" | "unknown",
    assertCurrent?: () => void,
  ) => {
    const teardownExpected = record.destroyRequestedAtMs !== null || record.state === "destroying";
    if (status === "destroyed") {
      const requested =
        record.destroyRequestedAtMs === null
          ? await store.requestDestroy({
              assertCurrent,
              environmentId: record.environmentId,
              state: record.state,
              ...(!teardownExpected
                ? {
                    terminalState: "failed",
                    lastError: "Worker environment disappeared before teardown was requested",
                  }
                : {}),
            })
          : record;
      const stopped = await stopOwner(requested, "provider-destroyed");
      const draining = await beginDrain(stopped);
      await finishProvenDestroy(draining).catch(async (error: unknown) => {
        await saveError(draining, error);
      });
      return;
    }
    if (status === "unknown") {
      // Provider loss fences placement authority before remote cleanup, which may remain
      // unreachable after node revocation. Preserve its exact attachment until stop is proven.
      const requested = teardownExpected
        ? record
        : await store.requestDestroy({
            assertCurrent,
            environmentId: record.environmentId,
            state: record.state,
            terminalState: "failed",
            lastError: ORPHANED_LEASE_ERROR,
          });
      await finishDestroy(requested, provider).catch(() => undefined);
    }
  };

  const inspectTurnLease = async (params: {
    environmentId: string;
    ownerEpoch: number;
    leaseId: string;
    assertCurrent: () => void;
    signal?: AbortSignal;
  }): Promise<void> => {
    const assertCurrent = () => {
      options.ownerSignal.throwIfAborted();
      params.signal?.throwIfAborted();
      params.assertCurrent();
      const current = store.get(params.environmentId);
      if (
        options.isStopping() ||
        !current ||
        current.ownerEpoch !== params.ownerEpoch ||
        current.leaseId !== params.leaseId ||
        current.state !== "attached" ||
        current.destroyRequestedAtMs !== null
      ) {
        throw serviceError("invalid_state", "Worker lease changed during turn admission");
      }
      return current;
    };
    const record = assertCurrent();
    const provider = providerFor(record.providerId);
    const inspection = await dedicatedLeases.inspect(
      record,
      provider,
      lifecycleLease(record, params.leaseId),
      params.signal,
    );
    assertCurrent();
    if (!inspection) {
      throw serviceError(
        "provider_failure",
        "Worker provider lease observation is unavailable; retry when provider connectivity returns.",
      );
    }
    if (inspection.status === "destroyed" || inspection.status === "unknown") {
      await settleLostLease(record, provider, inspection.status, assertCurrent);
      throw serviceError(
        "invalid_state",
        "Worker provider lease is no longer usable; recovery must finish before another turn.",
      );
    }
    if (inspection.status === "active") {
      if (record.sharedHost !== (inspection.sharedHost === true)) {
        await dedicatedLeases.reconcileSharedHost(record, params.leaseId, inspection, stopOwner);
      } else {
        dedicatedLeases.note(record, inspection.explicitlyDedicated);
      }
    }
    // Dormancy retains the same lease; the existing node admission waits for reconnect.
    assertCurrent();
  };

  return { settleLostLease, inspectTurnLease };
}
