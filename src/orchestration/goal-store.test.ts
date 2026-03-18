/**
 * Tests for goal-store-sqlite.ts (Phase 3.9)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runMigrations } from "../infra/state-db/schema.js";
import { requireNodeSqlite } from "../memory/sqlite.js";

type TestDb = ReturnType<typeof requireNodeSqlite>["DatabaseSync"]["prototype"];
let testDb: TestDb;

vi.mock("../infra/state-db/index.js", () => ({
  getStateDb: () => testDb,
}));

vi.mock("../infra/state-db/connection.js", () => ({
  getStateDb: () => testDb,
}));

import { listGoals, getGoal, createGoal, updateGoal, deleteGoal } from "./goal-store-sqlite.js";
import { createWorkspace } from "./workspace-store-sqlite.js";

function makeWorkspace() {
  return createWorkspace({ name: "Goal WS", brandColor: "#3b82f6" });
}

describe("goal-store-sqlite", () => {
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

  // ── CRUD ─────────────────────────────────────────────────────────

  describe("CRUD", () => {
    it("createGoal stores title, default level, default status", () => {
      const ws = makeWorkspace();
      const g = createGoal({ workspaceId: ws.id, title: "Grow revenue" });

      expect(g.title).toBe("Grow revenue");
      expect(g.level).toBe("objective");
      expect(g.status).toBe("planned");
      expect(g.progress).toBe(0);
      expect(g.parentId).toBeNull();
    });

    it("getGoal returns null for unknown id", () => {
      expect(getGoal("nonexistent")).toBeNull();
    });

    it("listGoals returns all goals for a workspace", () => {
      const ws = makeWorkspace();
      createGoal({ workspaceId: ws.id, title: "G1" });
      createGoal({ workspaceId: ws.id, title: "G2" });
      expect(listGoals({ workspaceId: ws.id })).toHaveLength(2);
    });

    it("listGoals filters by status", () => {
      const ws = makeWorkspace();
      const g = createGoal({ workspaceId: ws.id, title: "Active goal" });
      updateGoal(g.id, { status: "in_progress" });
      createGoal({ workspaceId: ws.id, title: "Planned goal" });

      const active = listGoals({ workspaceId: ws.id, status: "in_progress" });
      expect(active).toHaveLength(1);
      expect(active[0].title).toBe("Active goal");
    });

    it("deleteGoal removes the goal", () => {
      const ws = makeWorkspace();
      const g = createGoal({ workspaceId: ws.id, title: "To delete" });
      deleteGoal(g.id);
      expect(getGoal(g.id)).toBeNull();
    });

    it("updateGoal throws for unknown goal", () => {
      expect(() => updateGoal("nonexistent", { title: "x" })).toThrow("Goal not found");
    });
  });

  // ── Hierarchy (parent/child) ──────────────────────────────────────

  describe("hierarchy", () => {
    it("can create parent → child chain", () => {
      const ws = makeWorkspace();
      const parent = createGoal({ workspaceId: ws.id, title: "Vision", level: "vision" });
      const child = createGoal({
        workspaceId: ws.id,
        title: "Objective",
        level: "objective",
        parentId: parent.id,
      });

      expect(child.parentId).toBe(parent.id);
    });

    it("listGoals filters root goals (parentId = null)", () => {
      const ws = makeWorkspace();
      const root = createGoal({ workspaceId: ws.id, title: "Root" });
      createGoal({ workspaceId: ws.id, title: "Child", parentId: root.id });

      const roots = listGoals({ workspaceId: ws.id, parentId: null });
      expect(roots).toHaveLength(1);
      expect(roots[0].id).toBe(root.id);
    });

    it("listGoals filters children of a specific parent", () => {
      const ws = makeWorkspace();
      const root = createGoal({ workspaceId: ws.id, title: "Root" });
      createGoal({ workspaceId: ws.id, title: "Child A", parentId: root.id });
      createGoal({ workspaceId: ws.id, title: "Child B", parentId: root.id });
      createGoal({ workspaceId: ws.id, title: "Unrelated root" });

      const children = listGoals({ workspaceId: ws.id, parentId: root.id });
      expect(children).toHaveLength(2);
    });

    it("rejects self-referential parent assignment", () => {
      const ws = makeWorkspace();
      const g = createGoal({ workspaceId: ws.id, title: "Self-ref attempt" });
      expect(() => updateGoal(g.id, { parentId: g.id })).toThrow("cannot be its own parent");
    });
  });

  // ── Status transitions ────────────────────────────────────────────

  describe("status transitions", () => {
    it("allows planned → in_progress", () => {
      const ws = makeWorkspace();
      const g = createGoal({ workspaceId: ws.id, title: "G" });
      const updated = updateGoal(g.id, { status: "in_progress" });
      expect(updated.status).toBe("in_progress");
    });

    it("allows in_progress → achieved", () => {
      const ws = makeWorkspace();
      const g = createGoal({ workspaceId: ws.id, title: "G" });
      updateGoal(g.id, { status: "in_progress" });
      const done = updateGoal(g.id, { status: "achieved" });
      expect(done.status).toBe("achieved");
    });

    it("rejects planned → achieved (must go through in_progress)", () => {
      const ws = makeWorkspace();
      const g = createGoal({ workspaceId: ws.id, title: "G" });
      expect(() => updateGoal(g.id, { status: "achieved" })).toThrow(
        "Invalid goal status transition",
      );
    });
  });

  // ── Progress ─────────────────────────────────────────────────────

  describe("progress", () => {
    it("updateGoal sets progress 0-100", () => {
      const ws = makeWorkspace();
      const g = createGoal({ workspaceId: ws.id, title: "G" });
      const updated = updateGoal(g.id, { progress: 75 });
      expect(updated.progress).toBe(75);
    });

    it("rejects progress > 100", () => {
      const ws = makeWorkspace();
      const g = createGoal({ workspaceId: ws.id, title: "G" });
      expect(() => updateGoal(g.id, { progress: 101 })).toThrow("between 0 and 100");
    });

    it("rejects progress < 0", () => {
      const ws = makeWorkspace();
      const g = createGoal({ workspaceId: ws.id, title: "G" });
      expect(() => updateGoal(g.id, { progress: -1 })).toThrow("between 0 and 100");
    });
  });
});
