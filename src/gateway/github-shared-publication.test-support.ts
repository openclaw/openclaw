import { replaceSessionEntrySync } from "../config/sessions/session-accessor.js";
import type { RepositoryGitHubPublicationRow } from "../state/github-publication-read.types.js";
import { repositoryRow } from "../state/github-publication.worker.test-support.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import { getSessionRepositoryWorkspaceStore } from "../state/session-repository-workspaces.js";
import { digestGitHubPublicationRequest } from "./github-publication-receipt.js";
import type { PublicationSessionIdentity } from "./github-publication-session.types.js";
import { ensureGitHubPublicationStoreFixture } from "./github-publication-store.test-support.js";
import { insertGitHubPublicationRequest } from "./github-publication-store.worker.js";
import {
  BRANCH,
  OLD_HEAD,
  SESSION_ID,
  SESSION_KEY,
  WORKSPACE_TREE,
  githubPublicationTestMocks,
  systemPublicationRequester,
} from "./github-publication.test-support.js";
import { repositoryGitHubPublicationDigest } from "./github-repository-publication-store.js";

export { createTestGitHubPublicationCoordinator as sharedPublicationCoordinator } from "./github-publication.test-support.js";

export const sharedPublicationSession: PublicationSessionIdentity = {
  sessionId: SESSION_ID,
  sessionKey: SESSION_KEY,
  agentId: "main",
  lifecycleRevision: null,
};

export function insertSharedWorktreeReceipt(
  requestId: string,
  options: {
    session?: PublicationSessionIdentity;
    idempotencyKey?: string;
    createdAtMs?: number;
    worktreeId?: string;
    branch?: string;
    repositoryFingerprint?: string;
  } = {},
) {
  ensureGitHubPublicationStoreFixture();
  const session = options.session ?? sharedPublicationSession;
  const request = {
    sessionKey: session.sessionKey,
    agentId: session.agentId,
    idempotencyKey: options.idempotencyKey ?? requestId,
    draft: false,
  };
  return runOpenClawStateWriteTransaction(({ db }) =>
    insertGitHubPublicationRequest(db, {
      request,
      requestId,
      requestDigest: digestGitHubPublicationRequest({ ...request, sessionId: session.sessionId }),
      sessionId: session.sessionId,
      lifecycleRevision: session.lifecycleRevision ?? null,
      requester: systemPublicationRequester.snapshot,
      assertCurrent: systemPublicationRequester.assertCurrent,
      now: options.createdAtMs ?? 1_000,
      worktree: {
        id: options.worktreeId ?? "worktree-1",
        repoFingerprint: options.repositoryFingerprint ?? "fingerprint-1",
        branch: options.branch ?? BRANCH,
      },
      identity: {
        source: "system-configured",
        profileId: "fixture-profile",
        account: { accountId: 42, login: "fixture-bot", avatarUrl: null },
      },
      snapshot: {
        sourceHeadCommit: OLD_HEAD,
        sourceIndexTree: WORKSPACE_TREE,
        workspaceTree: WORKSPACE_TREE,
      },
    }),
  );
}

export async function sharedRepositoryWorkspace() {
  const workspace = await getSessionRepositoryWorkspaceStore().create({
    agentId: "main",
    sessionKey: SESSION_KEY,
    url: "https://github.com/owner/repository.git",
    assertCurrent: () => {},
  });
  const mocks = githubPublicationTestMocks();
  const original = mocks.loadSession.getMockImplementation()!;
  mocks.loadSession.mockImplementation((key: string, options: unknown) => {
    const loaded = original(key, options);
    return key === SESSION_KEY
      ? {
          ...loaded,
          entry: { sessionId: SESSION_ID, repositoryWorkspaceId: workspace.workspaceId },
        }
      : loaded;
  });
  replaceSessionEntrySync(
    { agentId: "main", sessionKey: SESSION_KEY },
    {
      ...original(SESSION_KEY).entry,
      worktree: undefined,
      repositoryWorkspaceId: workspace.workspaceId,
    },
  );
  return workspace;
}

export function repositoryReceipt(
  workspace: Pick<Awaited<ReturnType<typeof sharedRepositoryWorkspace>>, "workspaceId" | "branch">,
  overrides: Partial<RepositoryGitHubPublicationRow> = {},
): RepositoryGitHubPublicationRow {
  const row: RepositoryGitHubPublicationRow = {
    ...repositoryRow("repository-request"),
    idempotency_key: "repository-key",
    session_id: SESSION_ID,
    session_key: SESSION_KEY,
    workspace_id: workspace.workspaceId,
    push_repository: "owner/repository",
    repository: "owner/repository",
    branch: workspace.branch,
    source_head_commit: OLD_HEAD,
    source_index_tree: WORKSPACE_TREE,
    workspace_tree: WORKSPACE_TREE,
    ...overrides,
  };
  row.request_digest = repositoryGitHubPublicationDigest(row);
  return row;
}
