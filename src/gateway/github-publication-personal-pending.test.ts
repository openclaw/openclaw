import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import * as personalStore from "./github-personal-publication-store.js";
import {
  createPersonalPublicationFixture,
  personalPublicationAccount as account,
} from "./github-personal-publication.test-support.js";
import {
  SESSION_KEY,
  commands,
  installGitHubPublicationTestHarness,
} from "./github-publication.test-support.js";
import {
  claimRepositoryGitHubPublication,
  insertRepositoryGitHubPublication,
  readPendingRepositoryGitHubPublication,
} from "./github-repository-publication-store.js";
import * as repositoryStore from "./github-repository-publication-store.js";
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
    const workspace = sharedRepositoryWorkspace();
    let latest: ReturnType<typeof repositoryReceipt> | undefined;
    for (let index = 128; index >= 1; index--) {
      const row = repositoryReceipt(workspace.workspaceId, {
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
      insertRepositoryGitHubPublication(row, fixture.action.assertCurrent);
      latest ??= row;
    }
    for (const [requestId, scope] of [
      ["other-owner", { owner_profile_id: fixture.otherOwner }],
      ["other-session", { session_key: "agent:main:other" }],
      ["other-agent", { agent_id: "other" }],
      ["finished", { status: "published" }],
    ] as const) {
      insertRepositoryGitHubPublication(
        repositoryReceipt(workspace.workspaceId, {
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

it("rechecks a terminal receipt when confirming an older pending read", async () => {
  const fixture = await createPersonalPublicationFixture();
  const workspace = sharedRepositoryWorkspace();
  const row = repositoryReceipt(workspace.workspaceId, {
    owner_profile_id: fixture.owner,
    connection_generation: fixture.generation,
    identity_source: "personal",
    identity_account_id: account.accountId,
    identity_login: account.login,
    status: "needs_confirmation",
  });
  insertRepositoryGitHubPublication(row, fixture.action.assertCurrent);
  const entered = createDeferredCore();
  const release = createDeferredCore();
  const read = repositoryStore.readPendingRepositoryGitHubPublication;
  vi.spyOn(repositoryStore, "readPendingRepositoryGitHubPublication").mockImplementation(
    async (input) => {
      const snapshot = await read(input);
      entered.resolve();
      await release.promise;
      return snapshot;
    },
  );
  const pending = fixture.coordinator.personalPending(fixture.action, fixture.action);
  try {
    await Promise.race([
      entered.promise,
      pending.then(() => {
        throw new Error("Pending read completed before its held-result boundary.");
      }),
    ]);
    const execution = claimRepositoryGitHubPublication(row, "concurrent-publisher", {
      assertCustody: fixture.action.assertCurrent,
      assertCurrent: fixture.action.assertCurrent,
    });
    execution.complete({
      requestId: row.request_id,
      status: "failed",
      code: "unavailable",
      message: "Synthetic terminal result",
      nextAction: "Create a new publication request.",
    });
    release.resolve();
    const observed = expectDefined(await pending, "captured pending receipt");
    expect(observed.result.status).toBe("needs_confirmation");
    const confirmation = expectDefined(observed.confirmation, "captured confirmation");
    const commandCount = commands.length;
    await expect(
      fixture.coordinator.confirmPersonal(
        {
          sessionKey: SESSION_KEY,
          requestId: row.request_id,
          requestDigest: confirmation.requestDigest,
          generation: confirmation.generation,
          account: confirmation.account,
        },
        fixture.action,
      ),
    ).resolves.toMatchObject({ requestId: row.request_id, status: "failed", code: "unavailable" });
    expect(commands).toHaveLength(commandCount);
  } finally {
    release.resolve();
    await pending;
  }
});

it.each([false, true])(
  "falls back to the non-repository owner only after an empty successful read (corrupt=%s)",
  async (corrupt) => {
    const fixture = await createPersonalPublicationFixture();
    const published = await fixture.coordinator.requestPersonalForSession(
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
    const fallback = vi.spyOn(personalStore, "readPersonalGitHubPublication");
    if (corrupt) {
      const workspace = sharedRepositoryWorkspace();
      insertRepositoryGitHubPublication(
        repositoryReceipt(workspace.workspaceId, {
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
