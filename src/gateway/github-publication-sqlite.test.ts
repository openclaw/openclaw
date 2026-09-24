import { afterEach, describe, expect, it, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { onSessionLifecycleEvent } from "../sessions/session-lifecycle-events.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import {
  deferGitHubPublicationRequests,
  digestGitHubPublicationRequest,
} from "./github-publication-store.js";
import { installGitHubPublicationTestHarness } from "./github-publication.test-support.js";
import {
  insertSharedWorktreeReceipt,
  sharedPublicationCoordinator,
  sharedPublicationSession as session,
} from "./github-shared-publication.test-support.js";

installGitHubPublicationTestHarness();
afterEach(() => vi.restoreAllMocks());

describe("publication SQLite materialization", () => {
  it("discovers the latest current receipt without materializing its older history", () => {
    const coordinator = sharedPublicationCoordinator();
    runOpenClawStateWriteTransaction(() => {
      for (let index = 0; index < 70; index += 1) {
        insertSharedWorktreeReceipt(`history-${index}`, {
          createdAtMs: index,
          session: { ...session, lifecycleRevision: "retired" },
        });
      }
      insertSharedWorktreeReceipt("latest", { createdAtMs: 100 });
    });
    const db = openOpenClawStateDatabase().db;
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
      expect(coordinator.latestShared(session)).toMatchObject({
        confirmation: null,
        result: { requestId: "latest", status: "requested" },
      });
      expect(readRows()).toEqual(before);
      expect(observer).not.toHaveBeenCalled();
      expect(counter.counts.receipts).toBeGreaterThan(0);
      expect(counter.rowCounts.receipts).toBeLessThanOrEqual(1);
    } finally {
      counter.restore();
      stop();
    }
  });

  it("defers rich receipts with compact notifications while retaining rollback and input order", () => {
    const first = insertSharedWorktreeReceipt("first");
    const second = insertSharedWorktreeReceipt("second", {
      session: { ...session, sessionKey: session.sessionKey + ":other" },
    });
    const db = openOpenClawStateDatabase().db;
    const body = "synthetic publication body ".repeat(512);
    for (const row of [first, second]) {
      db.prepare(
        "UPDATE github_publication_requests SET body = ?, request_digest = ? WHERE request_id = ?",
      ).run(
        body,
        digestGitHubPublicationRequest({
          sessionId: row.session_id,
          idempotencyKey: row.idempotency_key,
          body,
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
        expect(() =>
          deferGitHubPublicationRequests(["first", "second", "first", "absent"]),
        ).toThrow("late defer failure");
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
        deferGitHubPublicationRequests(["first", "second", "first", "absent"]);
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
        expect(counter.textBytes.defer).toBeLessThan(512);
      } finally {
        counter.restore();
        clock.mockRestore();
      }
    } finally {
      stop();
    }
  });
});
