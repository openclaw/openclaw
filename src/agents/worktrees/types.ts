export type ManagedWorktreeOwnerKind = "manual" | "workboard" | "session";

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
};

export type CreateManagedWorktreeParams = {
  repoRoot: string;
  name?: string;
  baseRef?: string;
  ownerKind?: ManagedWorktreeOwnerKind;
  ownerId?: string;
  // Callers that pre-authorize a canonical checkout pin both values so path swaps
  // cannot change the repository between authorization and creation.
  expectedSourcePath?: string;
  expectedSourceRoot?: string;
  expectedCommonDir?: string;
  expectedFingerprint?: string;
  // False disables Git checkout hooks and .openclaw/worktree-setup.sh. Callers reachable from
  // less-privileged surfaces opt out so materialization never executes repository code.
  runSetupScript?: boolean;
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

export type ManagedWorktreeBranchesResult = {
  branches: ManagedWorktreeBranch[];
  defaultBranch?: string;
  headBranch?: string;
};

export type ManagedWorktreeGcResult = {
  removed: string[];
  orphansDeleted: number;
  snapshotsPruned: number;
};
