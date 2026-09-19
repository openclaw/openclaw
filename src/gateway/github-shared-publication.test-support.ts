import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { getSessionRepositoryWorkspaceStore } from "../state/session-repository-workspaces.js";
import type { SharedGitHubPublicationSession } from "./github-publication-shared-read.js";
import {
  digestGitHubPublicationRequest,
  ensureGitHubPublicationStore,
  insertGitHubPublicationRequest,
} from "./github-publication-store.js";
import {
  BRANCH,
  OLD_HEAD,
  SESSION_ID,
  SESSION_KEY,
  WORKSPACE_TREE,
  createTestGitHubPublicationCoordinator,
  githubPublicationTestMocks,
} from "./github-publication.test-support.js";
import {
  repositoryGitHubPublicationDigest,
  type RepositoryGitHubPublicationRow,
} from "./github-repository-publication-store.js";
import { createWorkerSessionPlacementStore } from "./worker-environments/placement-store.js";

export const sharedPublicationSession: SharedGitHubPublicationSession = {
  sessionId: SESSION_ID,
  sessionKey: SESSION_KEY,
  agentId: "main",
  lifecycleRevision: null,
};

export function sharedPublicationCoordinator() {
  return createTestGitHubPublicationCoordinator({
    placements: createWorkerSessionPlacementStore({ database: openOpenClawStateDatabase() }),
  });
}

export function insertSharedWorktreeReceipt(
  requestId: string,
  options: {
    session?: SharedGitHubPublicationSession;
    idempotencyKey?: string;
    createdAtMs?: number;
    worktreeId?: string;
    branch?: string;
    repositoryFingerprint?: string;
  } = {},
) {
  ensureGitHubPublicationStore();
  const session = options.session ?? sharedPublicationSession;
  const request = {
    sessionKey: session.sessionKey,
    agentId: session.agentId,
    idempotencyKey: options.idempotencyKey ?? requestId,
  };
  return runOpenClawStateWriteTransaction(({ db }) =>
    insertGitHubPublicationRequest(db, {
      request,
      requestId,
      requestDigest: digestGitHubPublicationRequest({ ...request, sessionId: session.sessionId }),
      sessionId: session.sessionId,
      lifecycleRevision: session.lifecycleRevision ?? null,
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

export function sharedRepositoryWorkspace() {
  const workspace = getSessionRepositoryWorkspaceStore().create({
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
  return workspace;
}

export function repositoryReceipt(
  workspaceId: string,
  overrides: Partial<RepositoryGitHubPublicationRow> = {},
): RepositoryGitHubPublicationRow {
  const row: RepositoryGitHubPublicationRow = {
    request_id: "repository-request",
    idempotency_key: "repository-key",
    request_digest: "",
    session_id: SESSION_ID,
    session_lifecycle_revision: null,
    session_key: SESSION_KEY,
    agent_id: "main",
    workspace_id: workspaceId,
    owner_profile_id: null,
    connection_generation: null,
    identity_source: "system-configured",
    identity_profile_id: "fixture-profile",
    identity_account_id: 42,
    identity_login: "fixture-bot",
    title: null,
    body: null,
    push_repository: "owner/repository",
    repository: "owner/repository",
    base_branch: "main",
    branch: getSessionRepositoryWorkspaceStore().get(workspaceId)!.branch,
    previous_head_commit: null,
    claim_id: null,
    run_id: null,
    environment_id: null,
    owner_epoch: null,
    placement_generation: null,
    checkpoint_ref: "refs/openclaw/worker-results/fixture",
    checkpoint_digest: "sha256:" + "a".repeat(64),
    source_head_commit: OLD_HEAD,
    source_index_tree: WORKSPACE_TREE,
    workspace_tree: WORKSPACE_TREE,
    status: "requested",
    execution_id: null,
    gateway_instance_id: null,
    head_commit: null,
    pushed_head_commit: null,
    pull_request_url: null,
    last_effect: null,
    effect_state: null,
    error_code: null,
    next_action: null,
    created_at_ms: 1_000,
    updated_at_ms: 1_000,
    reported_at_ms: null,
    ...overrides,
  };
  row.request_digest = repositoryGitHubPublicationDigest(row);
  return row;
}
