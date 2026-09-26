import { isDeepStrictEqual } from "node:util";
import type {
  createManagedHandoffLeaseStore,
  ManagedHandoffLease,
  ManagedHandoffParent,
} from "../../infra/update-managed-service-handoff-lease.js";
import type { HandoffProcessIdentity } from "../../infra/update-managed-service-handoff-schema.js";
import { UpdateCommandRecoveryPendingError } from "./update-command-recovery-error.js";

export type LegacyUpdateExecutorParent =
  | { kind: "managed"; runId: string; handoffId: string; root: string }
  | {
      kind: "package";
      identity: HandoffProcessIdentity;
      handoff?: { handoffId: string; root: string };
    };

/** Retire only this child's temporary bridge, after the lease owner proves no descendants remain. */
export function releaseLegacyPackageUpdateParent(
  store: ReturnType<typeof createManagedHandoffLeaseStore>,
  lease: ManagedHandoffLease,
  paired: ManagedHandoffLease[] = [],
): boolean {
  // The published parent is still waiting for our result, so it cannot exit
  // first. Its lifetime fenced all effects; only settled cleanup rebinds here.
  const settled = store.bind(lease, process.pid);
  return settled !== null && store.releaseAll([settled, ...paired]);
}

/** Keep a shipped parent's lifetime in the same lineage checked by native grandchildren. */
export function acquireLegacyUpdateExecutorParent(params: {
  store: ReturnType<typeof createManagedHandoffLeaseStore>;
  key: string;
  runId: string;
  parent: LegacyUpdateExecutorParent;
  childName: string;
}): {
  lease: ManagedHandoffParent;
  child: ManagedHandoffLease;
  target?: ManagedHandoffLease;
  borrowed: boolean;
} {
  const { store, key, runId, parent } = params;
  let lease: ManagedHandoffParent | undefined;
  let child: ManagedHandoffLease | undefined;
  let target: ManagedHandoffLease | undefined;
  let borrowed = parent.kind === "managed";
  try {
    if (parent.kind === "managed") {
      const found = store.read(key);
      if (
        found.kind !== "current" ||
        parent.runId !== runId ||
        parent.root !== key ||
        found.lease.owner !== parent.handoffId ||
        found.lease.version !== 2 ||
        found.lease.action.kind !== "update" ||
        found.lease.executor.pid !== process.ppid ||
        !store.isProcessIdentityCurrent(found.lease.helper) ||
        !store.isProcessIdentityCurrent(found.lease.executor) ||
        store.hasUnsettledChildren(found.lease)
      ) {
        throw new UpdateCommandRecoveryPendingError(
          "Legacy finalizer does not match its live managed parent.",
        );
      }
      lease = found.lease;
    } else {
      if (
        parent.identity.pid !== process.ppid ||
        !store.isProcessIdentityCurrent(parent.identity)
      ) {
        throw new UpdateCommandRecoveryPendingError("Legacy package updater is no longer live.");
      }
      const sourceKey = parent.handoff?.root ?? key;
      const found = store.read(sourceKey);
      if (parent.handoff) {
        const legacy = store.readLegacyParent(sourceKey, parent.identity);
        if (
          found.kind !== "unreadable" ||
          !legacy ||
          parent.handoff.handoffId !== legacy.owner ||
          !store.current(legacy)
        ) {
          throw new UpdateCommandRecoveryPendingError("Legacy managed parent binding changed.");
        }
        lease = legacy;
        borrowed = true;
      } else {
        const acquired = store.acquire(key, runId, { kind: "update" });
        if (acquired.kind !== "acquired") {
          throw new UpdateCommandRecoveryPendingError(
            "Another update executor owns this installation.",
          );
        }
        lease = acquired.lease;
        const bound = store.bind(lease, parent.identity.pid);
        if (!bound) {
          throw new UpdateCommandRecoveryPendingError("Legacy package parent binding failed.");
        }
        lease = bound;
        if (!isDeepStrictEqual(lease.executor, parent.identity)) {
          throw new UpdateCommandRecoveryPendingError("Legacy package parent identity changed.");
        }
      }
    }
    const acquiredChild = store.acquire(
      `${lease.key}/.openclaw-update-child-${params.childName}`,
      runId,
      { kind: "update" },
      false,
      lease.version === 1 ? lease : undefined,
    );
    if (acquiredChild.kind !== "acquired") {
      throw new UpdateCommandRecoveryPendingError(
        "Legacy finalizer lifetime could not be acquired.",
      );
    }
    child = acquiredChild.lease;
    if (lease.key !== key) {
      // The caller proved the active pnpm generation through the canonical
      // handoff-root owner. Keep both generations held for the whole phase.
      if (!store.current(lease)) {
        throw new UpdateCommandRecoveryPendingError("Legacy source generation changed.");
      }
      const acquired = store.acquire(key, runId, { kind: "update" });
      if (acquired.kind !== "acquired") {
        throw new UpdateCommandRecoveryPendingError("Active package generation is already owned.");
      }
      target = acquired.lease;
    }
    return { lease, child, target, borrowed };
  } catch (error) {
    if ((target && !store.release(target)) || (child && !store.release(child))) {
      throw new UpdateCommandRecoveryPendingError(
        "Legacy generation admission cleanup is pending.",
        { cause: error },
      );
    }
    if (
      !borrowed &&
      lease &&
      (lease.version === 1 || !releaseLegacyPackageUpdateParent(store, lease))
    ) {
      throw new UpdateCommandRecoveryPendingError("Legacy parent admission cleanup is pending.", {
        cause: error,
      });
    }
    throw error;
  }
}
