import { afterEach, describe, expect, it, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { updateRegistryWorktree } from "../agents/worktrees/registry.js";
import { onSessionLifecycleEvent } from "../sessions/session-lifecycle-events.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { requireNativeSqliteDatabase } from "../test-utils/native-sqlite.js";
import { digestGitHubPublicationRequest as requestDigest } from "./github-publication-receipt.js";
import { readSharedGitHubPublicationRequestInDatabase as readShared } from "./github-publication-shared-read.kernel.js";
import {
  claimGitHubPublicationExecutionFixture as claimExecution,
  claimRepositoryGitHubPublicationFixture as claimRepository,
  deferGitHubPublicationRequestsFixture as deferRequests,
  insertRepositoryGitHubPublicationFixture as insertRepository,
  readRepositoryGitHubPublicationFixture as readRepository,
} from "./github-publication-store.test-support.js";
import { readGitHubPublicationRequest } from "./github-publication-store.worker.js";
import {
  githubPublicationTestMocks,
  installGitHubPublicationTestHarness,
  BRANCH,
} from "./github-publication.test-support.js";
import {
  insertSharedWorktreeReceipt,
  repositoryReceipt,
  sharedPublicationSession as session,
  sharedRepositoryWorkspace,
} from "./github-shared-publication.test-support.js";

installGitHubPublicationTestHarness();
afterEach(() => vi.restoreAllMocks());

async function replayFixture(kind: "shared" | "repository") {
  const db = requireNativeSqliteDatabase(openOpenClawStateDatabase().db);
  const workspace = kind === "repository" ? await sharedRepositoryWorkspace() : undefined;
  const row = workspace && repositoryReceipt(workspace);
  const id = row?.request_id ?? "inserted";
  return {
    db,
    id,
    initial: row ?? expect.objectContaining({ request_id: id, status: "requested" }),
    retained: row ? { title: null } : { branch: BRANCH },
    table: row
      ? /\bfrom "github_repository_publication_requests"/
      : /\bfrom "github_publication_(?:requests|session_lifecycles)"/,
    insert: (requestId: string, mismatch = false) =>
      workspace
        ? insertRepository(
            repositoryReceipt(workspace, {
              request_id: requestId,
              ...(mismatch ? { title: "Different request" } : {}),
            }),
            () => {},
          )
        : insertSharedWorktreeReceipt(requestId, {
            idempotencyKey: "same-request",
            ...(mismatch ? { branch: "different-branch" } : {}),
          }),
    read: () => (row ? readRepository(id) : readGitHubPublicationRequest(db, { requestId: id })),
    claim: () =>
      row
        ? claimRepository(row, "publisher", { assertCurrent() {}, assertCustody() {} })
        : claimExecution(id, "publisher"),
  };
}

describe("publication SQLite materialization", () => {
  it.each(["shared", "repository"] as const)(
    "materializes %s without rereads and preserves replay",
    async (kind) => {
      const f = await replayFixture(kind);
      const { db } = f;
      const counter = trackSqliteStatementExecutions(db, ["rereads"], (sql) =>
        /^select\b/i.test(sql) && f.table.test(sql) ? "rereads" : null,
      );
      let inserted: ReturnType<typeof f.insert>;
      try {
        inserted = f.insert(f.id);
        expect(inserted).toEqual(f.initial);
        expect(counter.counts.rereads).toBe(0);
      } finally {
        counter.restore();
      }
      expect(f.read()).toEqual(inserted);
      f.claim();
      expect(f.insert("replayed")).toMatchObject({
        request_id: f.id,
        status: "publishing",
        gateway_instance_id: "publisher",
      });
      expect(() => f.insert("mismatched", true)).toThrow("idempotency key was reused");
      expect(f.read()).toMatchObject({
        request_id: f.id,
        status: "publishing",
        ...f.retained,
      });
    },
  );

  it("discovers the latest current receipt without materializing its older history", () => {
    runOpenClawStateWriteTransaction(() => {
      for (let index = 0; index < 70; index += 1) {
        insertSharedWorktreeReceipt(`history-${index}`, {
          createdAtMs: index,
          session: { ...session, lifecycleRevision: "retired" },
        });
      }
      insertSharedWorktreeReceipt("latest", { createdAtMs: 100 });
    });
    const db = requireNativeSqliteDatabase(openOpenClawStateDatabase().db);
    const readRows = () =>
      db.prepare("SELECT * FROM github_publication_requests ORDER BY request_id").all();
    const before = readRows();
    const observer = vi.fn();
    const stop = onSessionLifecycleEvent(observer);
    const counter = trackSqliteStatementExecutions(db, ["receipts"], (sql) =>
      /^select\b/i.test(sql) && /\bfrom "github_publication_requests"/.test(sql)
        ? "receipts"
        : null,
    );
    try {
      expect(
        readShared(
          db,
          session,
          {},
          githubPublicationTestMocks().loadSession(session.sessionKey).entry,
        ),
      ).toMatchObject({ request_id: "latest", status: "requested" });
      expect(readRows()).toEqual(before);
      expect(observer).not.toHaveBeenCalled();
      expect(counter.counts.receipts).toBeGreaterThan(0);
      expect(counter.rowCounts.receipts).toBeLessThanOrEqual(1);
    } finally {
      counter.restore();
      stop();
    }
  });

  it("observes no current publication after worktree GC retires the session checkout", async () => {
    insertSharedWorktreeReceipt("latest");
    await updateRegistryWorktree(process.env, "worktree-1", { removedAt: 2 });
    expect(
      readShared(
        openOpenClawStateDatabase().db,
        session,
        {},
        githubPublicationTestMocks().loadSession(session.sessionKey).entry,
      ),
    ).toBeUndefined();
  });

  it("defers rich receipts with authority postimages while retaining rollback and input order", () => {
    const first = insertSharedWorktreeReceipt("first");
    const second = insertSharedWorktreeReceipt("second", {
      session: { ...session, sessionKey: session.sessionKey + ":other" },
    });
    const db = requireNativeSqliteDatabase(openOpenClawStateDatabase().db);
    const body = "synthetic publication body ".repeat(512);
    for (const row of [first, second]) {
      db.prepare(
        "UPDATE github_publication_requests SET body = ?, request_digest = ? WHERE request_id = ?",
      ).run(
        body,
        requestDigest({
          sessionId: row.session_id,
          idempotencyKey: row.idempotency_key,
          body,
          draft: row.draft === 1,
        }),
        row.request_id,
      );
    }
    const readRows = () =>
      db.prepare("SELECT * FROM github_publication_requests ORDER BY request_id").all();
    const before = readRows();
    const observer = vi.fn();
    const stop = onSessionLifecycleEvent(observer);
    try {
      db.exec(
        "CREATE TRIGGER fail_second_defer BEFORE UPDATE ON github_publication_requests WHEN NEW.request_id = 'second' BEGIN SELECT RAISE(ABORT, 'late defer failure'); END",
      );
      try {
        expect(() => deferRequests(["first", "second", "first", "absent"])).toThrow(
          "late defer failure",
        );
        expect(readRows()).toEqual(before);
        expect(observer).not.toHaveBeenCalled();
      } finally {
        db.exec("DROP TRIGGER fail_second_defer");
      }
      const now = Date.now();
      const clock = vi.spyOn(Date, "now").mockReturnValue(now);
      const counter = trackSqliteStatementExecutions(db, ["defer"], (sql) =>
        sql.startsWith('update "github_publication_requests"') ? "defer" : null,
      );
      try {
        deferRequests(["first", "second", "first", "absent"]);
        expect(readRows()).toEqual(
          before.map((row) =>
            Object.assign({}, row, {
              claim_id: null,
              run_id: null,
              environment_id: null,
              owner_epoch: null,
              placement_generation: null,
              status: "requested",
              gateway_instance_id: null,
              updated_at_ms: now,
            }),
          ),
        );
        expect(observer.mock.calls.map(([event]) => event)).toEqual(
          [first, second, first].map((row) => ({
            sessionKey: row.session_key,
            agentId: row.agent_id,
            reason: "github-publication",
          })),
        );
        expect(db.isTransaction).toBe(false);
        expect(counter.rowCounts.defer).toBeGreaterThan(0);
        expect(counter.rowCounts.defer).toBeLessThanOrEqual(3);
        const authorityPostimageTextBudget = 2048;
        expect(counter.textBytes.defer).toBeLessThan(authorityPostimageTextBudget);
      } finally {
        counter.restore();
        clock.mockRestore();
      }
    } finally {
      stop();
    }
  });
});
