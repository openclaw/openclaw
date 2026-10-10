import type { Selectable } from "kysely";
import type { ManagedWorktreeRecord } from "../agents/worktrees/types.js";
import type { SessionMember } from "../config/sessions/session-membership-facts.types.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { DB } from "./openclaw-state-db.generated.js";
import type { SessionRepositoryWorkspaceRecord } from "./session-repository-workspaces.types.js";
import type { UserGitHubConnectionAuthority } from "./user-github-connections.types.js";
import type { UserProfileEmailBinding } from "./user-profiles.types.js";

export type GitHubPublicationSourceSelector = {
  agentId: string;
  sessionKey: string;
  sessionId: string;
  lifecycleRevision: string | null;
  profileId?: string;
  aliasBindingIds?: readonly string[];
  personalOwnerProfileId?: string;
  worktreeId?: string;
  repositoryWorkspaceId?: string;
  repositoryBranch?: string;
};

type WorktreeSource = Pick<
  ManagedWorktreeRecord,
  "id" | "ownerKind" | "ownerId" | "repoRoot" | "repoFingerprint" | "path" | "branch" | "removedAt"
>;

/** Durable authority only; tokens, transcripts, and unrelated progress never leave the worker. */
export type GitHubPublicationSourceFacts = {
  entry?: Pick<
    SessionEntry,
    | "sessionId"
    | "lifecycleRevision"
    | "archivedAt"
    | "visibility"
    | "incognito"
    | "createdActor"
    | "owner"
    | "worktree"
    | "repositoryWorkspaceId"
  >;
  members: SessionMember[];
  profile?: {
    profileId: string;
    role: string | null;
    aliases: string[];
    githubLogin: string | null;
    githubAccountIds: number[];
    emailBindings: UserProfileEmailBinding[];
  };
  worktree?: WorktreeSource;
  ownerWorktree?: WorktreeSource;
  repositoryWorkspace?: SessionRepositoryWorkspaceRecord;
  placement?: Pick<
    Selectable<DB["worker_session_placements"]>,
    | "session_id"
    | "agent_id"
    | "session_key"
    | "state"
    | "execution_mode"
    | "environment_id"
    | "transition_generation"
    | "active_owner_epoch"
    | "turn_claim_owner"
    | "turn_claim_id"
    | "turn_claim_run_id"
    | "turn_claim_generation"
    | "turn_claim_owner_epoch"
  >;
  connection?: UserGitHubConnectionAuthority;
};
