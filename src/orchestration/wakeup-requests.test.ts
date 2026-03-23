/**
 * Tests for wakeup-requests-sqlite.ts (Paperclip sync)
 *
 * Covers:
 * - createWakeupRequest + listPendingWakeupRequests round-trip
 * - markWakeupProcessing changes status
 * - markWakeupCompleted sets processedAt
 * - listPendingWakeupRequests excludes completed/failed
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runMigrations } from "../infra/state-db/schema.js";
import { requireNodeSqlite } from "../memory/sqlite.js";

type TestDb = ReturnType<typeof requireNodeSqlite>["DatabaseSync"]["prototype"];
let testDb: TestDb;

vi.mock("../infra/state-db/connection.js", () => ({ getStateDb: () => testDb }));
vi.mock("../infra/state-db/index.js", () => ({ getStateDb: () => testDb }));

import {
  createWakeupRequest,
  listPendingWakeupRequests,
  markWakeupCompleted,
  markWakeupFailed,
  markWakeupProcessing,
} from "./wakeup-requests-sqlite.js";
import { createWorkspace } from "./workspace-store-sqlite.js";

describe("wakeup-requests-sqlite", () => {
  beforeEach(() => {
    const { DatabaseSync } = requireNodeSqlite();
    testDb = new DatabaseSync(":memory:");
    testDb.exec("PRAGMA journal_mode = WAL");
    testDb.exec("PRAGMA foreign_keys = ON");
    runMigrations(testDb);
  });

  afterEach(() => {
    try {
      testDb.close();
    } catch {
      // ignore
    }
  });

  // ── createWakeupRequest ───────────────────────────────────────────

  describe("createWakeupRequest", () => {
    it("creates a pending wakeup request with defaults", () => {
      const req = createWakeupRequest({ agentId: "agent-neo" });

      expect(req.id).toBeTruthy();
      expect(req.agentId).toBe("agent-neo");
      expect(req.workspaceId).toBe("default");
      expect(req.reason).toBe("task_assigned");
      expect(req.status).toBe("pending");
      expect(req.taskId).toBeNull();
      expect(req.payloadJson).toBeNull();
      expect(req.processedAt).toBeNull();
      expect(typeof req.createdAt).toBe("number");
    });

    it("stores all optional fields when provided", () => {
      const ws = createWorkspace({ name: "Wakeup Ops WS" });
      const req = createWakeupRequest({
        agentId: "agent-morpheus",
        workspaceId: ws.id,
        taskId: "task-99",
        reason: "review_requested",
        payloadJson: '{"priority":"high"}',
      });

      expect(req.agentId).toBe("agent-morpheus");
      expect(req.workspaceId).toBe(ws.id);
      expect(req.taskId).toBe("task-99");
      expect(req.reason).toBe("review_requested");
      expect(req.payloadJson).toBe('{"priority":"high"}');
    });
  });

  // ── listPendingWakeupRequests round-trip ──────────────────────────

  describe("listPendingWakeupRequests round-trip", () => {
    it("returns newly created pending requests", () => {
      createWakeupRequest({ agentId: "agent-a" });
      createWakeupRequest({ agentId: "agent-b" });

      const pending = listPendingWakeupRequests();
      expect(pending.length).toBeGreaterThanOrEqual(2);
      expect(pending.every((r) => r.status === "pending")).toBe(true);
    });

    it("filters by agentId when provided", () => {
      createWakeupRequest({ agentId: "agent-x" });
      createWakeupRequest({ agentId: "agent-y" });

      const forX = listPendingWakeupRequests("agent-x");
      expect(forX.length).toBeGreaterThanOrEqual(1);
      expect(forX.every((r) => r.agentId === "agent-x")).toBe(true);
    });

    it("returns requests in ascending createdAt order", () => {
      createWakeupRequest({ agentId: "ordered-agent" });
      createWakeupRequest({ agentId: "ordered-agent" });
      createWakeupRequest({ agentId: "ordered-agent" });

      const pending = listPendingWakeupRequests("ordered-agent");
      expect(pending.length).toBeGreaterThanOrEqual(2);
      for (let i = 1; i < pending.length; i++) {
        expect(pending[i].createdAt).toBeGreaterThanOrEqual(pending[i - 1].createdAt);
      }
    });
  });

  // ── markWakeupProcessing ──────────────────────────────────────────

  describe("markWakeupProcessing", () => {
    it("changes status from pending to processing", () => {
      const req = createWakeupRequest({ agentId: "agent-proc" });
      markWakeupProcessing(req.id);

      // Should no longer appear in pending list
      const pending = listPendingWakeupRequests("agent-proc");
      expect(pending.find((r) => r.id === req.id)).toBeUndefined();
    });

    it("removes the request from pending list for its agent", () => {
      const req1 = createWakeupRequest({ agentId: "shared-agent" });
      createWakeupRequest({ agentId: "shared-agent" });

      markWakeupProcessing(req1.id);

      const pending = listPendingWakeupRequests("shared-agent");
      expect(pending.find((r) => r.id === req1.id)).toBeUndefined();
      // The second request remains pending
      expect(pending).toHaveLength(1);
    });
  });

  // ── markWakeupCompleted ───────────────────────────────────────────

  describe("markWakeupCompleted", () => {
    it("excludes completed requests from the pending list", () => {
      const req = createWakeupRequest({ agentId: "agent-done" });
      markWakeupCompleted(req.id);

      const pending = listPendingWakeupRequests("agent-done");
      expect(pending.find((r) => r.id === req.id)).toBeUndefined();
    });

    it("sets processedAt to a non-null value", () => {
      // We verify via side-effects: after markWakeupCompleted the row is gone
      // from pending. Direct DB inspection via a raw query:
      const req = createWakeupRequest({ agentId: "agent-done2" });
      const before = Math.floor(Date.now() / 1000) - 1;
      markWakeupCompleted(req.id);

      // Confirm the record is not pending
      const pending = listPendingWakeupRequests("agent-done2");
      expect(pending.find((r) => r.id === req.id)).toBeUndefined();

      // Inspect processed_at directly from DB
      const row = testDb
        .prepare("SELECT processed_at, status FROM op1_agent_wakeup_requests WHERE id = ?")
        .get(req.id) as { processed_at: number | null; status: string } | undefined;

      expect(row).toBeDefined();
      expect(row!.status).toBe("completed");
      expect(row!.processed_at).not.toBeNull();
      expect(row!.processed_at!).toBeGreaterThan(before);
    });
  });

  // ── listPendingWakeupRequests excludes completed/failed ───────────

  describe("listPendingWakeupRequests exclusions", () => {
    it("excludes completed requests", () => {
      const completed = createWakeupRequest({ agentId: "excl-agent" });
      const stillPending = createWakeupRequest({ agentId: "excl-agent" });
      markWakeupCompleted(completed.id);

      const pending = listPendingWakeupRequests("excl-agent");
      expect(pending.map((r) => r.id)).not.toContain(completed.id);
      expect(pending.map((r) => r.id)).toContain(stillPending.id);
    });

    it("excludes failed requests", () => {
      const failed = createWakeupRequest({ agentId: "fail-agent" });
      const stillPending = createWakeupRequest({ agentId: "fail-agent" });
      markWakeupFailed(failed.id);

      const pending = listPendingWakeupRequests("fail-agent");
      expect(pending.map((r) => r.id)).not.toContain(failed.id);
      expect(pending.map((r) => r.id)).toContain(stillPending.id);
    });

    it("excludes processing requests", () => {
      const processing = createWakeupRequest({ agentId: "proc-agent" });
      createWakeupRequest({ agentId: "proc-agent" });
      markWakeupProcessing(processing.id);

      const pending = listPendingWakeupRequests("proc-agent");
      expect(pending.map((r) => r.id)).not.toContain(processing.id);
    });

    it("returns empty list when all requests are non-pending", () => {
      const r1 = createWakeupRequest({ agentId: "done-all" });
      const r2 = createWakeupRequest({ agentId: "done-all" });
      markWakeupCompleted(r1.id);
      markWakeupFailed(r2.id);

      expect(listPendingWakeupRequests("done-all")).toHaveLength(0);
    });
  });
});
