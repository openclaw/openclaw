import { describe, expect, it, onTestFinished, vi } from "vitest";
import type { SqliteCommittedFact } from "../infra/sqlite-commit-receipt.js";
import { onSessionLifecycleEvent } from "../sessions/session-lifecycle-events.js";
import { githubPublicationReceipts } from "../state/github-publication-receipts.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import {
  claimGitHubPublicationExecutionFixture as claimShared,
  createGitHubPublicationExecutionStoreFixture,
  deferGitHubPublicationRequestsFixture as deferShared,
  ensureGitHubPublicationStoreFixture,
  bindRepositoryGitHubPublicationCheckpointFixture,
  claimRepositoryGitHubPublicationFixture as claimRepository,
  deferRepositoryGitHubPublicationClaimsFixture,
  failRepositoryGitHubPublicationPreparationFixture,
  insertRepositoryGitHubPublicationFixture as insertRepository,
  readRepositoryGitHubPublicationFixture as readRepository,
} from "./github-publication-store.test-support.js";
import { readGitHubPublicationRequest } from "./github-publication-store.worker.js";
import {
  BRANCH,
  NEW_HEAD,
  OLD_HEAD,
  WORKSPACE_TREE,
  installGitHubPublicationTestHarness,
  SESSION_KEY,
} from "./github-publication.test-support.js";
import { failStaleRepositoryGitHubPublicationInDatabase } from "./github-repository-publication-store.worker.js";
import {
  insertSharedWorktreeReceipt,
  repositoryReceipt,
  sharedRepositoryWorkspace,
} from "./github-shared-publication.test-support.js";

installGitHubPublicationTestHarness();
const expectedEvent = { sessionKey: SESSION_KEY, agentId: "main", reason: "github-publication" };
const currentAuthority = { assertCustody() {}, assertCurrent() {} };
const noop = () => {};
const observe = (callback?: () => void) => {
  const observer = vi.fn(callback);
  return Object.assign(observer, { [Symbol.dispose]: onSessionLifecycleEvent(observer) });
};
const insertReceipt = (
  workspace: Parameters<typeof repositoryReceipt>[0],
  overrides: Parameters<typeof repositoryReceipt>[1] = {},
) => insertRepository(repositoryReceipt(workspace, overrides), noop);
const retire = (row: Parameters<typeof failStaleRepositoryGitHubPublicationInDatabase>[1]) =>
  runOpenClawStateWriteTransaction((database) =>
    failStaleRepositoryGitHubPublicationInDatabase(database, row, () => false),
  );
const expectRollback = (write: () => void, message = "rollback") => {
  expect(() =>
    runOpenClawStateWriteTransaction(() => {
      write();
      throw new Error(message);
    }),
  ).toThrow(message);
};
const subscribeFacts = (visit: (key: string, fact: SqliteCommittedFact<unknown>) => void) =>
  onTestFinished(
    githubPublicationReceipts.subscribeFacts((change) => {
      if (change.kind === "committed") {
        for (const [key, fact] of change.receipt.facts) {
          visit(key, fact);
        }
      }
    }),
  );
const postimage = (value: unknown) => ({ kind: "postimage", value });

