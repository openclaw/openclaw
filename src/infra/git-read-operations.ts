import type { SessionsDiffResult } from "../../packages/gateway-protocol/src/index.js";
import type { ManagedWorktreeBranchesResult } from "../agents/worktrees/types.js";
import type { SessionDiffBaseline } from "../config/sessions/types.js";

export type GitCheckoutContext = {
  owner: string;
  repo: string;
  branch: string;
  root?: string;
  defaultBranch?: string;
};

/** Lowercased merged-PR head, its target branch, and its merge commit. */
export type GitMergedPullHead = { sha: string; baseRef?: string; mergeCommitSha?: string };
type GitPullRequestBranchFacts = {
  creatable: boolean;
  stats: { additions: number; deletions: number; changedFiles: number } | null;
};

export type GitCheckoutDiffInput = { cwd: string; baseCommit?: string } & (
  | {
      scope?: "all" | "uncommitted";
      commit?: never;
      baseline?: SessionDiffBaseline;
      sessionId?: string;
    }
  | { scope: "commit"; commit: string; baseline?: never; sessionId?: never }
);

export type GitReadOperations = {
  "checkout.context": { input: { root: string }; output: GitCheckoutContext | null };
  "checkout.diff": { input: GitCheckoutDiffInput; output: Omit<SessionsDiffResult, "sessionKey"> };
  "repository.branches": {
    input: { repoRoot: string; includeRepositoryStatus?: boolean };
    output: ManagedWorktreeBranchesResult;
  };
  "pull-request.branch-facts": {
    input: {
      root: string;
      branch: string;
      defaultBranch?: string;
      mergedHeads: readonly GitMergedPullHead[];
    };
    output: GitPullRequestBranchFacts | undefined;
  };
  "checkout.baseline": {
    input: { cwd: string };
    output: Omit<SessionDiffBaseline, "sessionId"> | undefined;
  };
};

export type GitReadOperation = {
  [K in keyof GitReadOperations]: { type: K; input: GitReadOperations[K]["input"] };
}[keyof GitReadOperations];
export type GitReadOperationResult = GitReadOperations[keyof GitReadOperations]["output"];
