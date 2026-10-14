import type {
  createManagedHandoffLeaseStore,
  ManagedHandoffLease,
  ManagedHandoffParent,
} from "../../infra/update-managed-service-handoff-lease.js";
import type { UpdateRecoveryFence } from "../../infra/update-run-recovery.js";
import { originalCancellations, preflightReleases } from "./update-command-executor-state.js";
import { UpdateCommandRecoveryPendingError } from "./update-command-recovery-error.js";

type Store = ReturnType<typeof createManagedHandoffLeaseStore>;
/** The original executor retains this record and remains the sole release owner. */
export function createUpdateCommandOriginalCancellation(params: {
  runId: string;
  signal: AbortController;
  current: () => {
    active: boolean;
    store?: Store;
    lease?: ManagedHandoffParent;
    serviceLease?: ManagedHandoffLease;
  };
  closeChildren: () => void;
}) {
  const cancellation: { successor: ReturnType<Store["cancelUpdate"]>; cause?: Error } = {
    successor: null,
  };
  return {
    get cause() {
      return cancellation.cause;
    },
    get successor() {
      return cancellation.successor;
    },
    register(fence: UpdateRecoveryFence) {
      const runId = params.runId;
      originalCancellations.set(fence, (requestedRunId, cause) => {
        const { active, store, lease, serviceLease } = params.current();
        if (
          !active ||
          requestedRunId !== runId ||
          !(cause instanceof Error) ||
          !store ||
          !lease ||
          lease.version !== 2 ||
          (serviceLease && !cancellation.successor && !store.owns(serviceLease, "executor"))
        ) {
          throw new UpdateCommandRecoveryPendingError("Original cancellation owner changed.");
        }
        const successor = store.cancelUpdate(lease, serviceLease);
        if (!successor) {
          throw new UpdateCommandRecoveryPendingError("Original cancellation generation changed.");
        }
        cancellation.successor = successor;
        cancellation.cause ??= cause;
        params.closeChildren();
        preflightReleases.delete(fence);
        params.signal.abort(cause);
      });
    },
    mergeOutcome<T>(outcome: { result: T } | { error: Error }): { result: T } | { error: Error } {
      if (!cancellation.cause) {
        return outcome;
      }
      return {
        error:
          "error" in outcome && outcome.error !== cancellation.cause
            ? new AggregateError(
                [outcome.error, cancellation.cause],
                "Update cancelled while execution failed",
                { cause: cancellation.cause },
              )
            : cancellation.cause,
      };
    },
  };
}
