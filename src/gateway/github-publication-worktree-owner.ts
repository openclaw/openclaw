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

function requireSessionWorktreeOwner(
  loaded: PublicationSessionOwner,
  worktree: ManagedWorktreeRecord,
) {
  const entry = loaded.entry;
  if (
    !entry.worktree?.id ||
    worktree.removedAt !== undefined ||
    worktree.id !== entry.worktree.id ||
    worktree.ownerKind !== "session" ||
    worktree.ownerId !== loaded.canonicalKey ||
    worktree.branch !== entry.worktree.branch ||
    worktree.repoRoot !== entry.worktree.repoRoot
  ) {
    throw new GitHubPublicationSessionChangedError();
  }
  return { loaded, worktree };
}

function requirePublicationWorktreeOwner(
  loaded: PublicationSessionOwner,
  worktree: ManagedWorktreeRecord,
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
  const owner = requireSessionWorktreeOwner(loaded, worktree);
  const publicationBranch = pullRequest?.head.branch ?? worktree.branch;
  if (
    expected &&
    (worktree.id !== expected.worktreeId ||
      worktree.repoFingerprint !== expected.repositoryFingerprint ||
      publicationBranch !== expected.branch)
  ) {
    throw new GitHubPublicationWorkspaceChangedError(
      "GitHub publication workspace moved. Retry the publication.",
    );
  }
  return { ...owner, publicationBranch };
}

function rejectChangedPublicationWorktree(error: unknown): never {
  if (error instanceof SessionWorktreeSourceChangedError) {
    throw new GitHubPublicationWorkspaceChangedError(error.message);
  }
  throw error;
}

function prepareOwnedWorktreeRead<T>(
  loaded: PublicationSessionOwner,
  context: OpenClawStateWorkerContext,
  readSession: () => PublicationSessionRead,
  requireOwner: (
    current: PublicationSessionOwner,
    worktree: ManagedWorktreeRecord,
    expected?: ExpectedWorktree,
  ) => T,
  expected?: ExpectedWorktree,
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
    const current = requirePublicationSessionOwner(identity, readSession());
    if (current.entry.repositoryWorkspaceId !== workspaceId) {
      throw new GitHubPublicationSessionChangedError();
    }
    if (!worktree) {
      if (!selection && !workspaceId && !current.entry.worktree?.id) {
        throw new Error(
          "This conversation has no publication workspace. To publish a committed local checkout, call github_publish with workspacePath set to the checkout's absolute path.",
        );
      }
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
      return requireOwner(latest, worktree, selection);
    };
    return {
      ...requireOwner(current, worktree, selection),
      assertCurrent,
      assertRegistryCurrent: assertRow,
    };
  };
}

export function prepareSessionWorktreeRead(
  loaded: PublicationSessionOwner,
  context: OpenClawStateWorkerContext,
  readSession: () => PublicationSessionRead,
) {
  return prepareOwnedWorktreeRead(loaded, context, readSession, requireSessionWorktreeOwner);
}

export function preparePublicationWorktreeRead(
  loaded: PublicationSessionOwner,
  context: OpenClawStateWorkerContext,
  readSession: () => PublicationSessionRead,
  expected?: ExpectedWorktree,
  allowExistingPullRequest = false,
) {
  return prepareOwnedWorktreeRead(
    loaded,
    context,
    readSession,
    (current, worktree, selection) =>
      requirePublicationWorktreeOwner(current, worktree, selection, allowExistingPullRequest),
    expected,
  );
}
