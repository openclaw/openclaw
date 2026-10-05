import type { RepositoryGitHubPublicationRow } from "../state/github-publication-read.types.js";
import {
  matchesCurrentGitHubPublicationIdentity,
  prepareCurrentGitHubPublicationIdentity,
} from "./github-publication-availability.js";
import type { GitHubPublicationIdentityOwner } from "./github-publication-execution-identity.js";
import type { GitHubPublicationRequesterPolicy } from "./github-publication-requester.js";
import type { RepositoryGitHubPublicationExecution } from "./github-repository-publication-store.js";

export function createFactoryRepositoryPublicationIdentity(params: {
  row: RepositoryGitHubPublicationRow;
  execution: RepositoryGitHubPublicationExecution;
  assertExecution: () => void;
  getRequester: () => GitHubPublicationRequesterPolicy;
}): GitHubPublicationIdentityOwner {
  const { row, execution, assertExecution, getRequester } = params;
  const ownerId = execution.row.execution_id;
  if (!ownerId) {
    throw new Error("GitHub repository publication execution identity is missing.");
  }
  return {
    prepare: () => {
      const actor = getRequester().snapshot.actor;
      return prepareCurrentGitHubPublicationIdentity(
        row.agent_id,
        actor.kind === "operator"
          ? {
              profileId: actor.profileId,
              sessionKey: row.session_key,
              assertCurrent: assertExecution,
            }
          : undefined,
        {
          claim: {
            purpose: "publication-execution",
            binding: {
              kind: "publication",
              agentId: row.agent_id,
              sessionKey: row.session_key,
              sessionId: row.session_id,
              lifecycleRevision: row.session_lifecycle_revision,
              executionKind: "repository",
              requestId: row.request_id,
              ownerId,
              requestDigest: row.request_digest,
            },
          },
          assertCurrent: () => {
            assertExecution();
            if (!execution.ownsExecution()) {
              throw new Error("GitHub repository publication execution changed.");
            }
          },
        },
      );
    },
    isCurrent: (identity) => {
      getRequester().assertCurrent();
      return matchesCurrentGitHubPublicationIdentity({ agentId: row.agent_id, identity });
    },
  };
}
