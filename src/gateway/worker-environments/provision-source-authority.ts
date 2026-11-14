import { GatewayOperatorRecoveryAuthorizationError } from "../../infra/restart-recovery-errors.js";
import { restoreGatewayQueuedOperatorRecovery } from "../operator-run-recovery.js";
import type { WorkerProviderLifecycleInputOptions } from "./provider-lifecycle.types.js";
import type { WorkerEnvironmentRecord } from "./store.js";

/** Distinguishes a refused original source from a later retry caller's refusal. */
export class WorkerProvisionSourceChangedError extends Error {
  constructor(cause: unknown) {
    super("Worker creation authority changed; submit a new request.", { cause });
  }
}

export class WorkerProvisionSourceRecoveryPendingError extends Error {
  constructor(cause: unknown) {
    super("Worker creation authority recovery is pending; recovery will retry.", { cause });
  }
}

/** Stored evidence is restored by the authentication owner, never treated as a grant. */
export async function restoreWorkerProvisionSource(
  options: Pick<WorkerProviderLifecycleInputOptions, "store" | "resolveGatewayContext">,
  record: WorkerEnvironmentRecord,
  signal: AbortSignal,
  originalSource?: () => void,
) {
  if (!record.provisionSource) {
    return undefined;
  }
  const assertOwner = () => {
    signal.throwIfAborted();
    const current = options.store.get(record.environmentId);
    if (
      !current ||
      current.ownerEpoch !== record.ownerEpoch ||
      current.provisionOperationId !== record.provisionOperationId ||
      current.destroyRequestedAtMs !== null
    ) {
      throw new Error("Worker provisioning owner changed during source recovery");
    }
  };
  const wrap = (assertSource: () => void) => () => {
    assertOwner();
    try {
      assertSource();
    } catch (error) {
      signal.throwIfAborted();
      throw new WorkerProvisionSourceChangedError(error);
    }
  };
  if (originalSource) {
    // Only the invocation that committed this new intent can supply its live source.
    return { assertCurrent: wrap(originalSource), release: () => {} };
  }
  if (record.provisionSource.kind === "unavailable") {
    throw new WorkerProvisionSourceChangedError("Original source cannot be restored");
  }
  let restored: Awaited<ReturnType<typeof restoreGatewayQueuedOperatorRecovery>>;
  try {
    const context = options.resolveGatewayContext?.();
    if (!context) {
      throw new Error("Worker creation source recovery context is unavailable");
    }
    restored = await restoreGatewayQueuedOperatorRecovery({
      source: record.provisionSource,
      context,
      assertCurrent: assertOwner,
    });
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof GatewayOperatorRecoveryAuthorizationError) {
      throw new WorkerProvisionSourceChangedError(error);
    }
    // A failed identity read or an unavailable runtime context does not prove revocation.
    throw new WorkerProvisionSourceRecoveryPendingError(error);
  }
  return { assertCurrent: wrap(restored.authority.assertCurrent), release: restored.release };
}
