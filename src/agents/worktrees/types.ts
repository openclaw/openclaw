import type { SchemaContract } from "../../../packages/gateway-protocol/src/schema-contract.js";
import type {
  WorktreeBranch,
  WorktreeRecord,
  WorktreesRemoveResult,
  WorktreesRetireSnapshotParams,
} from "../../../packages/gateway-protocol/src/schema/worktrees.js";
import type { OpenClawStateAsyncLeaseContext } from "../../state/openclaw-state-lease-context.js";
import type { OpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.types.js";

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

/** gcProtection records a non-removal disposition; explicit GC retries that lifecycle. */
export type ManagedWorktreeRecord = Omit<
  SchemaContract<WorktreeRecord>,
  "ownerKind" | "runEndCleanup"
> & {
  ownerKind: ManagedWorktreeOwnerKind;
  runEndCleanup?: ManagedWorktreeRunEndCleanup;
};

export type WorktreeRegistryPredicate =
  | { kind: "activity"; id: string; lastActiveAt: number }
  | { kind: "session-owner"; id: string; sessionKey: string }
  | { kind: "record" | "binding" | "exact-snapshot"; record: ManagedWorktreeRecord }
  | {
      kind: "exact-owner";
      record: Pick<
        ManagedWorktreeRecord,
        | "id"
        | "ownerKind"
        | "ownerId"
        | "createdAt"
        | "lastActiveAt"
        | "path"
        | "branch"
        | "repoRoot"
      >;
    }
  | { kind: "removal-claim"; id: string; token: string }
  | { kind: "removal-claims"; ids: readonly string[]; token: string }
  | { kind: "projection"; id: string; ownerId: string; path: string; repoRoot: string }
  | { kind: "source-owner"; ownerId: string; id: string; path: string; repoRoot: string }
  | {
      kind: "source-record";
      id: string;
      ownerId?: string;
      repoRoot: string;
      repoFingerprint: string;
    };

export type WorktreeLeaseSet = {
  context: OpenClawStateWorkerContext;
  leases: readonly OpenClawStateAsyncLeaseContext[];
};

/** Explicit worker authority replaces the native guard, including predicate-only authority. */
export type WorktreeWorkerAuthority = {
  leaseSet?: WorktreeLeaseSet;
  assertCurrent?: () => void;
  predicates?: readonly WorktreeRegistryPredicate[];
};

type WorktreeSourceCurrent = {
  assertCurrent: () => void;
  workerAuthority?: Omit<WorktreeWorkerAuthority, "leaseSet">;
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

/** Exact retirement retains the original checkout, not merely its captured bytes. */
export type RemoveManagedWorktreeResult = Omit<SchemaContract<WorktreesRemoveResult>, "cleanup">;

export type ManagedWorktreeBranch = WorktreeBranch;

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
  orphansRetired: number;
  /** Complete recovery locations, even when individual issue details are omitted. */
  retiredCheckoutPaths: string[];
  snapshotsPruned: number;
  outcome: "completed" | "deferred" | "partial";
  /** Bounded per-worktree cleanup disposition; issueCount includes omitted entries. */
  issues: {
    id?: string;
    stage: "idle" | "templates" | "limits" | "size" | "orphans" | "snapshots";
    outcome: "failed" | "deferred" | "retired";
    reason: string;
  }[];
  issueCount: number;
  protectedCount: number;
  protectionReasons: Record<string, number>;
  /** Null when incomplete inventory or size measurements prevent a conclusion. */
  limitsSatisfied: boolean | null;
  evictions?: Partial<Record<"merged" | "squashed" | "idle-age" | "dirty-purged", number>>;
};

export type ManagedWorktreeGcReceipt = ManagedWorktreeGcResult & {
  jobId: string;
  state: "queued" | "running" | "completed" | "failed";
  startedAt: number | null;
  completedAt: number | null;
  error: string | null;
};

/** Explicit early retirement only for a snapshot whose source remains retained. */
export type RetireManagedWorktreeSnapshotParams = Omit<
  WorktreesRetireSnapshotParams,
  "expectedOwnerId"
> & {
  signal?: AbortSignal;
  commitGuard?: () => void;
};
