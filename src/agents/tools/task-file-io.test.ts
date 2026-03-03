import { describe, expect, it } from "vitest";
import {
  formatTaskFileMd,
  parseTaskFileMd,
  generateTaskId,
  generateWorkSessionId,
  normalizeWorkSessionId,
  ensureTaskWorkSessionId,
  isValidTaskStatus,
  isValidTaskPriority,
  getMonthlyHistoryFilename,
  formatTaskHistoryEntry,
  type TaskFile,
} from "./task-file-io.js";

function makeTask(overrides: Partial<TaskFile> = {}): TaskFile {
  return {
    id: "task_abc123",
    status: "in_progress",
    priority: "medium",
    description: "Test task description",
    created: "2026-01-15T10:00:00Z",
    lastActivity: "2026-01-15T12:00:00Z",
    progress: ["Started work", "Made progress"],
    ...overrides,
  };
}

describe("task-file-io", () => {
  describe("generateTaskId", () => {
    it("returns a string starting with task_", () => {
      const id = generateTaskId();
      expect(id).toMatch(/^task_[a-f0-9]{20}$/);
    });

    it("generates unique IDs", () => {
      const ids = new Set(Array.from({ length: 50 }, () => generateTaskId()));
      expect(ids.size).toBe(50);
    });
  });

  describe("generateWorkSessionId", () => {
    it("returns a string starting with ws_", () => {
      const id = generateWorkSessionId();
      expect(id).toMatch(/^ws_[a-f0-9-]+$/);
    });

    it("generates unique session IDs", () => {
      const ids = new Set(Array.from({ length: 20 }, () => generateWorkSessionId()));
      expect(ids.size).toBe(20);
    });
  });

  describe("normalizeWorkSessionId", () => {
    it("returns undefined for undefined input", () => {
      expect(normalizeWorkSessionId(undefined)).toBeUndefined();
    });

    it("returns undefined for empty string", () => {
      expect(normalizeWorkSessionId("")).toBeUndefined();
    });

    it("returns undefined for whitespace-only string", () => {
      expect(normalizeWorkSessionId("   ")).toBeUndefined();
    });

    it("trims whitespace from valid values", () => {
      expect(normalizeWorkSessionId("  ws_abc  ")).toBe("ws_abc");
    });

    it("returns value as-is when already clean", () => {
      expect(normalizeWorkSessionId("ws_abc")).toBe("ws_abc");
    });
  });

  describe("ensureTaskWorkSessionId", () => {
    it("returns existing workSessionId if present", () => {
      const task = makeTask({ workSessionId: "ws_existing" });
      const result = ensureTaskWorkSessionId(task);
      expect(result).toBe("ws_existing");
      expect(task.workSessionId).toBe("ws_existing");
    });

    it("generates and assigns new workSessionId when missing", () => {
      const task = makeTask({ workSessionId: undefined });
      const result = ensureTaskWorkSessionId(task);
      expect(result).toMatch(/^ws_/);
      expect(task.workSessionId).toBe(result);
    });

    it("generates new workSessionId when existing is empty string", () => {
      const task = makeTask({ workSessionId: "" });
      const result = ensureTaskWorkSessionId(task);
      expect(result).toMatch(/^ws_/);
    });
  });

  describe("isValidTaskStatus", () => {
    it.each([
      "pending",
      "pending_approval",
      "in_progress",
      "blocked",
      "backlog",
      "completed",
      "cancelled",
      "abandoned",
      "interrupted",
    ])("returns true for valid status: %s", (status) => {
      expect(isValidTaskStatus(status)).toBe(true);
    });

    it.each(["invalid", "PENDING", "active", "done", ""])(
      "returns false for invalid status: %s",
      (status) => {
        expect(isValidTaskStatus(status)).toBe(false);
      },
    );
  });

  describe("isValidTaskPriority", () => {
    it.each(["low", "medium", "high", "urgent"])(
      "returns true for valid priority: %s",
      (priority) => {
        expect(isValidTaskPriority(priority)).toBe(true);
      },
    );

    it.each(["critical", "MEDIUM", "none", ""])(
      "returns false for invalid priority: %s",
      (priority) => {
        expect(isValidTaskPriority(priority)).toBe(false);
      },
    );
  });

  describe("getMonthlyHistoryFilename", () => {
    it("returns YYYY-MM.md format", () => {
      const filename = getMonthlyHistoryFilename();
      expect(filename).toMatch(/^\d{4}-\d{2}\.md$/);
    });
  });

  describe("formatTaskFileMd / parseTaskFileMd roundtrip", () => {
    it("roundtrips a basic task", () => {
      const task = makeTask();
      const md = formatTaskFileMd(task);
      const parsed = parseTaskFileMd(md, "task_abc123.md");
      expect(parsed).not.toBeNull();
      expect(parsed!.id).toBe("task_abc123");
      expect(parsed!.status).toBe("in_progress");
      expect(parsed!.priority).toBe("medium");
      expect(parsed!.description).toBe("Test task description");
      expect(parsed!.created).toBe("2026-01-15T10:00:00Z");
      expect(parsed!.lastActivity).toBe("2026-01-15T12:00:00Z");
      expect(parsed!.progress).toEqual(["Started work", "Made progress"]);
    });

    it("roundtrips a task with steps", () => {
      const task = makeTask({
        steps: [
          { id: "s1", content: "Write tests", status: "done", order: 1 },
          { id: "s2", content: "Implement feature", status: "in_progress", order: 2 },
          { id: "s3", content: "Deploy", status: "pending", order: 3 },
          { id: "s4", content: "Skipped item", status: "skipped", order: 4 },
        ],
      });
      const md = formatTaskFileMd(task);
      const parsed = parseTaskFileMd(md, "task_abc123.md");
      expect(parsed!.steps).toHaveLength(4);
      expect(parsed!.steps![0]).toEqual({
        id: "s1",
        content: "Write tests",
        status: "done",
        order: 1,
      });
      expect(parsed!.steps![1]).toEqual({
        id: "s2",
        content: "Implement feature",
        status: "in_progress",
        order: 2,
      });
      expect(parsed!.steps![2]).toEqual({
        id: "s3",
        content: "Deploy",
        status: "pending",
        order: 3,
      });
      expect(parsed!.steps![3]).toEqual({
        id: "s4",
        content: "Skipped item",
        status: "skipped",
        order: 4,
      });
    });

    it("roundtrips a task with context and source", () => {
      const task = makeTask({
        context: "Some context about the task",
        source: "user-request",
      });
      const md = formatTaskFileMd(task);
      const parsed = parseTaskFileMd(md, "task_abc123.md");
      expect(parsed!.context).toBe("Some context about the task");
      expect(parsed!.source).toBe("user-request");
    });

    it("roundtrips a task with work session IDs", () => {
      const task = makeTask({
        workSessionId: "ws_session1",
        previousWorkSessionId: "ws_session0",
      });
      const md = formatTaskFileMd(task);
      const parsed = parseTaskFileMd(md, "task_abc123.md");
      expect(parsed!.workSessionId).toBe("ws_session1");
      expect(parsed!.previousWorkSessionId).toBe("ws_session0");
    });

    it("roundtrips a blocked task with blocking data", () => {
      const task = makeTask({
        status: "blocked",
        blockedReason: "Waiting for approval",
        unblockedBy: ["admin", "owner"],
        unblockedAction: "approve",
        unblockRequestCount: 2,
        lastUnblockerIndex: 1,
        lastUnblockRequestAt: "2026-01-15T14:00:00Z",
        escalationState: "requesting",
        unblockRequestFailures: 0,
      });
      const md = formatTaskFileMd(task);
      const parsed = parseTaskFileMd(md, "task_abc123.md");
      expect(parsed!.status).toBe("blocked");
      expect(parsed!.blockedReason).toBe("Waiting for approval");
      expect(parsed!.unblockedBy).toEqual(["admin", "owner"]);
      expect(parsed!.unblockedAction).toBe("approve");
      expect(parsed!.unblockRequestCount).toBe(2);
      expect(parsed!.lastUnblockerIndex).toBe(1);
      expect(parsed!.escalationState).toBe("requesting");
      expect(parsed!.unblockRequestFailures).toBe(0);
    });

    it("roundtrips a backlog task with backlog data", () => {
      const task = makeTask({
        status: "backlog",
        createdBy: "user1",
        assignee: "agent1",
        dependsOn: ["task_dep1", "task_dep2"],
        estimatedEffort: "medium",
        startDate: "2026-02-01",
        dueDate: "2026-02-15",
        milestoneId: "ms_1",
        milestoneItemId: "mi_1",
        reassignCount: 1,
      });
      const md = formatTaskFileMd(task);
      const parsed = parseTaskFileMd(md, "task_abc123.md");
      expect(parsed!.createdBy).toBe("user1");
      expect(parsed!.assignee).toBe("agent1");
      expect(parsed!.dependsOn).toEqual(["task_dep1", "task_dep2"]);
      expect(parsed!.estimatedEffort).toBe("medium");
      expect(parsed!.startDate).toBe("2026-02-01");
      expect(parsed!.dueDate).toBe("2026-02-15");
      expect(parsed!.milestoneId).toBe("ms_1");
      expect(parsed!.milestoneItemId).toBe("mi_1");
      expect(parsed!.reassignCount).toBe(1);
    });

    it("roundtrips a backlog task with harness fields", () => {
      const task = makeTask({
        status: "backlog",
        createdBy: "task-hub",
        assignee: "eden",
        harnessProjectSlug: "my-project",
        harnessItemId: "507f1f77bcf86cd799439011",
      });
      const md = formatTaskFileMd(task);
      const parsed = parseTaskFileMd(md, "task_abc123.md");
      expect(parsed!.harnessProjectSlug).toBe("my-project");
      expect(parsed!.harnessItemId).toBe("507f1f77bcf86cd799439011");
    });

    it("roundtrips a backlog task with both milestone and harness fields", () => {
      const task = makeTask({
        status: "backlog",
        createdBy: "task-hub",
        assignee: "eden",
        milestoneId: "ms_1",
        milestoneItemId: "mi_1",
        harnessProjectSlug: "harness-test",
        harnessItemId: "item_abc",
      });
      const md = formatTaskFileMd(task);
      const parsed = parseTaskFileMd(md, "task_abc123.md");
      expect(parsed!.milestoneId).toBe("ms_1");
      expect(parsed!.milestoneItemId).toBe("mi_1");
      expect(parsed!.harnessProjectSlug).toBe("harness-test");
      expect(parsed!.harnessItemId).toBe("item_abc");
    });

    it("omits harness fields when not set", () => {
      const task = makeTask({
        status: "backlog",
        createdBy: "user1",
        assignee: "agent1",
      });
      const md = formatTaskFileMd(task);
      const parsed = parseTaskFileMd(md, "task_abc123.md");
      expect(parsed!.harnessProjectSlug).toBeUndefined();
      expect(parsed!.harnessItemId).toBeUndefined();
    });

    it("roundtrips a task with outcome", () => {
      const task = makeTask({
        status: "completed",
        outcome: { kind: "completed", summary: "All done" },
      });
      const md = formatTaskFileMd(task);
      const parsed = parseTaskFileMd(md, "task_abc123.md");
      expect(parsed!.outcome).toEqual({ kind: "completed", summary: "All done" });
    });

    it("roundtrips a cancelled task outcome", () => {
      const task = makeTask({
        status: "cancelled",
        outcome: { kind: "cancelled", reason: "No longer needed", by: "user1" },
      });
      const md = formatTaskFileMd(task);
      const parsed = parseTaskFileMd(md, "task_abc123.md");
      expect(parsed!.outcome).toEqual({
        kind: "cancelled",
        reason: "No longer needed",
        by: "user1",
      });
    });
  });

  describe("parseTaskFileMd edge cases", () => {
    it("returns null for empty content", () => {
      expect(parseTaskFileMd("", "task_abc.md")).toBeNull();
    });

    it("returns null for content with no-task marker", () => {
      expect(parseTaskFileMd("*(No task)*", "task_abc.md")).toBeNull();
    });

    it("returns null when description is missing", () => {
      const md = [
        "# Task: task_abc",
        "",
        "## Metadata",
        "- **Status:** in_progress",
        "- **Priority:** medium",
        "- **Created:** 2026-01-01T00:00:00Z",
        "",
        "## Progress",
        "",
        "## Last Activity",
        "2026-01-01T00:00:00Z",
      ].join("\n");
      expect(parseTaskFileMd(md, "task_abc.md")).toBeNull();
    });

    it("returns null for invalid status", () => {
      const md = [
        "# Task: task_abc",
        "",
        "## Metadata",
        "- **Status:** invalid_status",
        "- **Priority:** medium",
        "- **Created:** 2026-01-01T00:00:00Z",
        "",
        "## Description",
        "Some description",
        "",
        "## Progress",
        "",
        "## Last Activity",
        "2026-01-01T00:00:00Z",
      ].join("\n");
      expect(parseTaskFileMd(md, "task_abc.md")).toBeNull();
    });

    it("extracts task ID from filename", () => {
      const task = makeTask();
      const md = formatTaskFileMd(task);
      const parsed = parseTaskFileMd(md, "task_abc123.md");
      expect(parsed!.id).toBe("task_abc123");
    });

    it("uses empty string for ID when filename doesn't match pattern", () => {
      const task = makeTask();
      const md = formatTaskFileMd(task);
      const parsed = parseTaskFileMd(md, "notes.md");
      expect(parsed!.id).toBe("");
    });

    it("handles malformed blocking JSON gracefully", () => {
      const md = [
        "# Task: task_abc",
        "",
        "## Metadata",
        "- **Status:** blocked",
        "- **Priority:** medium",
        "- **Created:** 2026-01-01T00:00:00Z",
        "",
        "## Description",
        "Some description",
        "",
        "## Progress",
        "",
        "## Last Activity",
        "2026-01-01T00:00:00Z",
        "",
        "## Blocking",
        "```json",
        "not valid json",
        "```",
      ].join("\n");
      const parsed = parseTaskFileMd(md, "task_abc.md");
      // Should still parse the task, just ignore bad JSON
      expect(parsed).not.toBeNull();
      expect(parsed!.blockedReason).toBeUndefined();
    });

    it("uses created date as lastActivity fallback", () => {
      const md = [
        "# Task: task_abc",
        "",
        "## Metadata",
        "- **Status:** pending",
        "- **Priority:** low",
        "- **Created:** 2026-01-01T00:00:00Z",
        "",
        "## Description",
        "Some description",
        "",
        "## Progress",
      ].join("\n");
      const parsed = parseTaskFileMd(md, "task_abc.md");
      expect(parsed!.lastActivity).toBe("2026-01-01T00:00:00Z");
    });
  });

  describe("formatTaskFileMd", () => {
    it("sorts steps by order", () => {
      const task = makeTask({
        steps: [
          { id: "s3", content: "Third", status: "pending", order: 3 },
          { id: "s1", content: "First", status: "done", order: 1 },
          { id: "s2", content: "Second", status: "in_progress", order: 2 },
        ],
      });
      const md = formatTaskFileMd(task);
      const stepLines = md.split("\n").filter((l) => l.startsWith("- ["));
      expect(stepLines[0]).toContain("(s1) First");
      expect(stepLines[1]).toContain("(s2) Second");
      expect(stepLines[2]).toContain("(s3) Third");
    });

    it("uses correct markers for step statuses", () => {
      const task = makeTask({
        steps: [
          { id: "s1", content: "Done step", status: "done", order: 1 },
          { id: "s2", content: "In progress step", status: "in_progress", order: 2 },
          { id: "s3", content: "Pending step", status: "pending", order: 3 },
          { id: "s4", content: "Skipped step", status: "skipped", order: 4 },
        ],
      });
      const md = formatTaskFileMd(task);
      expect(md).toContain("- [x] (s1) Done step");
      expect(md).toContain("- [>] (s2) In progress step");
      expect(md).toContain("- [ ] (s3) Pending step");
      expect(md).toContain("- [-] (s4) Skipped step");
    });

    it("omits optional sections when not present", () => {
      const task = makeTask({
        context: undefined,
        source: undefined,
        workSessionId: undefined,
        steps: undefined,
      });
      const md = formatTaskFileMd(task);
      expect(md).not.toContain("## Context");
      expect(md).not.toContain("## Steps");
      expect(md).not.toContain("**Source:**");
      expect(md).not.toContain("**Work Session:**");
    });

    it("includes managed-by footer", () => {
      const task = makeTask();
      const md = formatTaskFileMd(task);
      expect(md).toContain("*Managed by task tools*");
    });
  });

  describe("formatTaskHistoryEntry", () => {
    it("includes task description and metadata", () => {
      const task = makeTask({ description: "Implement auth feature" });
      const entry = formatTaskHistoryEntry(task);
      expect(entry).toContain("Implement auth feature");
      expect(entry).toContain(`**Task ID:** ${task.id}`);
      expect(entry).toContain(`**Priority:** ${task.priority}`);
      expect(entry).toContain(`**Started:** ${task.created}`);
    });

    it("includes summary when provided", () => {
      const task = makeTask();
      const entry = formatTaskHistoryEntry(task, "Everything went great");
      expect(entry).toContain("### Summary");
      expect(entry).toContain("Everything went great");
    });

    it("omits summary section when not provided", () => {
      const task = makeTask();
      const entry = formatTaskHistoryEntry(task);
      expect(entry).not.toContain("### Summary");
    });

    it("includes context when present", () => {
      const task = makeTask({ context: "Related to auth module" });
      const entry = formatTaskHistoryEntry(task);
      expect(entry).toContain("**Context:** Related to auth module");
    });

    it("includes progress items", () => {
      const task = makeTask({ progress: ["Step 1 done", "Step 2 done"] });
      const entry = formatTaskHistoryEntry(task);
      expect(entry).toContain("- Step 1 done");
      expect(entry).toContain("- Step 2 done");
    });

    it("includes duration", () => {
      const task = makeTask();
      const entry = formatTaskHistoryEntry(task);
      expect(entry).toContain("**Duration:**");
    });
  });
});
