import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { UpdateInitialStoreInvocation } from "../../infra/update-initial-store-invocation.js";
import {
  snapshotUpdateInitialStoreTransport,
  type UpdateInitialStoreTransport,
  type UpdateManagedGenerationIssuer,
} from "../../infra/update-initial-store-transport.js";
import { resolveUpdateInstallRoot } from "../../infra/update-install-root.js";
import type { UpdateRecoveryFence } from "../../infra/update-run-recovery.js";
import type { LegacyUpdateExecutorParent } from "./update-command-executor-legacy.js";
import type { ManagedUpdateLeaseAuthority } from "./update-command-executor-state.js";
import { UpdateCommandRecoveryPendingError } from "./update-command-recovery-error.js";

export type UpdateCommandExecutorOptions = {
  initialStores?: UpdateInitialStoreTransport;
  /** Existing helper control owner; native bound-child admission is still mandatory. */
  managedGeneration?: UpdateManagedGenerationIssuer;
} & (
  | {
      /** Location only: direct admission must still acquire its own live owner. */
      directOriginal: { databasePath: string };
      existingAuthority?: never;
      legacyManagedParent?: never;
      legacyPackageParent?: never;
      legacyPackageHandoff?: never;
    }
  | {
      managedGeneration: UpdateManagedGenerationIssuer;
      directOriginal?: never;
      existingAuthority?: never;
      legacyManagedParent?: never;
      legacyPackageParent?: never;
      legacyPackageHandoff?: never;
    }
  | {
      directOriginal?: never;
      existingAuthority: Omit<ManagedUpdateLeaseAuthority, "owner">;
      legacyManagedParent?: never;
      legacyPackageParent?: never;
      legacyPackageHandoff?: never;
    }
  | {
      directOriginal?: never;
      existingAuthority?: never;
      legacyManagedParent: { runId: string; handoffId: string; root: string };
      legacyPackageParent?: never;
      legacyPackageHandoff?: never;
    }
  | {
      directOriginal?: never;
      existingAuthority?: never;
      legacyManagedParent?: never;
      legacyPackageParent: Extract<LegacyUpdateExecutorParent, { kind: "package" }>["identity"];
      legacyPackageHandoff?: { handoffId: string; root: string };
    }
);

/** Admit transported stores before preparation can read or write the run ledger.
 * Pin the executor input too: later caller edits must not change the selected pair. */
export function captureUpdateCommandStoreOptions(
  input: UpdateInitialStoreInvocation | undefined,
  options?: UpdateCommandExecutorOptions,
) {
  const transport =
    options && Object.hasOwn(options, "initialStores")
      ? snapshotUpdateInitialStoreTransport(options.initialStores!)
      : undefined;
  if (
    input !== undefined &&
    transport &&
    !isDeepStrictEqual(input.selection, transport.selection)
  ) {
    throw new Error("Conflicting update initial store selections.");
  }
  return {
    invocation:
      input === undefined && transport
        ? { version: 1 as const, selection: transport.selection }
        : input,
    executor: options
      ? { ...options, ...(transport ? { initialStores: transport } : {}) }
      : undefined,
  };
}

/** A live invocation, never a serialized claim, PID or recovered history row. */
export type UpdateCommandExecutor = {
  /** Acquire only after read-only service admission, before the first mutable phase. */
  enter(
    root: string,
    options?: { preflight?: true; activationTimeoutMs?: number; serviceRoot?: string },
  ): Promise<UpdateRecoveryFence>;
};

export function captureUpdateCommandDirectLocation(options?: UpdateCommandExecutorOptions) {
  // Snapshot the explicit location before asynchronous work; invalid input never defaults.
  const directDatabasePath = options?.directOriginal?.databasePath;
  if (
    options?.directOriginal !== undefined &&
    (typeof directDatabasePath !== "string" ||
      !path.isAbsolute(directDatabasePath) ||
      options.existingAuthority !== undefined ||
      options.legacyManagedParent !== undefined ||
      options.legacyPackageParent !== undefined ||
      options.legacyPackageHandoff !== undefined)
  ) {
    throw new UpdateCommandRecoveryPendingError("Invalid direct original custody location.");
  }
  return directDatabasePath;
}

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
