import { SessionWorktreeSourceChangedError } from "../agents/worktrees/errors.js";
import {
  captureWorktreeRegistryReadGuard,
  readLiveRegistryWorktreeByOwner,
} from "../agents/worktrees/registry-read.js";
import type { ManagedWorktreeRecord } from "../agents/worktrees/types.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import {
  GitHubPublicationWorkspaceChangedError,
  GitHubPublicationSessionChangedError,
} from "./github-publication-failure.js";
import type {
  PublicationSessionIdentity,
  PublicationSessionRead,
} from "./github-publication-session.types.js";

export type ExpectedWorktree = {
  worktreeId: string;
  repositoryFingerprint: string;
  branch: string;
};
export type PublicationSessionOwner = ReturnType<typeof requirePublicationSessionOwner>;

export function requirePublicationSessionOwner(
  params: PublicationSessionIdentity,
  loaded: PublicationSessionRead,
  allowArchived = false,
) {
  const entry = loaded.entry;
  if (
    loaded.agentId !== params.agentId ||
    loaded.canonicalKey !== params.sessionKey ||
    entry?.sessionId !== params.sessionId ||
    (!allowArchived && entry.archivedAt !== undefined) ||
    (params.lifecycleRevision !== undefined &&
      (entry.lifecycleRevision ?? null) !== params.lifecycleRevision)
  ) {
    throw new GitHubPublicationSessionChangedError();
  }
  return { ...loaded, entry };
}

function requirePublicationWorktreeOwner(
  loaded: PublicationSessionOwner,
  worktree: ManagedWorktreeRecord | undefined,
  expected?: ExpectedWorktree,
  allowExistingPullRequest = false,
) {
  const entry = loaded.entry;
  const pullRequest = entry.worktree?.githubPullRequest;
  if (
    pullRequest &&
    (!allowExistingPullRequest ||
      !pullRequest.preparedHeadCommit ||
      pullRequest.preparedHeadCommit !== pullRequest.head.commit)
  ) {
    throw new GitHubPublicationWorkspaceChangedError(
      allowExistingPullRequest
        ? "Finish preparing the original PR source before publication; saved work was preserved."
        : "This publication path cannot update an imported PR; use shared publication after preparation.",
    );
  }
  if (
    !entry.worktree?.id ||
    !worktree ||
    worktree.removedAt !== undefined ||
    worktree.id !== entry.worktree.id ||
    worktree.ownerKind !== "session" ||
    worktree.ownerId !== loaded.canonicalKey ||
    worktree.branch !== entry.worktree.branch ||
    worktree.repoRoot !== entry.worktree.repoRoot
  ) {
    throw new GitHubPublicationSessionChangedError();
  }
  if (
    expected &&
    (worktree.id !== expected.worktreeId ||
      worktree.repoFingerprint !== expected.repositoryFingerprint ||
      (pullRequest?.head.branch ?? worktree.branch) !== expected.branch)
  ) {
    throw new GitHubPublicationWorkspaceChangedError(
      "GitHub publication workspace authority changed.",
    );
  }
  return { loaded, worktree, publicationBranch: pullRequest?.head.branch ?? worktree.branch };
}

function rejectChangedPublicationWorktree(error: unknown): never {
  if (error instanceof SessionWorktreeSourceChangedError) {
    throw new GitHubPublicationWorkspaceChangedError(error.message);
  }
  throw error;
}

export function preparePublicationWorktreeRead(
  loaded: PublicationSessionOwner,
  context: OpenClawStateWorkerContext,
  readSession: () => PublicationSessionRead,
  expected?: ExpectedWorktree,
  allowExistingPullRequest = false,
) {
  const identity = {
    sessionId: loaded.entry.sessionId,
    sessionKey: loaded.canonicalKey,
    agentId: loaded.agentId,
    lifecycleRevision: loaded.entry.lifecycleRevision ?? null,
  };
  const workspaceId = loaded.entry.repositoryWorkspaceId;
  const selection = expected ? { ...expected } : undefined;
  return async () => {
    const acceptRead = captureWorktreeRegistryReadGuard(context, "publication");
    const worktree = await readLiveRegistryWorktreeByOwner(context, "session", identity.sessionKey);
    let assertRow: () => void;
    try {
      assertRow = acceptRead(worktree);
    } catch (error) {
      rejectChangedPublicationWorktree(error);
    }
    context.admission.assertCurrent();
    if (!worktree) {
      throw new GitHubPublicationSessionChangedError();
    }
    const current = requirePublicationSessionOwner(identity, readSession());
    if (current.entry.repositoryWorkspaceId !== workspaceId) {
      throw new GitHubPublicationSessionChangedError();
    }
    const assertCurrent = () => {
      context.admission.assertCurrent();
      const latest = requirePublicationSessionOwner(identity, readSession());
      if (latest.entry.repositoryWorkspaceId !== workspaceId) {
        throw new GitHubPublicationSessionChangedError();
      }
      try {
        assertRow();
      } catch (error) {
        rejectChangedPublicationWorktree(error);
      }
      return requirePublicationWorktreeOwner(latest, worktree, selection, allowExistingPullRequest);
    };
    return {
      ...requirePublicationWorktreeOwner(current, worktree, selection, allowExistingPullRequest),
      assertCurrent,
      assertRegistryCurrent: assertRow,
    };
  };
}
