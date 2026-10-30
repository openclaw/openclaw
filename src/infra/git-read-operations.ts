import type { SessionsDiffResult } from "../../packages/gateway-protocol/src/index.js";
import type { ManagedWorktreeBranchesResult } from "../agents/worktrees/types.js";
import type { SessionDiffBaseline } from "../config/sessions/types.js";

export type GitCheckoutContext = {
  /** Omitted host is the public GitHub default. */
  host?: string;
  owner: string;
  repo: string;
  branch: string | null;
  root?: string;
  defaultBranch?: string;
  /**
   * Candidate head repositories from non-origin GitHub remotes tracking `branch`.
   * The PR response must identify the same head repository; remote names alone
   * do not establish fork membership. `owner`/`repo` stay the base identity.
   */
  forkHeadCandidates?: Array<{ owner: string; repo: string }>;
};

/** Lowercased merged-PR head, its target branch, and its merge commit. */
export type GitMergedPullHead = { sha: string; baseRef?: string; mergeCommitSha?: string };
type GitPullRequestBranchFacts = {
  creatable: boolean;
  stats: { additions: number; deletions: number; changedFiles: number } | null;
};

export type GitCheckoutDiffInput = { cwd: string; baseCommit?: string; summaryOnly?: boolean } & (
  | {
      scope?: "all" | "uncommitted";
      commit?: never;
      baseline?: SessionDiffBaseline;
      sessionId?: string;
    }
  | { scope: "commit"; commit: string; baseline?: never; sessionId?: never }
);

export type GitReadOperations = {
  "repository.identities": {
    input: { roots: string[] };
    output: Array<
      | {
          checkoutRoot: string;
          repoRoot: string;
          originUrl: string;
          fingerprint: string;
        }
      | undefined
    >;
  };
  "checkout.revision": {
    input: {
      root: string;
      scope: "context" | "refs" | "worktree" | "diff";
      branch?: string;
      defaultBranch?: string;
      summaryOnly?: boolean;
      /** Previously displayed paths whose Git attributes can affect the cached diff. */
      paths?: string[];
    };
    output: {
      key: string;
      /** A successful status inventory, tied to its physical checkout and HEAD. */
      worktreeStatus?: { root: string; head: string; clean: boolean; untrackedPaths: string[] };
    } | null;
  };
  "checkout.context": {
    input: { root: string; githubHost?: string };
    output: GitCheckoutContext | null;
  };
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
      /** The session's persisted managed-worktree binding owns index stat refreshes. */
      refreshIndex?: boolean;
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
