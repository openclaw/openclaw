import { afterEach, expect, it, vi } from "vitest";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import {
  createPersonalPublicationFixture,
  personalPublicationAccount as account,
} from "./github-personal-publication.test-support.js";
import * as publicationStore from "./github-publication-store-async.js";
import { insertRepositoryGitHubPublicationFixture } from "./github-publication-store.test-support.js";
import {
  SESSION_KEY,
  installGitHubPublicationTestHarness,
} from "./github-publication.test-support.js";
import { readPendingRepositoryGitHubPublication } from "./github-repository-publication-store.js";
import {
  repositoryReceipt,
  sharedRepositoryWorkspace,
} from "./github-shared-publication.test-support.js";

installGitHubPublicationTestHarness();
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each([false, true])(
  "selects the last validated pending receipt without transporting content (older corrupt=%s)",
  async (corrupt) => {
    const fixture = await createPersonalPublicationFixture();
    const workspace = await sharedRepositoryWorkspace();
    let latest: ReturnType<typeof repositoryReceipt> | undefined;
    for (let index = 128; index >= 1; index--) {
      const row = repositoryReceipt(workspace, {
        request_id: `pending-${String(index).padStart(3, "0")}`,
        idempotency_key: `pending-${index}`,
        owner_profile_id: fixture.owner,
        connection_generation: fixture.generation,
        identity_source: "personal",
        identity_account_id: account.accountId,
        identity_login: account.login,
        title: "Private publication title",
        body: "x".repeat(2048),
        status: "needs_confirmation",
        updated_at_ms: 1_000 + Math.floor((index - 1) / 2),
      });
      insertRepositoryGitHubPublicationFixture(row, fixture.action.assertCurrent);
      latest ??= row;
    }
    for (const [requestId, scope] of [
      ["other-owner", { owner_profile_id: fixture.otherOwner }],
      ["other-session", { session_key: "agent:main:other" }],
      ["other-agent", { agent_id: "other" }],
      ["finished", { status: "published" }],
    ] as const) {
      insertRepositoryGitHubPublicationFixture(
        repositoryReceipt(workspace, {
          request_id: requestId,
          idempotency_key: requestId,
          owner_profile_id: fixture.owner,
          connection_generation: fixture.generation,
          identity_source: "personal",
          updated_at_ms: 99_999,
          ...scope,
        }),
        fixture.action.assertCurrent,
      );
    }
    const read = () =>
      readPendingRepositoryGitHubPublication({
        ownerProfileId: fixture.owner,
        sessionKey: SESSION_KEY,
        agentId: "main",
      });
    if (corrupt) {
      openOpenClawStateDatabase()
        .db.prepare(
          "UPDATE github_repository_publication_requests SET body = ? WHERE request_id = ?",
        )
        .run("Corrupted older content", "pending-001");
      await expect(read()).rejects.toThrow("GitHub repository publication receipt is corrupt");
      return;
    }
    const selected = await read();
    expect(selected).toMatchObject({
      request_id: "pending-128",
      request_digest: latest?.request_digest,
      owner_profile_id: fixture.owner,
      status: "needs_confirmation",
    });
    expect(selected).not.toHaveProperty("title");
    expect(selected).not.toHaveProperty("body");
    await expect(
      fixture.coordinator.personalPending(fixture.action, fixture.action),
    ).resolves.toMatchObject({
      result: { requestId: "pending-128", status: "needs_confirmation" },
      confirmation: { generation: fixture.generation, account },
    });
  },
);

it.each([false, true])(
  "falls back to the non-repository owner only after an empty successful read (corrupt=%s)",
  async (corrupt) => {
    const fixture = await createPersonalPublicationFixture();
    const published = await fixture.coordinator.requestPersonalForSessionV2(
      {
        sessionKey: SESSION_KEY,
        idempotencyKey: "worktree-pending",
        selection: { source: "personal", generation: fixture.generation, account },
      },
      fixture.action,
    );
    expect(published.status).toBe("published");
    openOpenClawStateDatabase()
      .db.prepare("UPDATE github_personal_publication_requests SET status = ? WHERE request_id = ?")
      .run("needs_confirmation", published.requestId);
    const fallback = vi.spyOn(publicationStore, "readPersonalGitHubPublicationAsync");
    if (corrupt) {
      const workspace = await sharedRepositoryWorkspace();
      insertRepositoryGitHubPublicationFixture(
        repositoryReceipt(workspace, {
          owner_profile_id: fixture.owner,
          connection_generation: fixture.generation,
          identity_source: "personal",
        }),
        fixture.action.assertCurrent,
      );
      openOpenClawStateDatabase()
        .db.prepare("UPDATE github_repository_publication_requests SET body = ?")
        .run("Corrupted receipt");
      await expect(
        fixture.coordinator.personalPending(fixture.action, fixture.action),
      ).rejects.toThrow("GitHub repository publication receipt is corrupt");
      expect(fallback).not.toHaveBeenCalled();
      return;
    }
    await expect(
      fixture.coordinator.personalPending(fixture.action, fixture.action),
    ).resolves.toMatchObject({
      result: { requestId: published.requestId, status: "needs_confirmation" },
      confirmation: { generation: fixture.generation, account },
    });
    expect(fallback).toHaveBeenCalledWith(fixture.owner, {
      sessionKey: SESSION_KEY,
      agentId: "main",
    });
  },
);
