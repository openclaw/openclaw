import { readGitHubPublicationWorktreeOwner } from "./github-publication-availability.js";
import {
  readPersonalGitLabPublicationAsync,
  readSharedGitLabPublicationAsync,
} from "./github-publication-store-async.js";
import { publicationPublisher } from "./gitlab-personal-publication-identity.js";
import { readAcceptedGitLabPublication } from "./gitlab-personal-publication-row.js";

type Action = {
  owner: string;
  sessionId: string;
  sessionKey: string;
  agentId: string;
  lifecycleRevision: string | null;
  assertCurrent(): void;
};
export type GitLabPublicationSelector =
  | { requestId: string }
  | { idempotencyKey: string }
  | { pending: true }
  | { latest: true };

/** A shared receipt belongs to the admitted session, while its original owner remains immutable. */
export async function readSharedGitLabPublicationForAction(
  action: Action,
  issuer: string,
  selector: GitLabPublicationSelector,
  options: { allowUnavailableWorkspace?: boolean } = {},
) {
  const scope = {
    issuer,
    sessionId: action.sessionId,
    sessionKey: action.sessionKey,
    agentId: action.agentId,
    lifecycleRevision: action.lifecycleRevision,
    selector,
  };
  if ("requestId" in selector || "idempotencyKey" in selector) {
    const terminal = await readSharedGitLabPublicationAsync(scope);
    action.assertCurrent();
    if (terminal) {
      return terminal;
    }
  }
  let preparedOwner: Awaited<ReturnType<typeof readGitHubPublicationWorktreeOwner>>;
  try {
    preparedOwner = await readGitHubPublicationWorktreeOwner(action);
  } catch (error) {
    action.assertCurrent();
    if (options.allowUnavailableWorkspace) {
      return undefined;
    }
    throw error;
  }
  using owner = preparedOwner;
  const { worktree } = owner;
  const row = await readSharedGitLabPublicationAsync({
    ...scope,
    workspace: {
      id: worktree.id,
      repoFingerprint: worktree.repoFingerprint,
      branch: worktree.branch,
    },
  });
  action.assertCurrent();
  owner.assertCurrent();
  return row;
}

/** A private receipt is visible only to its owner; shared lookup filters private rows in SQLite. */
export async function readGitLabPublicationForAction(
  action: Action,
  issuer: string,
  selector: { requestId: string },
) {
  const owned = await readPersonalGitLabPublicationAsync(action.owner, issuer, selector);
  action.assertCurrent();
  if (
    owned &&
    publicationPublisher(readAcceptedGitLabPublication(owned).publisher).source === "personal"
  ) {
    return owned;
  }
  return readSharedGitLabPublicationForAction(action, issuer, selector);
}
