import { describe, expect, it, vi } from "vitest";
import {
  onSessionLifecycleEvent,
  type SessionLifecycleEvent,
} from "../sessions/session-lifecycle-events.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import {
  claimGitHubPublicationExecution,
  createGitHubPublicationExecutionStore,
  deferGitHubPublicationRequests,
  ensureGitHubPublicationStore,
  readGitHubPublicationRequest,
} from "./github-publication-store.js";
import {
  BRANCH,
  NEW_HEAD,
  OLD_HEAD,
  WORKSPACE_TREE,
  installGitHubPublicationTestHarness,
  seedLocalPublication,
  SESSION_KEY,
} from "./github-publication.test-support.js";
import {
  bindRepositoryGitHubPublicationCheckpoint,
  claimRepositoryGitHubPublication,
  deferRepositoryGitHubPublicationClaims,
  failRepositoryGitHubPublicationPreparation,
  failStaleRepositoryGitHubPublication,
  insertRepositoryGitHubPublication,
  readRepositoryGitHubPublication,
} from "./github-repository-publication-store.js";
import {
  insertSharedWorktreeReceipt,
  repositoryReceipt,
  sharedRepositoryWorkspace,
} from "./github-shared-publication.test-support.js";

installGitHubPublicationTestHarness();
const expectedEvent = { sessionKey: SESSION_KEY, agentId: "main", reason: "github-publication" };

