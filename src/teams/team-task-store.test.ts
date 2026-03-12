import { describe, expect, it } from "vitest";
import { createTeamRun } from "./team-store.js";
import {
  createTeamTask,
  listTeamTasks,
  updateTeamTask,
  deleteTeamTask,
  isTaskBlocked,
} from "./team-task-store.js";
import { useTeamStoreTestDb } from "./test-helpers.team-store.js";

describe("team-task-store", () => {
  useTeamStoreTestDb();

  // ── createTeamTask ────────────────────────────────────────────────

  describe("createTeamTask", () => {
    it("creates a task with pending status and empty blockedBy", () => {
      const run = createTeamRun({ name: "team", leader: "l", leaderSession: "s" });
      const task = createTeamTask({
        teamRunId: run.id,
        subject: "Implement JWT middleware",
        description: "Add auth middleware",
      });

      expect(task.teamRunId).toBe(run.id);
      expect(task.subject).toBe("Implement JWT middleware");
      expect(task.description).toBe("Add auth middleware");
      expect(task.status).toBe("pending");
      expect(task.blockedBy).toEqual([]);
      expect(task.owner).toBeUndefined();
      expect(task.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      expect(task.createdAt).toBeGreaterThan(0);
      expect(task.updatedAt).toBe(task.createdAt);
    });

    it("generates unique IDs", () => {
      const run = createTeamRun({ name: "team", leader: "l", leaderSession: "s" });
      const t1 = createTeamTask({ teamRunId: run.id, subject: "a", description: "a" });
      const t2 = createTeamTask({ teamRunId: run.id, subject: "b", description: "b" });
      expect(t1.id).not.toBe(t2.id);
    });

    it("persists the task", () => {
      const run = createTeamRun({ name: "team", leader: "l", leaderSession: "s" });
      const task = createTeamTask({ teamRunId: run.id, subject: "a", description: "a" });
      const tasks = listTeamTasks(run.id);
      expect(tasks).toHaveLength(1);
      expect(tasks[0].id).toBe(task.id);
    });
  });

  // ── listTeamTasks ─────────────────────────────────────────────────

  describe("listTeamTasks", () => {
    it("returns tasks for a specific team", () => {
      const run1 = createTeamRun({ name: "team1", leader: "l", leaderSession: "s" });
      const run2 = createTeamRun({ name: "team2", leader: "l", leaderSession: "s" });
      createTeamTask({ teamRunId: run1.id, subject: "t1", description: "d1" });
      createTeamTask({ teamRunId: run1.id, subject: "t2", description: "d2" });
      createTeamTask({ teamRunId: run2.id, subject: "t3", description: "d3" });

      expect(listTeamTasks(run1.id)).toHaveLength(2);
      expect(listTeamTasks(run2.id)).toHaveLength(1);
    });

    it("returns empty array for a team with no tasks", () => {
      expect(listTeamTasks("no-such-team")).toEqual([]);
    });
  });

  // ── updateTeamTask ────────────────────────────────────────────────

  describe("updateTeamTask", () => {
    it("updates owner", () => {
      const run = createTeamRun({ name: "team", leader: "l", leaderSession: "s" });
      const task = createTeamTask({ teamRunId: run.id, subject: "a", description: "a" });
      const updated = updateTeamTask(run.id, task.id, { owner: "agent-1" });
      expect(updated).not.toBeNull();
      expect(updated!.owner).toBe("agent-1");
    });

    it("updates status", () => {
      const run = createTeamRun({ name: "team", leader: "l", leaderSession: "s" });
      const task = createTeamTask({ teamRunId: run.id, subject: "a", description: "a" });
      const updated = updateTeamTask(run.id, task.id, { status: "in_progress" });
      expect(updated!.status).toBe("in_progress");
    });

    it("updates blockedBy", () => {
      const run = createTeamRun({ name: "team", leader: "l", leaderSession: "s" });
      const t1 = createTeamTask({ teamRunId: run.id, subject: "a", description: "a" });
      const t2 = createTeamTask({ teamRunId: run.id, subject: "b", description: "b" });
      const updated = updateTeamTask(run.id, t2.id, { blockedBy: [t1.id] });
      expect(updated!.blockedBy).toEqual([t1.id]);
    });

    it("updates subject and description", () => {
      const run = createTeamRun({ name: "team", leader: "l", leaderSession: "s" });
      const task = createTeamTask({ teamRunId: run.id, subject: "old", description: "old" });
      const updated = updateTeamTask(run.id, task.id, {
        subject: "new-subject",
        description: "new-desc",
      });
      expect(updated!.subject).toBe("new-subject");
      expect(updated!.description).toBe("new-desc");
    });

    it("updates the updatedAt timestamp", () => {
      const run = createTeamRun({ name: "team", leader: "l", leaderSession: "s" });
      const task = createTeamTask({ teamRunId: run.id, subject: "a", description: "a" });
      const before = task.updatedAt;
      const updated = updateTeamTask(run.id, task.id, { owner: "x" });
      expect(updated!.updatedAt).toBeGreaterThanOrEqual(before);
    });

    it("returns null for nonexistent team run", () => {
      expect(updateTeamTask("no-team", "no-task", { owner: "x" })).toBeNull();
    });

    it("returns null for nonexistent task ID", () => {
      const run = createTeamRun({ name: "team", leader: "l", leaderSession: "s" });
      expect(updateTeamTask(run.id, "no-task", { owner: "x" })).toBeNull();
    });
  });

  // ── deleteTeamTask ────────────────────────────────────────────────

  describe("deleteTeamTask", () => {
    it("removes a task from the team", () => {
      const run = createTeamRun({ name: "team", leader: "l", leaderSession: "s" });
      const task = createTeamTask({ teamRunId: run.id, subject: "a", description: "a" });
      expect(deleteTeamTask(run.id, task.id)).toBe(true);
      expect(listTeamTasks(run.id)).toHaveLength(0);
    });

    it("returns false for nonexistent team run", () => {
      expect(deleteTeamTask("no-team", "no-task")).toBe(false);
    });

    it("returns false for nonexistent task ID", () => {
      const run = createTeamRun({ name: "team", leader: "l", leaderSession: "s" });
      expect(deleteTeamTask(run.id, "no-task")).toBe(false);
    });

    it("does not remove other tasks", () => {
      const run = createTeamRun({ name: "team", leader: "l", leaderSession: "s" });
      const t1 = createTeamTask({ teamRunId: run.id, subject: "a", description: "a" });
      const t2 = createTeamTask({ teamRunId: run.id, subject: "b", description: "b" });
      deleteTeamTask(run.id, t1.id);
      const remaining = listTeamTasks(run.id);
      expect(remaining).toHaveLength(1);
      expect(remaining[0].id).toBe(t2.id);
    });
  });

  // ── isTaskBlocked ─────────────────────────────────────────────────

  describe("isTaskBlocked", () => {
    it("returns true when blockedBy contains incomplete tasks", () => {
      const run = createTeamRun({ name: "team", leader: "l", leaderSession: "s" });
      const t1 = createTeamTask({ teamRunId: run.id, subject: "dep", description: "d" });
      const t2 = createTeamTask({ teamRunId: run.id, subject: "main", description: "d" });
      updateTeamTask(run.id, t2.id, { blockedBy: [t1.id] });

      expect(isTaskBlocked(run.id, t2.id)).toBe(true);
    });

    it("returns false when all blockedBy tasks are completed", () => {
      const run = createTeamRun({ name: "team", leader: "l", leaderSession: "s" });
      const t1 = createTeamTask({ teamRunId: run.id, subject: "dep", description: "d" });
      const t2 = createTeamTask({ teamRunId: run.id, subject: "main", description: "d" });
      updateTeamTask(run.id, t1.id, { status: "completed" });
      updateTeamTask(run.id, t2.id, { blockedBy: [t1.id] });

      expect(isTaskBlocked(run.id, t2.id)).toBe(false);
    });

    it("returns true when a blockedBy ID references a nonexistent task", () => {
      const run = createTeamRun({ name: "team", leader: "l", leaderSession: "s" });
      const t1 = createTeamTask({ teamRunId: run.id, subject: "main", description: "d" });
      updateTeamTask(run.id, t1.id, { blockedBy: ["nonexistent-id"] });

      // Nonexistent dep counts as not completed
      expect(isTaskBlocked(run.id, t1.id)).toBe(true);
    });

    it("returns false for a task with empty blockedBy", () => {
      const run = createTeamRun({ name: "team", leader: "l", leaderSession: "s" });
      const t1 = createTeamTask({ teamRunId: run.id, subject: "free", description: "d" });
      expect(isTaskBlocked(run.id, t1.id)).toBe(false);
    });

    it("returns false for nonexistent team", () => {
      expect(isTaskBlocked("no-team", "no-task")).toBe(false);
    });

    it("returns false for nonexistent task within existing team", () => {
      const run = createTeamRun({ name: "team", leader: "l", leaderSession: "s" });
      createTeamTask({ teamRunId: run.id, subject: "a", description: "d" });
      expect(isTaskBlocked(run.id, "no-task")).toBe(false);
    });

    it("handles mixed blocked/completed dependencies", () => {
      const run = createTeamRun({ name: "team", leader: "l", leaderSession: "s" });
      const dep1 = createTeamTask({ teamRunId: run.id, subject: "d1", description: "d" });
      const dep2 = createTeamTask({ teamRunId: run.id, subject: "d2", description: "d" });
      const main = createTeamTask({ teamRunId: run.id, subject: "main", description: "d" });

      updateTeamTask(run.id, dep1.id, { status: "completed" });
      // dep2 stays pending
      updateTeamTask(run.id, main.id, { blockedBy: [dep1.id, dep2.id] });

      // Still blocked because dep2 is not completed
      expect(isTaskBlocked(run.id, main.id)).toBe(true);

      // Complete dep2
      updateTeamTask(run.id, dep2.id, { status: "completed" });
      expect(isTaskBlocked(run.id, main.id)).toBe(false);
    });
  });
});
