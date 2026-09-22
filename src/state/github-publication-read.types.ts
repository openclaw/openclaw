import type { DB } from "./openclaw-state-db.generated.js";

export type GitHubPublicationRow = DB["github_publication_requests"];
export type GitHubPublicationExecutionRow = Omit<
  GitHubPublicationRow,
  "claim_id" | "run_id" | "environment_id" | "owner_epoch" | "placement_generation"
> & { last_effect?: string | null; effect_state?: string | null };
export type GitHubPublicationReceiptTarget = Pick<
  GitHubPublicationExecutionRow,
  | "worktree_id"
  | "repository_fingerprint"
  | "repository"
  | "branch"
  | "base_branch"
  | "identity_account_id"
  | "pull_request_url"
>;

export type RepositoryGitHubPublicationRow = DB["github_repository_publication_requests"];
export type RepositoryGitHubPublicationReceiptTarget = Pick<
  RepositoryGitHubPublicationRow,
  | "workspace_id"
  | "push_repository"
  | "repository"
  | "branch"
  | "base_branch"
  | "identity_account_id"
  | "pull_request_url"
>;

export type GitHubPublicationSessionLifecycle = Pick<
  DB["github_publication_session_lifecycles"],
  "lifecycle_revision" | "requester_authority_json"
>;
