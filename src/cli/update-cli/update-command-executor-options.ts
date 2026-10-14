import { resolveUpdateInstallRoot } from "../../infra/update-install-root.js";
import type { UpdateRecoveryFence } from "../../infra/update-run-recovery.js";
import type { LegacyUpdateExecutorParent } from "./update-command-executor-legacy.js";
import type { ManagedUpdateLeaseAuthority } from "./update-command-executor-state.js";
import { UpdateCommandRecoveryPendingError } from "./update-command-recovery-error.js";

export type UpdateCommandExecutorOptions =
  | ({ legacyPackageParent?: never; legacyPackageHandoff?: never } & (
      | {
          existingAuthority: Omit<ManagedUpdateLeaseAuthority, "owner">;
          legacyManagedParent?: never;
        }
      | {
          existingAuthority?: never;
          legacyManagedParent: { runId: string; handoffId: string; root: string };
        }
    ))
  | {
      existingAuthority?: never;
      legacyManagedParent?: never;
      legacyPackageParent: Extract<LegacyUpdateExecutorParent, { kind: "package" }>["identity"];
      legacyPackageHandoff?: { handoffId: string; root: string };
    };

/** A live invocation, never a serialized claim, PID or recovered history row. */
export type UpdateCommandExecutor = {
  /** Acquire only after read-only service admission, before the first mutable phase. */
  enter(
    root: string,
    options?: { preflight?: true; activationTimeoutMs?: number; serviceRoot?: string },
  ): Promise<UpdateRecoveryFence>;
};

export function resolveUpdateCommandRetainedRoot(
  root: string | undefined,
  key: string,
  recovering: boolean,
) {
  const requested = root ? resolveUpdateInstallRoot(root) : undefined;
  const distinct = requested === key ? undefined : requested;
  if (recovering && distinct) {
    throw new UpdateCommandRecoveryPendingError("Recovery cannot acquire a new service root.");
  }
  return distinct;
}
