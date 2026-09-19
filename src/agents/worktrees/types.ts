export type ManagedWorktreeOwnerKind = "manual" | "workboard" | "session";

export type ManagedWorktreeRunEndCleanupOutcome =
  | "removed-lossless"
  | "retained-busy"
  | "retained-dirty"
  | "retained-unpushed"
  | "retained-provisioned-drift"
  | "failed";

export type ManagedWorktreeRunEndCleanup = {
  outcome: ManagedWorktreeRunEndCleanupOutcome;
  at: number;
  reason?: string;
};

export type ProvisionedFileState = {
  path: string;
  mode: number | null;
  chunks: number;
};

export type ManagedWorktreeRecord = {
  id: string;
  name: string;
  repoFingerprint: string;
  repoRoot: string;
  path: string;
  branch: string;
  baseRef: string;
  ownerKind: ManagedWorktreeOwnerKind;
  ownerId?: string;
  snapshotRef?: string;
  createdAt: number;
  lastActiveAt: number;
  removedAt?: number;
  runEndCleanup?: ManagedWorktreeRunEndCleanup;
};

type WorktreeSourceCurrent = {
  assertCurrent: () => void;
  /** Checkout custody for rollback within this callback, independent of caller/source freshness. */
  assertCheckoutCurrent?: () => void;
  signal?: AbortSignal;
};

export type WorktreeSourceStage = <T>(
  run: (current: WorktreeSourceCurrent) => T | Promise<T>,
) => Promise<T>;

export type CreateManagedWorktreeParams = {
  repoRoot: string;
  name?: string;
  /** Derived default name; collisions receive a stable numeric suffix. */
  suggestedName?: string;
  baseRef?: string;
  /** Repository-owned source cone lists; selection never requests dependency setup. */
  profiles?: string[];
  /** Verified immutable checkout point when baseRef retains the publication target. */
  checkoutCommit?: string;
  ownerKind?: ManagedWorktreeOwnerKind;
  ownerId?: string;
  // Repository Git hooks are always disabled; only the setup script runs repo-local code.
  runSetupScript?: boolean;
  /** Guest projections receive committed source, never host ignored-file provisioning. */
  provisionIgnoredFiles?: boolean;
  signal?: AbortSignal;
  onProgress?: (phase: "checkout" | "setup") => void;
  /** Synchronous caller-authority guard checked at allocation commit boundaries. */
  commitGuard?: () => void;
  /** Revalidate the selected source for one operation without retaining its guard afterward. */
  withSource?: WorktreeSourceStage;
  /** Cleanup retains checkout custody without requiring a retired source selection. */
  withRollback?: <T>(run: (assertCurrent: () => void) => Promise<T>) => Promise<T>;
};

export type CreateEmptyManagedWorktreeParams = Omit<
  CreateManagedWorktreeParams,
  "repoRoot" | "baseRef" | "checkoutCommit" | "profiles"
> & {
  ownerKind: "session";
  ownerId: string;
};

export type ManagedWorktreeCreationOutcome = {
  record: ManagedWorktreeRecord;
  /** This allocation created or restored the checkout instead of reusing a live one. */
  materialized: boolean;
};

export type RemoveManagedWorktreeResult = {
  removed: boolean;
  snapshotRef?: string;
  snapshotError?: string;
};

export type ManagedWorktreeBranch = {
  name: string;
  kind: "local" | "remote";
};

type ManagedWorktreeRepositoryStatus = "git" | "not_git" | "unavailable";

export type ManagedWorktreeBranchesResult = {
  branches: ManagedWorktreeBranch[];
  defaultBranch?: string;
  headBranch?: string;
  repositoryStatus?: ManagedWorktreeRepositoryStatus;
  branchesUnavailable?: boolean;
};

export type ManagedWorktreeGcResult = {
  removed: string[];
  orphansDeleted: number;
  snapshotsPruned: number;
};
