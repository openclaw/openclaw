import { expect, it, vi } from "vitest";
import {
  claimGitHubPublicationExecution,
  createGitHubPublicationExecutionStore,
} from "./github-publication-store.js";
import { installGitHubPublicationTestHarness } from "./github-publication.test-support.js";
import { insertRepositoryGitHubPublication } from "./github-repository-publication-store.js";
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
  const claimed = claimGitHubPublicationExecution(row.request_id, "fixture-instance");
  createGitHubPublicationExecutionStore("fixture-instance").complete(claimed, {
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
  const workspace = await sharedRepositoryWorkspace();
  const row = insertRepositoryGitHubPublication(
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
