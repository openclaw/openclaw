import type { DatabaseSync } from "node:sqlite";
import {
  findLiveRegistryWorktreeByOwnerInDatabase,
  getRegistryWorktreeInDatabase,
} from "../agents/worktrees/registry-read.kernel.js";
import type { ManagedWorktreeRecord } from "../agents/worktrees/types.js";
import { parseSessionEntryJson } from "../config/sessions/session-accessor.sqlite-status.js";
import { validateCanonicalSessionRowEntry } from "../config/sessions/session-canonical-row.js";
import { listSessionMembersInDatabase } from "../config/sessions/session-sharing-store.kernel.js";
import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import type {
  GitHubPublicationSourceFacts,
  GitHubPublicationSourceSelector,
} from "./github-publication-source.types.js";
import type { DB as AgentDB } from "./openclaw-agent-db.generated.js";
import type { DB } from "./openclaw-state-db.generated.js";
import { readSessionRepositoryWorkspaceInDatabase } from "./session-repository-workspaces.kernel.js";
import { readUserGitHubConnectionInDatabase } from "./user-github-connections.kernel.js";
import { projectUserGitHubConnectionAuthority } from "./user-github-connections.types.js";
import { selectStoredGitHubIdentities } from "./user-profile-github-identity.js";
import {
  readUserProfileEmailBindings,
  selectUserProfileIdentityInDatabase,
} from "./user-profile-identity.read.js";

function worktreeFacts(row: ManagedWorktreeRecord | undefined) {
  return (
    row && {
      id: row.id,
      ownerKind: row.ownerKind,
      ownerId: row.ownerId,
      repoRoot: row.repoRoot,
      repoFingerprint: row.repoFingerprint,
      path: row.path,
      branch: row.branch,
      removedAt: row.removedAt,
    }
  );
}

function isGitHubPublicationSourceCurrent(
  selector: GitHubPublicationSourceSelector,
  { entry, repositoryWorkspace }: GitHubPublicationSourceFacts,
): boolean {
  return (
    entry?.sessionId === selector.sessionId &&
    (entry.lifecycleRevision ?? null) === selector.lifecycleRevision &&
    entry.archivedAt === undefined &&
    (selector.repositoryWorkspaceId === undefined ||
      (entry.repositoryWorkspaceId === selector.repositoryWorkspaceId &&
        repositoryWorkspace?.workspaceId === selector.repositoryWorkspaceId &&
        repositoryWorkspace.agentId === selector.agentId &&
        repositoryWorkspace.sessionKey === selector.sessionKey &&
        (selector.repositoryBranch === undefined ||
          repositoryWorkspace.branch === selector.repositoryBranch)))
  );
}

/** Called only in worker custody; the caller reserves both databases through destination commit. */
export function readGitHubPublicationSourceFacts(
  sourceDb: DatabaseSync,
  stateDb: DatabaseSync,
  selector: GitHubPublicationSourceSelector,
): GitHubPublicationSourceFacts {
  // The source owner admitted this schema before minting the capability. Exact row
  // validation must not reopen canonical/schema admission while S8 holds reservations.
  const row = executeSqliteQueryTakeFirstSync(
    sourceDb,
    getNodeSqliteKysely<Pick<AgentDB, "session_nodes" | "session_windows">>(sourceDb)
      .selectFrom("session_nodes")
      .leftJoin("session_windows", (join) =>
        join
          .onRef("session_windows.session_id", "=", "session_nodes.current_session_id")
          .onRef("session_windows.session_key", "=", "session_nodes.session_key"),
      )
      .selectAll("session_nodes")
      .select("session_windows.session_id as retained_window_id")
      .where("session_nodes.session_key", "=", selector.sessionKey),
  );
  const entry = row
    ? validateCanonicalSessionRowEntry(row, parseSessionEntryJson(row, "list"), "read")
    : undefined;
  const members = listSessionMembersInDatabase({ db: sourceDb }, selector.sessionKey);
  const facts: GitHubPublicationSourceFacts = {
    entry: entry && {
      sessionId: entry.sessionId,
      lifecycleRevision: entry.lifecycleRevision,
      archivedAt: entry.archivedAt,
      visibility: entry.visibility,
      incognito: entry.incognito,
      createdActor: entry.createdActor,
      owner: entry.owner,
      worktree: entry.worktree,
      repositoryWorkspaceId: entry.repositoryWorkspaceId,
    },
    members,
  };
  if (selector.repositoryWorkspaceId) {
    facts.repositoryWorkspace = readSessionRepositoryWorkspaceInDatabase(
      stateDb,
      selector.repositoryWorkspaceId,
    );
  }
  if (!isGitHubPublicationSourceCurrent(selector, facts)) {
    throw new Error("GitHub publication session changed.");
  }
  if (selector.profileId) {
    const identity = selectUserProfileIdentityInDatabase(stateDb, selector.profileId);
    if (!identity) {
      throw new Error("GitHub publication requester changed.");
    }
    const github = selectStoredGitHubIdentities(stateDb, [identity.profileId]).get(
      identity.profileId,
    );
    const emailBindings = readUserProfileEmailBindings(stateDb, identity.profileId);
    if (
      selector.aliasBindingIds?.some(
        (bindingId) => !emailBindings.some((binding) => binding.bindingId === bindingId),
      )
    ) {
      throw new Error("GitHub publication requester binding changed.");
    }
    facts.profile = {
      profileId: identity.profileId,
      role: identity.role,
      aliases: [...identity.aliases].toSorted(),
      githubLogin: github?.primary?.login ?? null,
      githubAccountIds: github?.accounts.map((account) => account.accountId) ?? [],
      emailBindings,
    };
  }
  if (selector.worktreeId) {
    facts.worktree = worktreeFacts(getRegistryWorktreeInDatabase(stateDb, selector.worktreeId));
    facts.ownerWorktree = worktreeFacts(
      findLiveRegistryWorktreeByOwnerInDatabase(stateDb, "session", selector.sessionKey),
    );
  }
  const placement = executeSqliteQueryTakeFirstSync(
    stateDb,
    getNodeSqliteKysely<Pick<DB, "worker_session_placements">>(stateDb)
      .selectFrom("worker_session_placements")
      .select([
        "session_id",
        "agent_id",
        "session_key",
        "state",
        "execution_mode",
        "environment_id",
        "transition_generation",
        "active_owner_epoch",
        "turn_claim_owner",
        "turn_claim_id",
        "turn_claim_run_id",
        "turn_claim_generation",
        "turn_claim_owner_epoch",
      ])
      .where("session_id", "=", selector.sessionId),
  );
  // SQLite rows have a null prototype; source facts must survive worker cloning.
  facts.placement = placement && { ...placement };
  if (selector.personalOwnerProfileId) {
    const connection = readUserGitHubConnectionInDatabase(stateDb, selector.personalOwnerProfileId);
    facts.connection = projectUserGitHubConnectionAuthority(connection) ?? undefined;
  }
  return facts;
}
