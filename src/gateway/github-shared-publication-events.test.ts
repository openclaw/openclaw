import { describe, expect, it, onTestFinished, vi } from "vitest";
import type { SqliteCommittedFact } from "../infra/sqlite-commit-receipt.js";
import {
  onSessionLifecycleEvent,
  type SessionLifecycleEvent,
} from "../sessions/session-lifecycle-events.js";
import { githubPublicationReceipts } from "../state/github-publication-receipts.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import {
  claimGitHubPublicationExecutionFixture,
  createGitHubPublicationExecutionStoreFixture,
  deferGitHubPublicationRequestsFixture,
  ensureGitHubPublicationStoreFixture,
  bindRepositoryGitHubPublicationCheckpointFixture,
  claimRepositoryGitHubPublicationFixture,
  deferRepositoryGitHubPublicationClaimsFixture,
  failRepositoryGitHubPublicationPreparationFixture,
  insertRepositoryGitHubPublicationFixture,
  readRepositoryGitHubPublicationFixture,
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

describe("shared publication committed notifications", () => {
  it("installs the entire request/lifecycle batch before observers run", () => {
    const facts = new Map<string, SqliteCommittedFact<unknown>>();
    onTestFinished(
      githubPublicationReceipts.subscribeFacts((change) => {
        if (change.kind === "committed") {
          for (const [key, value] of change.receipt.facts) {
            facts.set(key, value);
          }
        }
      }),
    );
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
      claimGitHubPublicationExecutionFixture("first", "instance");
      expect(() =>
        runOpenClawStateWriteTransaction(() => {
          insertSharedWorktreeReceipt("rolled-back");
          throw new Error("savepoint");
        }),
      ).toThrow("savepoint");
      insertSharedWorktreeReceipt("second");
      deferGitHubPublicationRequestsFixture(["first", "second"]);
      expect(facts.size).toBe(0);
      expect(observations).toEqual([]);
    });
    expect(facts.has(JSON.stringify(["shared", "rolled-back"]))).toBe(false);
    expect(facts.has(JSON.stringify(["shared-lifecycle", "rolled-back"]))).toBe(false);
    expect(observations.length).toBeGreaterThan(0);
    for (const observation of observations) {
      expect(observation).toMatchObject({
        first: {
          kind: "postimage",
          value: { request_id: "first", status: "requested", gateway_instance_id: null },
        },
        second: { kind: "postimage", value: { request_id: "second", status: "requested" } },
        lifecycle: {
          kind: "postimage",
          value: { publication_kind: "shared", request_id: "first" },
        },
      });
    }
  });

  it("publishes creation only on outer commit, not idempotent replay or a failed insertion", () => {
    ensureGitHubPublicationStoreFixture();
    const observer = vi.fn();
    using _ = { [Symbol.dispose]: onSessionLifecycleEvent(observer) };
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
    const observer = vi.fn();
    using _ = { [Symbol.dispose]: onSessionLifecycleEvent(observer) };
    expect(() =>
      runOpenClawStateWriteTransaction(() => {
        insertSharedWorktreeReceipt("rolled-back");
        claimGitHubPublicationExecutionFixture("existing", "instance");
        expect(observer).not.toHaveBeenCalled();
        throw new Error("rollback");
      }),
    ).toThrow("rollback");
    expect(observer).not.toHaveBeenCalled();
    const db = openOpenClawStateDatabase().db;
    expect(readGitHubPublicationRequest(db, { requestId: "rolled-back" })).toBeUndefined();
    expect(readGitHubPublicationRequest(db, { requestId: "existing" })?.status).toBe("requested");
  });

  it("drops a rolled-back savepoint's notification without losing a committed sibling", () => {
    ensureGitHubPublicationStoreFixture();
    const observer = vi.fn();
    using _ = { [Symbol.dispose]: onSessionLifecycleEvent(observer) };
    runOpenClawStateWriteTransaction(() => {
      expect(() =>
        runOpenClawStateWriteTransaction(() => {
          insertSharedWorktreeReceipt("discarded");
          throw new Error("savepoint");
        }),
      ).toThrow("savepoint");
      insertSharedWorktreeReceipt("kept");
      expect(observer).not.toHaveBeenCalled();
    });
    expect(observer).toHaveBeenCalledExactlyOnceWith(expectedEvent);
  });

  it("notifies facts, defer, and terminal writes but not a failed owner check or a terminal replay", () => {
    const row = insertSharedWorktreeReceipt("facts");
    const observer = vi.fn();
    using _ = { [Symbol.dispose]: onSessionLifecycleEvent(observer) };
    let current = claimGitHubPublicationExecutionFixture(row.request_id, "instance");
    const store = createGitHubPublicationExecutionStoreFixture("instance");
    current = store.updatePublishingFacts({
      row: current,
      repository: "owner/repository",
      branch: BRANCH,
      baseBranch: "main",
      sourceHeadCommit: OLD_HEAD,
      workspaceTree: WORKSPACE_TREE,
      headCommit: NEW_HEAD,
    });
    expect(observer).toHaveBeenCalledTimes(2);
    expect(() =>
      createGitHubPublicationExecutionStoreFixture("wrong-owner").updatePublishingFacts({
        row: current,
        repository: "owner/repository",
        branch: BRANCH,
        baseBranch: "main",
        sourceHeadCommit: OLD_HEAD,
        workspaceTree: WORKSPACE_TREE,
        headCommit: NEW_HEAD,
      }),
    ).toThrow(/state changed/);
    expect(observer).toHaveBeenCalledTimes(2);
    deferGitHubPublicationRequestsFixture([row.request_id]);
    expect(observer).toHaveBeenCalledTimes(3);
    current = claimGitHubPublicationExecutionFixture(row.request_id, "instance");
    store.complete(current, {
      requestId: row.request_id,
      status: "failed",
      code: "push_rejected",
      message: "Rejected",
      nextAction: "Inspect GitHub before retrying.",
    });
    expect(observer).toHaveBeenCalledTimes(5);
    claimGitHubPublicationExecutionFixture(row.request_id, "instance");
    deferGitHubPublicationRequestsFixture([row.request_id, "absent"]);
    expect(observer).toHaveBeenCalledTimes(5);
    expect(
      observer.mock.calls.every(
        ([event]) => JSON.stringify(event) === JSON.stringify(expectedEvent),
      ),
    ).toBe(true);
  });

  it("publishes every repository receipt/effect transition after its committed write", async () => {
    const workspace = await sharedRepositoryWorkspace();
    const db = openOpenClawStateDatabase().db;
    const observations: Array<{ inTransaction: boolean; status?: string; effect?: string | null }> =
      [];
    const observer = vi.fn<(event: SessionLifecycleEvent) => void>(() => {
      const row = readRepositoryGitHubPublicationFixture("repository-request");
      observations.push({
        inTransaction: db.isTransaction,
        status: row?.status,
        effect: row?.effect_state,
      });
    });
    using _ = { [Symbol.dispose]: onSessionLifecycleEvent(observer) };
    const unbound = repositoryReceipt(workspace, {
      checkpoint_ref: null,
      checkpoint_digest: null,
      source_head_commit: null,
      source_index_tree: null,
      workspace_tree: null,
    });
    let row = insertRepositoryGitHubPublicationFixture(unbound, () => {});
    insertRepositoryGitHubPublicationFixture(unbound, () => {});
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
      () => {},
    );
    const execution = claimRepositoryGitHubPublicationFixture(row, "instance", {
      assertCustody: () => {},
      assertCurrent: () => {},
    });
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
    expect(observations.map(({ status, effect }) => [status, effect])).toEqual([
      ["requested", null],
      ["requested", null],
      ["publishing", null],
      ["publishing", "dispatched"],
      ["publishing", "observed"],
      ["publishing", "dispatched"],
      ["publishing", "observed"],
      ["published", "observed"],
    ]);
    expect(observations.every((observation) => !observation.inTransaction)).toBe(true);
    for (const [event] of observer.mock.calls) {
      expect(event).toEqual(expectedEvent);
    }
  });

  it("never emits private repository receipt notifications, including claims, effects, interruption, and stale retirement", async () => {
    const workspace = await sharedRepositoryWorkspace();
    const observer = vi.fn();
    const receiptRows: unknown[] = [];
    onTestFinished(
      githubPublicationReceipts.subscribeFacts((change) => {
        if (change.kind === "committed") {
          for (const fact of change.receipt.facts.values()) {
            if (fact.kind === "postimage") {
              receiptRows.push(fact.value);
            }
          }
        }
      }),
    );
    using _ = { [Symbol.dispose]: onSessionLifecycleEvent(observer) };
    const row = insertRepositoryGitHubPublicationFixture(
      repositoryReceipt(workspace, {
        owner_profile_id: "private-person",
        connection_generation: "private-generation",
        identity_source: "personal",
      }),
      () => {},
    );
    const execution = claimRepositoryGitHubPublicationFixture(row, "instance", {
      assertCustody: () => {},
      assertCurrent: () => {},
    });
    execution.recordEffect("push");
    execution.recordEffect("push", { headCommit: NEW_HEAD });
    execution.interrupt();
    runOpenClawStateWriteTransaction((database) =>
      failStaleRepositoryGitHubPublicationInDatabase(
        database,
        readRepositoryGitHubPublicationFixture(row.request_id)!,
        () => false,
      ),
    );
    expect(readRepositoryGitHubPublicationFixture(row.request_id)?.status).toBe("failed");
    expect(receiptRows).toHaveLength(6);
    const {
      title: _title,
      body: _body,
      next_action: _nextAction,
      ...authority
    } = readRepositoryGitHubPublicationFixture(row.request_id)!;
    expect(receiptRows.at(-1)).toEqual(authority);
    expect(observer).not.toHaveBeenCalled();
  });

  it("does not emit repository writes rolled back after claim/effect recording", async () => {
    const workspace = await sharedRepositoryWorkspace();
    const row = insertRepositoryGitHubPublicationFixture(repositoryReceipt(workspace), () => {});
    const observer = vi.fn();
    using _ = { [Symbol.dispose]: onSessionLifecycleEvent(observer) };
    expect(() =>
      runOpenClawStateWriteTransaction(() => {
        const execution = claimRepositoryGitHubPublicationFixture(row, "instance", {
          assertCustody: () => {},
          assertCurrent: () => {},
        });
        execution.recordEffect("push");
        expect(observer).not.toHaveBeenCalled();
        throw new Error("rollback");
      }),
    ).toThrow("rollback");
    expect(observer).not.toHaveBeenCalled();
    expect(readRepositoryGitHubPublicationFixture(row.request_id)).toMatchObject({
      status: "requested",
      last_effect: null,
    });
    const assertRevoked = () => {
      throw new Error("revoked");
    };
    expect(() =>
      claimRepositoryGitHubPublicationFixture(row, "instance", {
        assertCustody: assertRevoked,
        assertCurrent: assertRevoked,
      }),
    ).toThrow("revoked");
    expect(observer).not.toHaveBeenCalled();
  });

  it("notifies committed preparation failure, stale retirement, and deferred shared claims", async () => {
    const workspace = await sharedRepositoryWorkspace();
    const first = insertRepositoryGitHubPublicationFixture(
      repositoryReceipt(workspace, { checkpoint_ref: null, checkpoint_digest: null }),
      () => {},
    );
    const second = insertRepositoryGitHubPublicationFixture(
      repositoryReceipt(workspace, {
        request_id: "retired",
        idempotency_key: "retired",
      }),
      () => {},
    );
    const third = insertRepositoryGitHubPublicationFixture(
      repositoryReceipt(workspace, {
        request_id: "deferred",
        idempotency_key: "deferred",
        claim_id: "claim",
        run_id: "run",
        placement_generation: 1,
      }),
      () => {},
    );
    const observer = vi.fn();
    using _ = { [Symbol.dispose]: onSessionLifecycleEvent(observer) };
    failRepositoryGitHubPublicationPreparationFixture(
      first,
      "Capture a fresh checkpoint.",
      () => {},
    );
    runOpenClawStateWriteTransaction((database) =>
      failStaleRepositoryGitHubPublicationInDatabase(database, second, () => false),
    );
    deferRepositoryGitHubPublicationClaimsFixture([third.request_id]);
    expect(observer).toHaveBeenCalledTimes(3);
    runOpenClawStateWriteTransaction((database) =>
      failStaleRepositoryGitHubPublicationInDatabase(database, second, () => false),
    );
    deferRepositoryGitHubPublicationClaimsFixture([first.request_id, "absent"]);
    expect(observer).toHaveBeenCalledTimes(3);
  });
});