describe("shared publication committed notifications", () => {
  it("installs the entire request/lifecycle batch before observers run", () => {
    const facts = new Map<string, SqliteCommittedFact<unknown>>();
    subscribeFacts((key, fact) => facts.set(key, fact));
    const observations: unknown[] = [];
    onTestFinished(
      onSessionLifecycleEvent(() => {
        observations.push({
          first: facts.get(JSON.stringify(["shared", "first"])),
          second: facts.get(JSON.stringify(["shared", "second"])),
          lifecycle: facts.get(JSON.stringify(["shared-lifecycle", "first"])),
        });
      }),
    );
    runOpenClawStateWriteTransaction(() => {
      insertSharedWorktreeReceipt("first");
      claimShared("first", "instance");
      expectRollback(() => insertSharedWorktreeReceipt("rolled-back"), "savepoint");
      insertSharedWorktreeReceipt("second");
      deferShared(["first", "second"]);
      expect(facts.size).toBe(0);
      expect(observations).toEqual([]);
    });
    expect(facts.has(JSON.stringify(["shared", "rolled-back"]))).toBe(false);
    expect(facts.has(JSON.stringify(["shared-lifecycle", "rolled-back"]))).toBe(false);
    expect(observations.length).toBeGreaterThan(0);
    for (const observation of observations) {
      expect(observation).toMatchObject({
        first: postimage({ request_id: "first", status: "requested", gateway_instance_id: null }),
        second: postimage({ request_id: "second", status: "requested" }),
        lifecycle: postimage({ publication_kind: "shared", request_id: "first" }),
      });
    }
  });

  it("publishes creation only on outer commit, not idempotent replay or a failed insertion", () => {
    ensureGitHubPublicationStoreFixture();
    using observer = observe();
    runOpenClawStateWriteTransaction(() => {
      insertSharedWorktreeReceipt("created");
      expect(observer).not.toHaveBeenCalled();
    });
    expect(observer).toHaveBeenCalledExactlyOnceWith(expectedEvent);
    insertSharedWorktreeReceipt("created");
    expect(observer).toHaveBeenCalledTimes(1);
    expect(() =>
      insertSharedWorktreeReceipt("conflict", { idempotencyKey: "created", branch: "other" }),
    ).toThrow(/idempotency/);
    expect(observer).toHaveBeenCalledTimes(1);
  });

  it("discards creation and claim notifications when their enclosing transaction rolls back", () => {
    insertSharedWorktreeReceipt("existing");
    using observer = observe();
    expectRollback(() => {
      insertSharedWorktreeReceipt("rolled-back");
      claimShared("existing", "instance");
      expect(observer).not.toHaveBeenCalled();
    });
    expect(observer).not.toHaveBeenCalled();
    const db = openOpenClawStateDatabase().db;
    expect(readGitHubPublicationRequest(db, { requestId: "rolled-back" })).toBeUndefined();
    expect(readGitHubPublicationRequest(db, { requestId: "existing" })?.status).toBe("requested");
  });

  it("drops a rolled-back savepoint's notification without losing a committed sibling", () => {
    ensureGitHubPublicationStoreFixture();
    using observer = observe();
    runOpenClawStateWriteTransaction(() => {
      expectRollback(() => insertSharedWorktreeReceipt("discarded"), "savepoint");
      insertSharedWorktreeReceipt("kept");
      expect(observer).not.toHaveBeenCalled();
    });
    expect(observer).toHaveBeenCalledExactlyOnceWith(expectedEvent);
  });

  it("notifies facts, defer, and terminal writes but not a failed owner check or a terminal replay", () => {
    const row = insertSharedWorktreeReceipt("facts");
    using observer = observe();
    let current = claimShared(row.request_id, "instance");
    const store = createGitHubPublicationExecutionStoreFixture("instance");
    const facts = {
      repository: "owner/repository",
      branch: BRANCH,
      baseBranch: "main",
      sourceHeadCommit: OLD_HEAD,
      workspaceTree: WORKSPACE_TREE,
      headCommit: NEW_HEAD,
    };
    current = store.updatePublishingFacts({ row: current, ...facts });
    expect(observer).toHaveBeenCalledTimes(2);
    expect(() =>
      createGitHubPublicationExecutionStoreFixture("wrong-owner").updatePublishingFacts({
        row: current,
        ...facts,
      }),
    ).toThrow(/state changed/);
    expect(observer).toHaveBeenCalledTimes(2);
    deferShared([row.request_id]);
    expect(observer).toHaveBeenCalledTimes(3);
    current = claimShared(row.request_id, "instance");
    store.complete(current, {
      requestId: row.request_id,
      status: "failed",
      code: "push_rejected",
      message: "Rejected",
      nextAction: "Inspect GitHub before retrying.",
    });
    expect(observer).toHaveBeenCalledTimes(5);
    claimShared(row.request_id, "instance");
    deferShared([row.request_id, "absent"]);
    expect(observer).toHaveBeenCalledTimes(5);
    expect(observer.mock.calls).toEqual(Array.from({ length: 5 }, () => [expectedEvent]));
  });

  it("publishes every repository receipt/effect transition after its committed write", async () => {
    const workspace = await sharedRepositoryWorkspace();
    const db = openOpenClawStateDatabase().db;
    const observations: Array<[boolean, string | undefined, string | null | undefined]> = [];
    using observer = observe(() => {
      const row = readRepository("repository-request");
      observations.push([db.isTransaction, row?.status, row?.effect_state]);
    });
    const unbound = repositoryReceipt(workspace, {
      checkpoint_ref: null,
      checkpoint_digest: null,
      source_head_commit: null,
      source_index_tree: null,
      workspace_tree: null,
    });
    let row = insertRepository(unbound, noop);
    insertRepository(unbound, noop);
    expect(observer).toHaveBeenCalledTimes(1);
    row = bindRepositoryGitHubPublicationCheckpointFixture(
      row,
      {
        checkpoint_ref: "refs/openclaw/worker-results/bound",
        checkpoint_digest: "sha256:" + "a".repeat(64),
        source_head_commit: OLD_HEAD,
        source_index_tree: WORKSPACE_TREE,
        workspace_tree: WORKSPACE_TREE,
      },
      noop,
    );
    const execution = claimRepository(row, "instance", currentAuthority);
    execution.recordEffect("push");
    execution.recordEffect("push", { headCommit: NEW_HEAD });
    execution.recordEffect("pull_request");
    execution.recordEffect("pull_request", { url: "https://github.com/owner/repository/pull/3" });
    execution.complete({
      requestId: row.request_id,
      status: "published",
      headCommit: NEW_HEAD,
      repository: "owner/repository",
      branch: row.branch,
      url: "https://github.com/owner/repository/pull/3",
    });
    expect(observer).toHaveBeenCalledTimes(8);
    expect(observations.map(([, status, effect]) => [status, effect])).toEqual([
      ["requested", null],
      ["requested", null],
      ["publishing", null],
      ["publishing", "dispatched"],
      ["publishing", "observed"],
      ["publishing", "dispatched"],
      ["publishing", "observed"],
      ["published", "observed"],
    ]);
    expect(observations.every(([inTransaction]) => !inTransaction)).toBe(true);
    expect(observer.mock.calls).toEqual(Array.from({ length: 8 }, () => [expectedEvent]));
  });

  it("never emits private repository receipt notifications, including claims, effects, interruption, and stale retirement", async () => {
    const workspace = await sharedRepositoryWorkspace();
    using observer = observe();
    const receiptRows: unknown[] = [];
    subscribeFacts((_key, fact) => {
      if (fact.kind === "postimage") {
        receiptRows.push(fact.value);
      }
    });
    const row = insertReceipt(workspace, {
      owner_profile_id: "private-person",
      connection_generation: "private-generation",
      identity_source: "personal",
    });
    const execution = claimRepository(row, "instance", currentAuthority);
    execution.recordEffect("push");
    execution.recordEffect("push", { headCommit: NEW_HEAD });
    execution.interrupt();
    retire(readRepository(row.request_id)!);
    expect(readRepository(row.request_id)?.status).toBe("failed");
    expect(receiptRows).toHaveLength(6);
    const {
      title: _title,
      body: _body,
      next_action: _nextAction,
      ...authority
    } = readRepository(row.request_id)!;
    expect(receiptRows.at(-1)).toEqual(authority);
    expect(observer).not.toHaveBeenCalled();
  });

  it("does not emit repository writes rolled back after claim/effect recording", async () => {
    const workspace = await sharedRepositoryWorkspace();
    const row = insertReceipt(workspace);
    using observer = observe();
    expectRollback(() => {
      const execution = claimRepository(row, "instance", currentAuthority);
      execution.recordEffect("push");
      expect(observer).not.toHaveBeenCalled();
    });
    expect(observer).not.toHaveBeenCalled();
    expect(readRepository(row.request_id)).toMatchObject({
      status: "requested",
      last_effect: null,
    });
    const assertRevoked = () => {
      throw new Error("revoked");
    };
    expect(() =>
      claimRepository(row, "instance", {
        assertCustody: assertRevoked,
        assertCurrent: assertRevoked,
      }),
    ).toThrow("revoked");
    expect(observer).not.toHaveBeenCalled();
  });

  it("notifies committed preparation failure, stale retirement, and deferred shared claims", async () => {
    const workspace = await sharedRepositoryWorkspace();
    const first = insertReceipt(workspace, { checkpoint_ref: null, checkpoint_digest: null });
    const second = insertReceipt(workspace, { request_id: "retired", idempotency_key: "retired" });
    const third = insertReceipt(workspace, {
      request_id: "deferred",
      idempotency_key: "deferred",
      claim_id: "claim",
      run_id: "run",
      placement_generation: 1,
    });
    using observer = observe();
    failRepositoryGitHubPublicationPreparationFixture(first, "Capture a fresh checkpoint.", noop);
    retire(second);
    deferRepositoryGitHubPublicationClaimsFixture([third.request_id]);
    expect(observer).toHaveBeenCalledTimes(3);
    retire(second);
    deferRepositoryGitHubPublicationClaimsFixture([first.request_id, "absent"]);
    expect(observer).toHaveBeenCalledTimes(3);
  });
});
