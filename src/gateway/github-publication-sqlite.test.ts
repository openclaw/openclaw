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

const database = () => requireNativeSqliteDatabase(openOpenClawStateDatabase().db);
const readRows = () =>
  database().prepare("SELECT * FROM github_publication_requests ORDER BY request_id").all();
const readCurrent = () =>
  readShared(
    database(),
    session,
    {},
    githubPublicationTestMocks().loadSession(session.sessionKey).entry,
  );
function observePublications() {
  const observer = vi.fn();
  return Object.assign(observer, { [Symbol.dispose]: onSessionLifecycleEvent(observer) });
}
function countStatements<Key extends string>(key: Key, matches: (sql: string) => boolean) {
  const counter = trackSqliteStatementExecutions(database(), [key], (sql) =>
    matches(sql) ? key : null,
  );
  return Object.assign(counter, { [Symbol.dispose]: counter.restore });
}

describe("publication SQLite materialization", () => {
  it.each(["shared", "repository"] as const)(
    "materializes %s without rereads and preserves replay",
    async (kind) => {
      const db = database();
      const workspace = kind === "repository" ? await sharedRepositoryWorkspace() : undefined;
      const row = workspace && repositoryReceipt(workspace);
      const id = row?.request_id ?? "inserted";
      const insert = (requestId: string, mismatch = false) =>
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
            });
      const read = () =>
        row ? readRepository(id) : readGitHubPublicationRequest(db, { requestId: id });
      const table = row
        ? /\bfrom "github_repository_publication_requests"/
        : /\bfrom "github_publication_(?:requests|session_lifecycles)"/;
      let inserted: ReturnType<typeof insert>;
      {
        using counter = countStatements(
          "rereads",
          (sql) => /^select\b/i.test(sql) && table.test(sql),
        );
        inserted = insert(id);
        expect(inserted).toEqual(
          row ?? expect.objectContaining({ request_id: id, status: "requested" }),
        );
        expect(counter.counts.rereads).toBe(0);
      }
      expect(read()).toEqual(inserted);
      if (row) {
        claimRepository(row, "publisher", { assertCurrent() {}, assertCustody() {} });
      } else {
        claimExecution(id, "publisher");
      }
      expect(insert("replayed")).toMatchObject({
        request_id: id,
        status: "publishing",
        gateway_instance_id: "publisher",
      });
      expect(() => insert("mismatched", true)).toThrow("idempotency key was reused");
      expect(read()).toMatchObject({
        request_id: id,
        status: "publishing",
        ...(row ? { title: null } : { branch: BRANCH }),
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
    const before = readRows();
    using observer = observePublications();
    using counter = countStatements(
      "receipts",
      (sql) => /^select\b/i.test(sql) && /\bfrom "github_publication_requests"/.test(sql),
    );
    expect(readCurrent()).toMatchObject({ request_id: "latest", status: "requested" });
    expect(readRows()).toEqual(before);
    expect(observer).not.toHaveBeenCalled();
    expect(counter.counts.receipts).toBeGreaterThan(0);
    expect(counter.rowCounts.receipts).toBeLessThanOrEqual(1);
  });

  it("observes no current publication after worktree GC retires the session checkout", async () => {
    insertSharedWorktreeReceipt("latest");
    await updateRegistryWorktree(process.env, "worktree-1", { removedAt: 2 });
    expect(readCurrent()).toBeUndefined();
  });

  it("defers rich receipts with authority postimages while retaining rollback and input order", () => {
    const first = insertSharedWorktreeReceipt("first");
    const second = insertSharedWorktreeReceipt("second", {
      session: { ...session, sessionKey: session.sessionKey + ":other" },
    });
    const db = database();
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
    const before = readRows();
    using observer = observePublications();
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
    vi.spyOn(Date, "now").mockReturnValue(now);
    using counter = countStatements("defer", (sql) =>
      sql.startsWith('update "github_publication_requests"'),
    );
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
    expect(counter.textBytes.defer).toBeLessThan(2048);
  });
});
