/**
 * Tests for task-store-sqlite.ts (Phase 2.10)
 *
 * Uses an in-memory SQLite DB with full migrations applied.
 * getStateDb is mocked so the stores use the in-memory DB without
 * touching the real operator1.db file.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runMigrations } from "../infra/state-db/schema.js";
import { requireNodeSqlite } from "../memory/sqlite.js";

// ── DB mock (must be declared before store imports) ───────────────────

type TestDb = ReturnType<typeof requireNodeSqlite>["DatabaseSync"]["prototype"];
let testDb: TestDb;

vi.mock("../infra/state-db/index.js", () => ({
  getStateDb: () => testDb,
}));

// ── Store imports (hoisted after mock) ────────────────────────────────

import {
  listTasks,
  getTask,
  createTask,
  updateTask,
  listTaskComments,
  addTaskComment,
} from "./task-store-sqlite.js";
import { createWorkspace } from "./workspace-store-sqlite.js";

// workspace-store uses connection.js path
vi.mock("../infra/state-db/connection.js", () => ({
  getStateDb: () => testDb,
}));

// ── Fixtures ──────────────────────────────────────────────────────────

function makeWorkspace(name: string) {
  return createWorkspace({ name, brandColor: "#3b82f6", taskPrefix: "OP" });
}

// ── Suite ─────────────────────────────────────────────────────────────

describe("task-store-sqlite", () => {
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

  // ── Identifier generation ─────────────────────────────────────────

  describe("identifier generation", () => {
    it("generates sequential identifiers starting at 001", () => {
      const ws = makeWorkspace("Test WS");
      const t1 = createTask({ workspaceId: ws.id, title: "First" });
      const t2 = createTask({ workspaceId: ws.id, title: "Second" });
      const t3 = createTask({ workspaceId: ws.id, title: "Third" });

      expect(t1.identifier).toMatch(/^OP-001$/);
      expect(t2.identifier).toMatch(/^OP-002$/);
      expect(t3.identifier).toMatch(/^OP-003$/);
    });

    it("uses workspace task_prefix in identifier", () => {
      const ws = createWorkspace({ name: "Eng", brandColor: "#000", taskPrefix: "ENG" });
      const t = createTask({ workspaceId: ws.id, title: "Fix bug" });
      expect(t.identifier).toMatch(/^ENG-\d{3}$/);
    });

    it("identifiers are independent per workspace", () => {
      const ws1 = createWorkspace({ name: "WS1", brandColor: "#000", taskPrefix: "AA" });
      const ws2 = createWorkspace({ name: "WS2", brandColor: "#111", taskPrefix: "BB" });
      createTask({ workspaceId: ws1.id, title: "t1" });
      createTask({ workspaceId: ws1.id, title: "t2" });
      const t = createTask({ workspaceId: ws2.id, title: "first in ws2" });
      expect(t.identifier).toBe("BB-001");
    });
  });

  // ── CRUD ─────────────────────────────────────────────────────────

  describe("CRUD", () => {
    it("createTask stores title, default priority, default status", () => {
      const ws = makeWorkspace("CRUD WS");
      const t = createTask({ workspaceId: ws.id, title: "My task" });

      expect(t.title).toBe("My task");
      expect(t.status).toBe("backlog");
      expect(t.priority).toBe("medium");
      expect(t.assigneeAgentId).toBeNull();
      expect(t.description).toBeNull();
    });

    it("getTask returns null for unknown id", () => {
      expect(getTask("nonexistent")).toBeNull();
    });

    it("listTasks returns all tasks for a workspace", () => {
      const ws = makeWorkspace("List WS");
      createTask({ workspaceId: ws.id, title: "A" });
      createTask({ workspaceId: ws.id, title: "B" });

      const tasks = listTasks({ workspaceId: ws.id });
      expect(tasks).toHaveLength(2);
    });

    it("listTasks filters by status", () => {
      const ws = makeWorkspace("Filter WS");
      const t = createTask({ workspaceId: ws.id, title: "Todo task" });
      updateTask(t.id, { status: "todo" });
      createTask({ workspaceId: ws.id, title: "Backlog task" });

      const todos = listTasks({ workspaceId: ws.id, status: "todo" });
      expect(todos).toHaveLength(1);
      expect(todos[0].title).toBe("Todo task");
    });

    it("updateTask changes title and description", () => {
      const ws = makeWorkspace("Update WS");
      const t = createTask({ workspaceId: ws.id, title: "Original" });
      const updated = updateTask(t.id, { title: "Renamed", description: "Details" });

      expect(updated.title).toBe("Renamed");
      expect(updated.description).toBe("Details");
    });

    it("updateTask throws for unknown task", () => {
      expect(() => updateTask("nonexistent", { title: "x" })).toThrow("Task not found");
    });
  });

  // ── Status transitions ────────────────────────────────────────────

  describe("status transitions", () => {
    it("allows valid transition backlog → todo", () => {
      const ws = makeWorkspace("Trans WS");
      const t = createTask({ workspaceId: ws.id, title: "T" });
      const updated = updateTask(t.id, { status: "todo" });
      expect(updated.status).toBe("todo");
    });

    it("allows valid transition todo → in_progress", () => {
      const ws = makeWorkspace("Trans WS2");
      const t = createTask({ workspaceId: ws.id, title: "T" });
      updateTask(t.id, { status: "todo" });
      const updated = updateTask(t.id, { status: "in_progress" });
      expect(updated.status).toBe("in_progress");
    });

    it("allows valid transition in_progress → done (sets completedAt)", () => {
      const ws = makeWorkspace("Done WS");
      const t = createTask({ workspaceId: ws.id, title: "T" });
      updateTask(t.id, { status: "todo" });
      updateTask(t.id, { status: "in_progress" });
      const done = updateTask(t.id, { status: "done" });
      expect(done.status).toBe("done");
      expect(done.completedAt).toBeGreaterThan(0);
    });

    it("rejects invalid transition backlog → done", () => {
      const ws = makeWorkspace("Invalid Trans WS");
      const t = createTask({ workspaceId: ws.id, title: "T" });
      expect(() => updateTask(t.id, { status: "done" })).toThrow("Invalid status transition");
    });

    it("rejects invalid transition in_review → blocked", () => {
      const ws = makeWorkspace("Invalid Trans WS2");
      const t = createTask({ workspaceId: ws.id, title: "T" });
      updateTask(t.id, { status: "todo" });
      updateTask(t.id, { status: "in_progress" });
      updateTask(t.id, { status: "in_review" });
      expect(() => updateTask(t.id, { status: "blocked" })).toThrow("Invalid status transition");
    });

    it("allows reopening a done task to in_progress", () => {
      const ws = makeWorkspace("Reopen WS");
      const t = createTask({ workspaceId: ws.id, title: "T" });
      updateTask(t.id, { status: "todo" });
      updateTask(t.id, { status: "in_progress" });
      updateTask(t.id, { status: "done" });
      const reopened = updateTask(t.id, { status: "in_progress" });
      expect(reopened.status).toBe("in_progress");
      expect(reopened.completedAt).toBeNull();
    });
  });

  // ── Comments ─────────────────────────────────────────────────────

  describe("comments", () => {
    it("addTaskComment persists a comment", () => {
      const ws = makeWorkspace("Comment WS");
      const t = createTask({ workspaceId: ws.id, title: "T" });
      const comment = addTaskComment({
        taskId: t.id,
        authorId: "user-1",
        authorType: "user",
        body: "Hello world",
      });

      expect(comment.body).toBe("Hello world");
      expect(comment.authorType).toBe("user");
      expect(comment.createdAt).toBeGreaterThan(0);
    });

    it("listTaskComments returns comments in chronological order", () => {
      const ws = makeWorkspace("Comment Order WS");
      const t = createTask({ workspaceId: ws.id, title: "T" });
      addTaskComment({ taskId: t.id, authorId: "u", authorType: "user", body: "First" });
      addTaskComment({ taskId: t.id, authorId: "bot", authorType: "agent", body: "Second" });

      const comments = listTaskComments(t.id);
      expect(comments).toHaveLength(2);
      expect(comments[0].body).toBe("First");
      expect(comments[1].body).toBe("Second");
    });

    it("addTaskComment throws for unknown task", () => {
      expect(() =>
        addTaskComment({ taskId: "nonexistent", authorId: "u", authorType: "user", body: "?" }),
      ).toThrow("Task not found");
    });

    it("listTaskComments returns empty array for task with no comments", () => {
      const ws = makeWorkspace("Empty Comment WS");
      const t = createTask({ workspaceId: ws.id, title: "T" });
      expect(listTaskComments(t.id)).toHaveLength(0);
    });
  });
});
