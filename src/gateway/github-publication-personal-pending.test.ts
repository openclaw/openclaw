import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import * as stateWriter from "../state/openclaw-state-worker-owner.js";
import {
  createPersonalPublicationFixture,
  personalPublicationAccount as account,
  personalPublicationRequest,
} from "./github-personal-publication.test-support.js";
import * as publicationStore from "./github-publication-store-async.js";
import {
  claimRepositoryGitHubPublicationFixture,
  insertRepositoryGitHubPublicationFixture,
} from "./github-publication-store.test-support.js";
import {
  SESSION_KEY,
  commands,
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

type PersonalFixture = Awaited<ReturnType<typeof createPersonalPublicationFixture>>;
let fixture: PersonalFixture;
let workspace: Awaited<ReturnType<typeof sharedRepositoryWorkspace>> | undefined;
beforeEach(async () => {
  fixture = await createPersonalPublicationFixture();
  workspace = undefined;
});
const pending = () => fixture.coordinator.personalPending(fixture.action, fixture.action);
const db = () => openOpenClawStateDatabase().db;
const corruptReceiptError = "GitHub repository publication receipt is corrupt";
function corruptReceipt(requestId: string) {
  db()
    .prepare("UPDATE github_repository_publication_requests SET body = ? WHERE request_id = ?")
    .run("Corrupted receipt", requestId);
}
const readPending = () =>
  readPendingRepositoryGitHubPublication({
    ownerProfileId: fixture.owner,
    sessionKey: SESSION_KEY,
    agentId: "main",
  });
async function insertPending(overrides: Parameters<typeof repositoryReceipt>[1] = {}) {
  workspace ??= await sharedRepositoryWorkspace();
  const row = repositoryReceipt(workspace, {
    owner_profile_id: fixture.owner,
    connection_generation: fixture.generation,
    identity_source: "personal",
    identity_account_id: account.accountId,
    identity_login: account.login,
    status: "needs_confirmation",
    ...overrides,
  });
  insertRepositoryGitHubPublicationFixture(row, fixture.action.assertCurrent);
  return row;
}

it.each([false, true])(
  "selects the last validated pending receipt without transporting content (older corrupt=%s)",
  async (corrupt) => {
    let latest: ReturnType<typeof repositoryReceipt> | undefined;
    for (let index = 128; index >= 1; index--) {
      const row = await insertPending({
        request_id: `pending-${String(index).padStart(3, "0")}`,
        idempotency_key: `pending-${index}`,
        title: "Private publication title",
        body: "x".repeat(2048),
        updated_at_ms: 1_000 + Math.floor((index - 1) / 2),
      });
      latest ??= row;
    }
    for (const [requestId, scope] of [
      ["other-owner", { owner_profile_id: fixture.otherOwner }],
      ["other-session", { session_key: "agent:main:other" }],
      ["other-agent", { agent_id: "other" }],
      ["finished", { status: "published" }],
    ] as const) {
      await insertPending({
        request_id: requestId,
        idempotency_key: requestId,
        updated_at_ms: 99_999,
        ...scope,
      });
    }
    if (corrupt) {
      corruptReceipt("pending-001");
      await expect(readPending()).rejects.toThrow(corruptReceiptError);
      return;
    }
    const selected = await readPending();
    expect(selected).toMatchObject({
      request_id: "pending-128",
      request_digest: latest?.request_digest,
      owner_profile_id: fixture.owner,
      status: "needs_confirmation",
    });
    expect(selected).not.toHaveProperty("title");
    expect(selected).not.toHaveProperty("body");
    await expect(pending()).resolves.toMatchObject({
      result: { requestId: "pending-128", status: "needs_confirmation" },
      confirmation: { generation: fixture.generation, account },
    });
  },
);

it("reads committed publication status while writer dispatch is unavailable", async () => {
  const row = await insertPending();
  vi.spyOn(stateWriter, "getOpenClawStateWorkerOwner").mockImplementation(() => {
    throw new Error("Writer dispatch unavailable");
  });
  await expect(readPending()).resolves.toMatchObject({
    request_id: row.request_id,
    status: "needs_confirmation",
  });
  await expect(
    publicationStore.readRepositoryGitHubPublicationAsync(row.request_id),
  ).resolves.toEqual(row);
});

it("returns the terminal receipt without executing an older confirmation", async () => {
  const row = await insertPending();
  const captured = expectDefined(await pending(), "original pending receipt");
  expect(captured.result.status).toBe("needs_confirmation");
  const confirmation = expectDefined(captured.confirmation, "original confirmation");
  const commandCount = commands.length;
  const execution = claimRepositoryGitHubPublicationFixture(row, "concurrent-publisher", {
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
  await expect(
    fixture.coordinator.confirmPersonalV2(
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
});

it.each([false, true])(
  "falls back to the non-repository owner only after an empty successful read (corrupt=%s)",
  async (corrupt) => {
    const published = await fixture.coordinator.requestPersonalForSessionV2(
      personalPublicationRequest(fixture, "worktree-pending"),
      fixture.action,
    );
    expect(published.status).toBe("published");
    db()
      .prepare("UPDATE github_personal_publication_requests SET status = ? WHERE request_id = ?")
      .run("needs_confirmation", published.requestId);
    const fallback = vi.spyOn(publicationStore, "readPersonalGitHubPublicationAsync");
    if (corrupt) {
      const row = await insertPending();
      corruptReceipt(row.request_id);
      await expect(pending()).rejects.toThrow(corruptReceiptError);
      expect(fallback).not.toHaveBeenCalled();
      return;
    }
    await expect(pending()).resolves.toMatchObject({
      result: { requestId: published.requestId, status: "needs_confirmation" },
      confirmation: { generation: fixture.generation, account },
    });
    expect(fallback).toHaveBeenCalledWith(fixture.owner, {
      sessionKey: SESSION_KEY,
      agentId: "main",
    });
  },
);
