/**
 * Tests for execution-workspace-sqlite.ts (Paperclip sync)
 *
 * Covers:
 * - createExecutionWorkspace field storage
 * - listExecutionWorkspaces filters (workspaceId, taskId, agentId, status)
 * - archiveExecutionWorkspace sets status + closedAt
 * - recordWorkspaceOperation + listWorkspaceOperations lifecycle
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runMigrations } from "../infra/state-db/schema.js";
import { requireNodeSqlite } from "../memory/sqlite.js";

type TestDb = ReturnType<typeof requireNodeSqlite>["DatabaseSync"]["prototype"];
let testDb: TestDb;

vi.mock("../infra/state-db/connection.js", () => ({ getStateDb: () => testDb }));
vi.mock("../infra/state-db/index.js", () => ({ getStateDb: () => testDb }));

import {
  archiveExecutionWorkspace,
  createExecutionWorkspace,
  getExecutionWorkspace,
  listExecutionWorkspaces,
  recordWorkspaceOperation,
  listWorkspaceOperations,
} from "./execution-workspace-sqlite.js";
import { createWorkspace } from "./workspace-store-sqlite.js";

describe("execution-workspace-sqlite", () => {
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

  // ── createExecutionWorkspace ───────────────────────────────────────

  describe("createExecutionWorkspace", () => {
    it("stores all required fields with defaults", () => {
      const ew = createExecutionWorkspace({ name: "my-workspace" });

      expect(ew.id).toBeTruthy();
      expect(ew.name).toBe("my-workspace");
      expect(ew.workspaceId).toBe("default");
      expect(ew.mode).toBe("local_fs");
      expect(ew.status).toBe("active");
      expect(ew.projectId).toBeNull();
      expect(ew.taskId).toBeNull();
      expect(ew.agentId).toBeNull();
      expect(ew.workspacePath).toBeNull();
      expect(ew.baseRef).toBeNull();
      expect(ew.branchName).toBeNull();
      expect(ew.metadataJson).toBeNull();
      expect(ew.closedAt).toBeNull();
      expect(typeof ew.openedAt).toBe("number");
    });

    it("stores all optional fields when provided", () => {
      const ws = createWorkspace({ name: "Full WS" });
      const ew = createExecutionWorkspace({
        name: "full-workspace",
        workspaceId: ws.id,
        projectId: "proj-1",
        taskId: "task-1",
        agentId: "agent-1",
        mode: "git_worktree",
        workspacePath: "/tmp/work",
        baseRef: "main",
        branchName: "feature/test",
        metadataJson: '{"key":"value"}',
      });

      expect(ew.workspaceId).toBe(ws.id);
      expect(ew.projectId).toBe("proj-1");
      expect(ew.taskId).toBe("task-1");
      expect(ew.agentId).toBe("agent-1");
      expect(ew.mode).toBe("git_worktree");
      expect(ew.workspacePath).toBe("/tmp/work");
      expect(ew.baseRef).toBe("main");
      expect(ew.branchName).toBe("feature/test");
      expect(ew.metadataJson).toBe('{"key":"value"}');
    });

    it("getExecutionWorkspace returns the stored record", () => {
      const created = createExecutionWorkspace({ name: "fetch-me" });
      const fetched = getExecutionWorkspace(created.id);
      expect(fetched).toBeDefined();
      expect(fetched?.id).toBe(created.id);
      expect(fetched?.name).toBe("fetch-me");
    });

    it("getExecutionWorkspace returns undefined for unknown id", () => {
      expect(getExecutionWorkspace("nonexistent")).toBeUndefined();
    });
  });

  // ── listExecutionWorkspaces filters ───────────────────────────────

  describe("listExecutionWorkspaces filters", () => {
    it("returns all workspaces when no filter", () => {
      createExecutionWorkspace({ name: "a" });
      createExecutionWorkspace({ name: "b" });
      const all = listExecutionWorkspaces();
      expect(all.length).toBeGreaterThanOrEqual(2);
    });

    it("filters by workspaceId", () => {
      const wsAlpha = createWorkspace({ name: "Alpha WS" });
      const wsBeta = createWorkspace({ name: "Beta WS" });
      createExecutionWorkspace({ name: "in-ws", workspaceId: wsAlpha.id });
      createExecutionWorkspace({ name: "other", workspaceId: wsBeta.id });

      const result = listExecutionWorkspaces({ workspaceId: wsAlpha.id });
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe("in-ws");
    });

    it("filters by taskId", () => {
      createExecutionWorkspace({ name: "task-ws", taskId: "task-42" });
      createExecutionWorkspace({ name: "no-task" });

      const result = listExecutionWorkspaces({ taskId: "task-42" });
      expect(result).toHaveLength(1);
      expect(result[0].taskId).toBe("task-42");
    });

    it("filters by agentId", () => {
      createExecutionWorkspace({ name: "agent-ws", agentId: "neo" });
      createExecutionWorkspace({ name: "unassigned" });

      const result = listExecutionWorkspaces({ agentId: "neo" });
      expect(result).toHaveLength(1);
      expect(result[0].agentId).toBe("neo");
    });

    it("filters by status", () => {
      const ew = createExecutionWorkspace({ name: "to-archive" });
      createExecutionWorkspace({ name: "stays-active" });
      archiveExecutionWorkspace(ew.id);

      const active = listExecutionWorkspaces({ status: "active" });
      const archived = listExecutionWorkspaces({ status: "archived" });

      expect(active.every((w) => w.status === "active")).toBe(true);
      expect(archived.length).toBeGreaterThanOrEqual(1);
      expect(archived.every((w) => w.status === "archived")).toBe(true);
    });

    it("combines multiple filters", () => {
      const wsX = createWorkspace({ name: "WS X" });
      const wsY = createWorkspace({ name: "WS Y" });
      createExecutionWorkspace({ name: "match", workspaceId: wsX.id, agentId: "agent-z" });
      createExecutionWorkspace({ name: "partial", workspaceId: wsX.id, agentId: "agent-other" });
      createExecutionWorkspace({ name: "different", workspaceId: wsY.id, agentId: "agent-z" });

      const result = listExecutionWorkspaces({ workspaceId: wsX.id, agentId: "agent-z" });
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe("match");
    });
  });

  // ── archiveExecutionWorkspace ──────────────────────────────────────

  describe("archiveExecutionWorkspace", () => {
    it("sets status to archived", () => {
      const ew = createExecutionWorkspace({ name: "to-archive" });
      const archived = archiveExecutionWorkspace(ew.id);
      expect(archived.status).toBe("archived");
    });

    it("sets closedAt to a positive unix timestamp", () => {
      const before = Math.floor(Date.now() / 1000) - 1;
      const ew = createExecutionWorkspace({ name: "check-closed-at" });
      const archived = archiveExecutionWorkspace(ew.id);

      expect(archived.closedAt).not.toBeNull();
      expect(archived.closedAt!).toBeGreaterThan(before);
    });
  });

  // ── recordWorkspaceOperation + listWorkspaceOperations ────────────

  describe("recordWorkspaceOperation + listWorkspaceOperations", () => {
    it("records an operation and retrieves it", () => {
      const ew = createExecutionWorkspace({ name: "ops-ws" });
      const op = recordWorkspaceOperation({
        executionWorkspaceId: ew.id,
        operationType: "git_clone",
      });

      expect(op.id).toBeTruthy();
      expect(op.executionWorkspaceId).toBe(ew.id);
      expect(op.operationType).toBe("git_clone");
      expect(op.status).toBe("pending");
      expect(op.detailsJson).toBeNull();
    });

    it("stores provided status and detailsJson", () => {
      const ew = createExecutionWorkspace({ name: "ops-ws-2" });
      const op = recordWorkspaceOperation({
        executionWorkspaceId: ew.id,
        operationType: "branch_create",
        status: "running",
        detailsJson: '{"branch":"feat/x"}',
      });

      expect(op.status).toBe("running");
      expect(op.detailsJson).toBe('{"branch":"feat/x"}');
    });

    it("listWorkspaceOperations returns operations in insertion order", () => {
      const ew = createExecutionWorkspace({ name: "multi-ops" });
      recordWorkspaceOperation({ executionWorkspaceId: ew.id, operationType: "first" });
      recordWorkspaceOperation({ executionWorkspaceId: ew.id, operationType: "second" });
      recordWorkspaceOperation({ executionWorkspaceId: ew.id, operationType: "third" });

      const ops = listWorkspaceOperations(ew.id);
      expect(ops).toHaveLength(3);
      expect(ops[0].operationType).toBe("first");
      expect(ops[1].operationType).toBe("second");
      expect(ops[2].operationType).toBe("third");
    });

    it("listWorkspaceOperations only returns ops for the given execution workspace", () => {
      const ew1 = createExecutionWorkspace({ name: "ew1" });
      const ew2 = createExecutionWorkspace({ name: "ew2" });
      recordWorkspaceOperation({ executionWorkspaceId: ew1.id, operationType: "op-a" });
      recordWorkspaceOperation({ executionWorkspaceId: ew2.id, operationType: "op-b" });

      const ops1 = listWorkspaceOperations(ew1.id);
      expect(ops1).toHaveLength(1);
      expect(ops1[0].operationType).toBe("op-a");

      const ops2 = listWorkspaceOperations(ew2.id);
      expect(ops2).toHaveLength(1);
      expect(ops2[0].operationType).toBe("op-b");
    });

    it("returns empty array for execution workspace with no operations", () => {
      const ew = createExecutionWorkspace({ name: "empty-ops" });
      expect(listWorkspaceOperations(ew.id)).toHaveLength(0);
    });
  });
});
