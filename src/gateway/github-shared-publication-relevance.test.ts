import { expect, it, vi } from "vitest";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import {
  claimGitHubPublicationExecutionFixture,
  createGitHubPublicationExecutionStoreFixture,
  insertRepositoryGitHubPublicationFixture,
} from "./github-publication-store.test-support.js";
import {
  OLD_HEAD,
  installGitHubPublicationTestHarness,
} from "./github-publication.test-support.js";
import {
  insertSharedWorktreeReceipt,
  sharedRepositoryWorkspace,
  repositoryReceipt,
  sharedPublicationCoordinator,
  sharedPublicationSession,
} from "./github-shared-publication.test-support.js";

installGitHubPublicationTestHarness();

it("stops discovering a superseded failure without rewriting its receipt or exact-key recovery", async () => {
  const row = insertSharedWorktreeReceipt("obsolete-failure");
  const claimed = claimGitHubPublicationExecutionFixture(row.request_id, "fixture-instance");
  createGitHubPublicationExecutionStoreFixture("fixture-instance").complete(claimed, {
    requestId: row.request_id,
    status: "failed",
    code: "unavailable",
    message: "GitHub publication failed.",
    nextAction: "Check the accepted work.",
  });
  const coordinator = sharedPublicationCoordinator();
  const covered = vi.fn().mockResolvedValue(true);
  expect(await coordinator.latestShared(sharedPublicationSession, undefined, covered)).toBeNull();
  expect(covered).toHaveBeenCalledOnce();
  expect(covered).toHaveBeenCalledWith(
    expect.objectContaining({
      source_head_commit: row.source_head_commit,
      workspace_tree: row.workspace_tree,
    }),
  );
  expect(
    (await coordinator.sharedStatus(sharedPublicationSession, row.request_id))?.result.status,
  ).toBe("failed");
  expect(
    (await coordinator.latestShared(sharedPublicationSession, row.idempotency_key, covered))?.result
      .status,
  ).toBe("failed");
  expect(covered).toHaveBeenCalledOnce();
  covered.mockResolvedValue(false);
  expect(
    (await coordinator.latestShared(sharedPublicationSession, undefined, covered))?.result.status,
  ).toBe("failed");
});

it("retires covered repository-only failures with the same read-only contract", async () => {
  const previous = insertSharedWorktreeReceipt("previous-worktree");
  const claimed = claimGitHubPublicationExecutionFixture(previous.request_id, "fixture-instance");
  createGitHubPublicationExecutionStoreFixture("fixture-instance").complete(claimed, {
    requestId: previous.request_id,
    status: "published",
    url: "https://github.com/owner/repository/pull/1",
    repository: "owner/repository",
    branch: previous.branch,
    headCommit: OLD_HEAD,
  });
  const workspace = await sharedRepositoryWorkspace();
  const row = insertRepositoryGitHubPublicationFixture(
    repositoryReceipt(workspace, {
      status: "failed",
      error_code: "unavailable",
      next_action: "Inspect unpublished work.",
    }),
    () => {},
  );
  const coordinator = sharedPublicationCoordinator();
  const covered = vi.fn().mockResolvedValue(true);
  expect(await coordinator.latestShared(sharedPublicationSession, undefined, covered)).toBeNull();
  expect(covered).toHaveBeenCalledWith({
    repository: row.repository,
    branch: row.branch,
    source_head_commit: row.source_head_commit,
    workspace_tree: row.workspace_tree,
  });
  expect(
    (await coordinator.sharedStatus(sharedPublicationSession, row.request_id))?.result.status,
  ).toBe("failed");
});

it.each(["worktree", "repository"] as const)(
  "projects unknown non-empty %s failure codes as unavailable while rejecting empty codes",
  async (store) => {
    const coordinator = sharedPublicationCoordinator();
    const db = openOpenClawStateDatabase().db;
    const table =
      store === "worktree"
        ? "github_publication_requests"
        : "github_repository_publication_requests";
    let requestId: string;
    if (store === "worktree") {
      const row = insertSharedWorktreeReceipt("future-failure");
      const claimed = claimGitHubPublicationExecutionFixture(row.request_id, "fixture-instance");
      createGitHubPublicationExecutionStoreFixture("fixture-instance").complete(claimed, {
        requestId: row.request_id,
        status: "failed",
        code: "workflow_changes_forbidden",
        message: "GitHub publication failed.",
        nextAction: "Ask a maintainer with full operator.write authority to publish here.",
      });
      requestId = row.request_id;
    } else {
      const workspace = await sharedRepositoryWorkspace();
      requestId = insertRepositoryGitHubPublicationFixture(
        repositoryReceipt(workspace, {
          status: "failed",
          error_code: "workflow_changes_forbidden",
          next_action: "Ask a maintainer with full operator.write authority to publish here.",
        }),
        () => {},
      ).request_id;
    }
    expect((await coordinator.latestShared(sharedPublicationSession))?.result).toMatchObject({
      requestId,
      status: "failed",
      code: "workflow_changes_forbidden",
    });
    db.prepare(`UPDATE ${table} SET error_code = ? WHERE request_id = ?`).run(
      "future_failure_code",
      requestId,
    );
    expect((await coordinator.latestShared(sharedPublicationSession))?.result).toMatchObject({
      requestId,
      status: "failed",
      code: "unavailable",
      nextAction: "Ask a maintainer with full operator.write authority to publish here.",
    });
    expect(
      (await coordinator.sharedStatus(sharedPublicationSession, requestId))?.result,
    ).toMatchObject({
      requestId,
      status: "failed",
      code: "unavailable",
    });
    db.prepare(`UPDATE ${table} SET error_code = '' WHERE request_id = ?`).run(requestId);
    await expect(coordinator.latestShared(sharedPublicationSession)).rejects.toThrow(/corrupt/);
    await expect(coordinator.sharedStatus(sharedPublicationSession, requestId)).rejects.toThrow(
      /corrupt/,
    );
  },
);
