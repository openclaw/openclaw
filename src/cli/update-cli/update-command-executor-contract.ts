import type { UpdateRecoveryFence } from "../../infra/update-run-recovery.js";

/** A live invocation, never a serialized claim, PID or recovered history row. */
export type UpdateCommandExecutor = {
  /** Acquire only after read-only service admission, before the first mutable phase. */
  enter(
    root: string,
    options?: { preflight?: true; activationTimeoutMs?: number; serviceRoot?: string },
  ): Promise<UpdateRecoveryFence>;
};