describe("shared publication committed notifications", () => {
  it("notifies scoped observers only after an execution claim commits", () => {
    ensureGitHubPublicationStore();
    const database = openOpenClawStateDatabase();
    seedLocalPublication(database, { requestId: "claim", status: "requested" });
    const observations: unknown[] = [];
    const observer = vi.fn(() =>
      observations.push({
        inTransaction: database.db.isTransaction,
        row: database.db
          .prepare("SELECT status FROM github_publication_requests WHERE request_id = ?")
          .get("claim"),
      }),
    );
    const stop = onSessionLifecycleEvent(observer);
    try {
      claimGitHubPublicationExecution("claim", "current-instance");
      expect(observer).toHaveBeenCalledExactlyOnceWith(expectedEvent);
      expect(observations).toEqual([{ inTransaction: false, row: { status: "publishing" } }]);
    } finally {
      stop();
    }
  });

  it("publishes creation only on outer commit, not idempotent replay or a failed insertion", () => {
    ensureGitHubPublicationStore();
    const observer = vi.fn();
    const stop = onSessionLifecycleEvent(observer);
    try {
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
    } finally {
      stop();
    }
  });

  it("discards creation and claim notifications when their enclosing transaction rolls back", () => {
    insertSharedWorktreeReceipt("existing");
    const observer = vi.fn();
    const stop = onSessionLifecycleEvent(observer);
    try {
      expect(() =>
        runOpenClawStateWriteTransaction(() => {
          insertSharedWorktreeReceipt("rolled-back");
          claimGitHubPublicationExecution("existing", "instance");
          expect(observer).not.toHaveBeenCalled();
          throw new Error("rollback");
        }),
      ).toThrow("rollback");
      expect(observer).not.toHaveBeenCalled();
      const db = openOpenClawStateDatabase().db;
      expect(readGitHubPublicationRequest(db, { requestId: "rolled-back" })).toBeUndefined();
      expect(readGitHubPublicationRequest(db, { requestId: "existing" })?.status).toBe("requested");
    } finally {
      stop();
    }
  });

  it("drops a rolled-back savepoint's notification without losing a committed sibling", () => {
    ensureGitHubPublicationStore();
    const observer = vi.fn();
    const stop = onSessionLifecycleEvent(observer);
    try {
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
    } finally {
      stop();
    }
  });

  it("notifies facts, defer, and terminal writes but not a failed owner check or a terminal replay", () => {
    const row = insertSharedWorktreeReceipt("facts");
    const observer = vi.fn();
    const stop = onSessionLifecycleEvent(observer);
    try {
      let current = claimGitHubPublicationExecution(row.request_id, "instance");
      const store = createGitHubPublicationExecutionStore("instance");
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
        createGitHubPublicationExecutionStore("wrong-owner").updatePublishingFacts({
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
      deferGitHubPublicationRequests([row.request_id]);
      expect(observer).toHaveBeenCalledTimes(3);
      current = claimGitHubPublicationExecution(row.request_id, "instance");
      store.complete(current, {
        requestId: row.request_id,
        status: "failed",
        code: "push_rejected",
        message: "Rejected",
        nextAction: "Inspect GitHub before retrying.",
      });
      expect(observer).toHaveBeenCalledTimes(5);
      claimGitHubPublicationExecution(row.request_id, "instance");
      deferGitHubPublicationRequests([row.request_id, "absent"]);
      expect(observer).toHaveBeenCalledTimes(5);
      expect(
        observer.mock.calls.every(
          ([event]) => JSON.stringify(event) === JSON.stringify(expectedEvent),
        ),
      ).toBe(true);
    } finally {
      stop();
    }
  });

  it("publishes every repository receipt/effect transition after its committed write", () => {
    const workspace = sharedRepositoryWorkspace();
    const db = openOpenClawStateDatabase().db;
    const observations: Array<{ inTransaction: boolean; status?: string; effect?: string | null }> =
      [];
    const observer = vi.fn<(event: SessionLifecycleEvent) => void>(() => {
      const row = readRepositoryGitHubPublication("repository-request");
      observations.push({
        inTransaction: db.isTransaction,
        status: row?.status,
        effect: row?.effect_state,
      });
    });
    const stop = onSessionLifecycleEvent(observer);
    try {
      const unbound = repositoryReceipt(workspace.workspaceId, {
        checkpoint_ref: null,
        checkpoint_digest: null,
        source_head_commit: null,
        source_index_tree: null,
        workspace_tree: null,
      });
      let row = insertRepositoryGitHubPublication(unbound, () => {});
      insertRepositoryGitHubPublication(unbound, () => {});
      expect(observer).toHaveBeenCalledTimes(1);
      row = bindRepositoryGitHubPublicationCheckpoint(
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
      const execution = claimRepositoryGitHubPublication(row, "instance", {
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
    } finally {
      stop();
    }
  });

  it("never emits private repository receipt notifications, including claims, effects, interruption, and stale retirement", () => {
    const workspace = sharedRepositoryWorkspace();
    const observer = vi.fn();
    const stop = onSessionLifecycleEvent(observer);
    try {
      const row = insertRepositoryGitHubPublication(
        repositoryReceipt(workspace.workspaceId, {
          owner_profile_id: "private-person",
          connection_generation: "private-generation",
          identity_source: "personal",
        }),
        () => {},
      );
      const execution = claimRepositoryGitHubPublication(row, "instance", {
        assertCustody: () => {},
        assertCurrent: () => {},
      });
      execution.recordEffect("push");
      execution.recordEffect("push", { headCommit: NEW_HEAD });
      execution.interrupt();
      failStaleRepositoryGitHubPublication(
        readRepositoryGitHubPublication(row.request_id)!,
        () => false,
      );
      expect(readRepositoryGitHubPublication(row.request_id)?.status).toBe("failed");
      expect(observer).not.toHaveBeenCalled();
    } finally {
      stop();
    }
  });

  it("does not emit repository writes rolled back after claim/effect recording", () => {
    const workspace = sharedRepositoryWorkspace();
    const row = insertRepositoryGitHubPublication(
      repositoryReceipt(workspace.workspaceId),
      () => {},
    );
    const observer = vi.fn();
    const stop = onSessionLifecycleEvent(observer);
    try {
      expect(() =>
        runOpenClawStateWriteTransaction(() => {
          const execution = claimRepositoryGitHubPublication(row, "instance", {
            assertCustody: () => {},
            assertCurrent: () => {},
          });
          execution.recordEffect("push");
          expect(observer).not.toHaveBeenCalled();
          throw new Error("rollback");
        }),
      ).toThrow("rollback");
      expect(observer).not.toHaveBeenCalled();
      expect(readRepositoryGitHubPublication(row.request_id)).toMatchObject({
        status: "requested",
        last_effect: null,
      });
      const assertRevoked = () => {
        throw new Error("revoked");
      };
      expect(() =>
        claimRepositoryGitHubPublication(row, "instance", {
          assertCustody: assertRevoked,
          assertCurrent: assertRevoked,
        }),
      ).toThrow("revoked");
      expect(observer).not.toHaveBeenCalled();
    } finally {
      stop();
    }
  });

  it("notifies committed preparation failure, stale retirement, and deferred shared claims", () => {
    const workspace = sharedRepositoryWorkspace();
    const first = insertRepositoryGitHubPublication(
      repositoryReceipt(workspace.workspaceId, { checkpoint_ref: null, checkpoint_digest: null }),
      () => {},
    );
    const second = insertRepositoryGitHubPublication(
      repositoryReceipt(workspace.workspaceId, {
        request_id: "retired",
        idempotency_key: "retired",
      }),
      () => {},
    );
    const third = insertRepositoryGitHubPublication(
      repositoryReceipt(workspace.workspaceId, {
        request_id: "deferred",
        idempotency_key: "deferred",
        claim_id: "claim",
        run_id: "run",
        placement_generation: 1,
      }),
      () => {},
    );
    const observer = vi.fn();
    const stop = onSessionLifecycleEvent(observer);
    try {
      failRepositoryGitHubPublicationPreparation(first, "Capture a fresh checkpoint.", () => {});
      failStaleRepositoryGitHubPublication(second, () => false);
      deferRepositoryGitHubPublicationClaims([third.request_id]);
      expect(observer).toHaveBeenCalledTimes(3);
      failStaleRepositoryGitHubPublication(second, () => false);
      deferRepositoryGitHubPublicationClaims([first.request_id, "absent"]);
      expect(observer).toHaveBeenCalledTimes(3);
    } finally {
      stop();
    }
  });
});
