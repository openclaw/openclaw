import type { GitHubPublicationSessionFacts } from "./github-publication-source.types.js";

export function projectGitHubPublicationSessionFacts(
  entry: GitHubPublicationSessionFacts["entry"],
  members: GitHubPublicationSessionFacts["members"],
): GitHubPublicationSessionFacts {
  return {
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
}
