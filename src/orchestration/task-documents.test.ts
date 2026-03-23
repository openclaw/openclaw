/**
 * Tests for task-documents-sqlite.ts (Paperclip sync)
 *
 * Covers:
 * - createTaskDocument + getTaskDocument round-trip
 * - listTaskDocuments returns docs for correct taskId
 * - updateTaskDocument updates body and updatedAt
 * - deleteTaskDocument removes the doc
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runMigrations } from "../infra/state-db/schema.js";
import { requireNodeSqlite } from "../memory/sqlite.js";

type TestDb = ReturnType<typeof requireNodeSqlite>["DatabaseSync"]["prototype"];
let testDb: TestDb;

vi.mock("../infra/state-db/connection.js", () => ({ getStateDb: () => testDb }));
vi.mock("../infra/state-db/index.js", () => ({ getStateDb: () => testDb }));

import {
  createTaskDocument,
  deleteTaskDocument,
  getTaskDocument,
  listTaskDocuments,
  updateTaskDocument,
} from "./task-documents-sqlite.js";
import { createTask } from "./task-store-sqlite.js";
import { createWorkspace } from "./workspace-store-sqlite.js";

describe("task-documents-sqlite", () => {
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

  // ── createTaskDocument + getTaskDocument ──────────────────────────

  describe("createTaskDocument + getTaskDocument round-trip", () => {
    it("stores and retrieves a document with defaults", () => {
      const ws = createWorkspace({ name: "Doc WS 1" });
      const task = createTask({ workspaceId: ws.id, title: "Task 1" });
      const doc = createTaskDocument({ taskId: task.id });

      expect(doc.id).toBeTruthy();
      expect(doc.taskId).toBe(task.id);
      expect(doc.title).toBeNull();
      expect(doc.format).toBe("markdown");
      expect(doc.body).toBe("");
      expect(doc.createdBy).toBeNull();
      expect(doc.updatedBy).toBeNull();
      expect(typeof doc.createdAt).toBe("number");
      expect(typeof doc.updatedAt).toBe("number");
    });

    it("stores all optional fields when provided", () => {
      const ws = createWorkspace({ name: "Doc WS 2" });
      const task = createTask({ workspaceId: ws.id, title: "Task 2" });
      const doc = createTaskDocument({
        taskId: task.id,
        title: "Design Doc",
        body: "## Overview\nDetails here",
        format: "markdown",
        createdBy: "agent-neo",
      });

      expect(doc.title).toBe("Design Doc");
      expect(doc.body).toBe("## Overview\nDetails here");
      expect(doc.format).toBe("markdown");
      expect(doc.createdBy).toBe("agent-neo");
      // createdBy propagates to updatedBy on creation
      expect(doc.updatedBy).toBe("agent-neo");
    });

    it("getTaskDocument returns null for unknown id", () => {
      expect(getTaskDocument("nonexistent-id")).toBeNull();
    });

    it("getTaskDocument returns the correct document by id", () => {
      const ws = createWorkspace({ name: "Doc WS 3" });
      const task = createTask({ workspaceId: ws.id, title: "Task 3" });
      const doc = createTaskDocument({ taskId: task.id, title: "Fetch me" });
      const fetched = getTaskDocument(doc.id);
      expect(fetched).not.toBeNull();
      expect(fetched!.id).toBe(doc.id);
      expect(fetched!.title).toBe("Fetch me");
    });
  });

  // ── listTaskDocuments ─────────────────────────────────────────────

  describe("listTaskDocuments", () => {
    it("returns only documents for the specified taskId", () => {
      const ws = createWorkspace({ name: "List WS" });
      const taskA = createTask({ workspaceId: ws.id, title: "Task A" });
      const taskB = createTask({ workspaceId: ws.id, title: "Task B" });
      createTaskDocument({ taskId: taskA.id, title: "Doc A1" });
      createTaskDocument({ taskId: taskA.id, title: "Doc A2" });
      createTaskDocument({ taskId: taskB.id, title: "Doc B1" });

      const docsA = listTaskDocuments(taskA.id);
      expect(docsA).toHaveLength(2);
      expect(docsA.every((d) => d.taskId === taskA.id)).toBe(true);

      const docsB = listTaskDocuments(taskB.id);
      expect(docsB).toHaveLength(1);
      expect(docsB[0].title).toBe("Doc B1");
    });

    it("returns empty array for taskId with no documents", () => {
      expect(listTaskDocuments("no-docs-here")).toHaveLength(0);
    });

    it("returns documents ordered by createdAt ascending", () => {
      const ws = createWorkspace({ name: "Order WS" });
      const task = createTask({ workspaceId: ws.id, title: "Order Task" });
      createTaskDocument({ taskId: task.id, title: "First" });
      createTaskDocument({ taskId: task.id, title: "Second" });
      createTaskDocument({ taskId: task.id, title: "Third" });

      const docs = listTaskDocuments(task.id);
      expect(docs).toHaveLength(3);
      expect(docs[0].title).toBe("First");
      expect(docs[2].title).toBe("Third");
    });
  });

  // ── updateTaskDocument ────────────────────────────────────────────

  describe("updateTaskDocument", () => {
    it("updates body", () => {
      const ws = createWorkspace({ name: "Update WS 1" });
      const task = createTask({ workspaceId: ws.id, title: "Update Task 1" });
      const doc = createTaskDocument({ taskId: task.id, body: "original" });
      const updated = updateTaskDocument(doc.id, { body: "updated content" });
      expect(updated.body).toBe("updated content");
    });

    it("updates title", () => {
      const ws = createWorkspace({ name: "Update WS 2" });
      const task = createTask({ workspaceId: ws.id, title: "Update Task 2" });
      const doc = createTaskDocument({ taskId: task.id, title: "Old Title" });
      const updated = updateTaskDocument(doc.id, { title: "New Title" });
      expect(updated.title).toBe("New Title");
    });

    it("updates updatedBy", () => {
      const ws = createWorkspace({ name: "Update WS 3" });
      const task = createTask({ workspaceId: ws.id, title: "Update Task 3" });
      const doc = createTaskDocument({ taskId: task.id });
      const updated = updateTaskDocument(doc.id, { updatedBy: "agent-morpheus" });
      expect(updated.updatedBy).toBe("agent-morpheus");
    });

    it("updatedAt is >= createdAt after update", () => {
      const ws = createWorkspace({ name: "Time WS" });
      const task = createTask({ workspaceId: ws.id, title: "Time Task" });
      const doc = createTaskDocument({ taskId: task.id });
      const updated = updateTaskDocument(doc.id, { body: "changed" });
      expect(updated.updatedAt).toBeGreaterThanOrEqual(doc.createdAt);
    });

    it("partial update preserves unchanged fields", () => {
      const ws = createWorkspace({ name: "Partial WS" });
      const task = createTask({ workspaceId: ws.id, title: "Partial Task" });
      const doc = createTaskDocument({
        taskId: task.id,
        title: "Keep This",
        body: "Keep this too",
        createdBy: "agent-x",
      });
      const updated = updateTaskDocument(doc.id, { body: "New body" });
      expect(updated.title).toBe("Keep This");
      expect(updated.taskId).toBe(task.id);
    });

    it("throws when document does not exist", () => {
      expect(() => updateTaskDocument("ghost-id", { body: "x" })).toThrow(
        "Task document not found",
      );
    });
  });

  // ── deleteTaskDocument ────────────────────────────────────────────

  describe("deleteTaskDocument", () => {
    it("removes the document so getTaskDocument returns null", () => {
      const ws = createWorkspace({ name: "Delete WS 1" });
      const task = createTask({ workspaceId: ws.id, title: "Delete Task 1" });
      const doc = createTaskDocument({ taskId: task.id });
      deleteTaskDocument(doc.id);
      expect(getTaskDocument(doc.id)).toBeNull();
    });

    it("does not affect other documents for the same taskId", () => {
      const ws = createWorkspace({ name: "Delete WS 2" });
      const task = createTask({ workspaceId: ws.id, title: "Delete Task 2" });
      const doc1 = createTaskDocument({ taskId: task.id, title: "Keep" });
      const doc2 = createTaskDocument({ taskId: task.id, title: "Delete" });
      deleteTaskDocument(doc2.id);

      const remaining = listTaskDocuments(task.id);
      expect(remaining).toHaveLength(1);
      expect(remaining[0].id).toBe(doc1.id);
    });

    it("is a no-op for a non-existent id (does not throw)", () => {
      expect(() => deleteTaskDocument("nonexistent")).not.toThrow();
    });
  });
});
