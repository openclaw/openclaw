import type { ManagedUpdateLeaseDatabaseIdentity } from "../../infra/update-managed-service-handoff-database.js";
import type { UpdateRecoveryFence } from "../../infra/update-run-recovery.js";
import type { UpdateCommandChildGrant } from "./update-command-executor-grant.js";

/** A live invocation, never a serialized claim, PID or recovered history row. */
export type UpdateCommandExecutor = {
  /** Acquire only after read-only service admission, before the first mutable phase. */
  enter(
    root: string,
    options?: { preflight?: true; serviceRoot?: string; activationTimeoutMs?: number },
  ): Promise<UpdateRecoveryFence>;
};

export type ManagedUpdateLeaseAuthority = ManagedUpdateLeaseDatabaseIdentity &
  Readonly<{ installKey: string; owner: string }>;

export type ChildPurpose = { auxiliaryPreflight?: true };
export type ChildOperation<T> = (
  grant: UpdateCommandChildGrant,
  bindChild: (pid: number) => void,
) => Promise<T>;
