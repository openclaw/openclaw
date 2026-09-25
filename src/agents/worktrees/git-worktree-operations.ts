import type {
  ExactProvisionedSnapshot,
  ExactStateRetirement,
} from "./snapshot-exact-state-contract.js";
import type { ProvisionedFileState } from "./types.js";

export type GitWorktreeOperations = {
  "worktree.snapshot": {
    input: {
      worktreeId: string;
      checkoutPath: string;
      repoRoot: string;
      reason: string;
      provisionedPaths: readonly string[];
      exactState?: { branch: string; expected: ExactStateRetirement; retirementName: string };
    };
    output: {
      snapshotRef: string;
      provisionedState: ProvisionedFileState[];
      exactStateDigest?: string;
    };
  };
  "worktree.snapshot-verify-exact": {
    input: GitWorktreeOperations["worktree.snapshot"]["input"] & { expectedDigest: string };
    output: boolean;
  };
  "worktree.provisioning-inspection": {
    input: { sourceRoot: string };
    output: { paths: string[]; estimatedBytes: number };
  };
  "worktree.git-size": {
    input: { repoRoot: string; ref: string; replacementRefBase?: string };
    output: number;
  };
  "worktree.checkout-transition-size": {
    input: { repoRoot: string; baseRef: string; targetRef: string; replacementRefBase?: string };
    output: { targetBytes: number; changedBytes: number; requiresFullCheckout: boolean };
  };
  "worktree.directory-size": {
    input: { root: string; excludeGit?: boolean };
    output: number;
  };
  "worktree.cleanup-inspection": {
    input:
      | { kind: "nested-repository"; checkoutPath: string }
      | {
          kind: "lossless" | "provisioned";
          checkoutPath: string;
          provisionedPaths: readonly string[] | undefined;
        };
    output: {
      retainedReason: "dirty" | "unpushed" | "provisioned-drift" | "nested-repository" | undefined;
    };
  };
};

export type GitWorktreeOperation = {
  [K in keyof GitWorktreeOperations]: { type: K; input: GitWorktreeOperations[K]["input"] };
}[keyof GitWorktreeOperations];

export type GitWorktreeOperationResult =
  GitWorktreeOperations[keyof GitWorktreeOperations]["output"];

export type GitWorktreeEffects = {
  "worktree.assert-current": { input: Record<string, never>; output: void };
  "worktree.snapshot-capacity": {
    input: {
      demands: Array<{ path: string; bytes: number }>;
      stateBytes?: number;
      purpose: "worktree safety snapshot index" | "worktree safety snapshot";
    };
    output: void;
  };
  "worktree.snapshot-provisioned": {
    input: { expected?: ExactProvisionedSnapshot };
    output: ProvisionedFileState[];
  };
};

export type GitWorktreeEffect = {
  [K in keyof GitWorktreeEffects]: { type: K; input: GitWorktreeEffects[K]["input"] };
}[keyof GitWorktreeEffects];

export type GitWorktreeEffectResult = GitWorktreeEffects[keyof GitWorktreeEffects]["output"];
