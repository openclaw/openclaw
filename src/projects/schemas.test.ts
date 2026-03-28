import { describe, expect, it } from "vitest";
import {
  ProjectFrontmatterSchema,
  QueueFrontmatterSchema,
  TaskFrontmatterSchema,
} from "./schemas.js";

describe("ProjectFrontmatterSchema", () => {
  it("parses valid project with only required fields and applies defaults", () => {
    const result = ProjectFrontmatterSchema.safeParse({ name: "test" });
    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }
    expect(result.data.name).toBe("test");
    expect(result.data.status).toBe("active");
    expect(result.data.tags).toEqual([]);
    expect(result.data.columns).toEqual(["Backlog", "In Progress", "Review", "Done"]);
    expect(result.data.dashboard.widgets).toEqual([
      "project-status",
      "task-counts",
      "active-agents",
      "sub-project-status",
      "recent-activity",
      "blockers",
    ]);
  });

  it("rejects empty object (name is required)", () => {
    const result = ProjectFrontmatterSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it("preserves owner and tags when provided", () => {
    const result = ProjectFrontmatterSchema.safeParse({
      name: "test",
      owner: "alice",
      tags: ["ai", "code"],
    });
    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }
    expect(result.data.owner).toBe("alice");
    expect(result.data.tags).toEqual(["ai", "code"]);
  });

  it("accepts all valid status values", () => {
    for (const status of ["active", "paused", "complete"]) {
      const result = ProjectFrontmatterSchema.safeParse({ name: "test", status });
      expect(result.success).toBe(true);
    }
  });

  it("rejects invalid status", () => {
    const result = ProjectFrontmatterSchema.safeParse({ name: "test", status: "invalid" });
    expect(result.success).toBe(false);
  });

  it("accepts optional description, created, and updated fields", () => {
    const result = ProjectFrontmatterSchema.safeParse({
      name: "test",
      description: "A test project",
      created: "2026-03-26T00:00:00Z",
      updated: "2026-03-26T00:00:00Z",
    });
    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }
    expect(result.data.description).toBe("A test project");
    expect(result.data.created).toBe("2026-03-26T00:00:00Z");
    expect(result.data.updated).toBe("2026-03-26T00:00:00Z");
  });

  it("columns default is exactly Backlog, In Progress, Review, Done", () => {
    const result = ProjectFrontmatterSchema.safeParse({ name: "test" });
    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }
    expect(result.data.columns).toEqual(["Backlog", "In Progress", "Review", "Done"]);
  });
});

describe("TaskFrontmatterSchema", () => {
  it("parses valid task with required fields and applies defaults", () => {
    const result = TaskFrontmatterSchema.safeParse({ id: "TASK-001", title: "Do thing" });
    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }
    expect(result.data.id).toBe("TASK-001");
    expect(result.data.title).toBe("Do thing");
    expect(result.data.status).toBe("backlog");
    expect(result.data.priority).toBe("medium");
    expect(result.data.capabilities).toEqual([]);
    expect(result.data.depends_on).toEqual([]);
    expect(result.data.claimed_by).toBeNull();
  });

  it("preserves depends_on array of valid TASK-NNN ids", () => {
    const result = TaskFrontmatterSchema.safeParse({
      id: "TASK-001",
      title: "Do thing",
      depends_on: ["TASK-002", "TASK-003"],
    });
    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }
    expect(result.data.depends_on).toEqual(["TASK-002", "TASK-003"]);
  });

  it("rejects depends_on with invalid id format", () => {
    const result = TaskFrontmatterSchema.safeParse({
      id: "TASK-001",
      title: "Do thing",
      depends_on: ["invalid-id"],
    });
    expect(result.success).toBe(false);
  });

  it("rejects task with invalid id format", () => {
    const result = TaskFrontmatterSchema.safeParse({ id: "bad", title: "X" });
    expect(result.success).toBe(false);
  });

  it("accepts all valid status values", () => {
    for (const status of ["backlog", "in-progress", "review", "done", "blocked"]) {
      const result = TaskFrontmatterSchema.safeParse({
        id: "TASK-001",
        title: "Test",
        status,
      });
      expect(result.success).toBe(true);
    }
  });

  it("accepts all valid priority values", () => {
    for (const priority of ["low", "medium", "high", "critical"]) {
      const result = TaskFrontmatterSchema.safeParse({
        id: "TASK-001",
        title: "Test",
        priority,
      });
      expect(result.success).toBe(true);
    }
  });

  it("defaults column to Backlog", () => {
    const result = TaskFrontmatterSchema.safeParse({ id: "TASK-001", title: "Test" });
    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }
    expect(result.data.column).toBe("Backlog");
  });

  it("defaults claimed_at and parent to null", () => {
    const result = TaskFrontmatterSchema.safeParse({ id: "TASK-001", title: "Test" });
    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }
    expect(result.data.claimed_at).toBeNull();
    expect(result.data.parent).toBeNull();
  });
});

describe("QueueFrontmatterSchema", () => {
  it("parses empty object (all fields optional)", () => {
    const result = QueueFrontmatterSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it("parses object with updated timestamp", () => {
    const result = QueueFrontmatterSchema.safeParse({ updated: "2026-03-26T14:30:00Z" });
    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }
    expect(result.data.updated).toBe("2026-03-26T14:30:00Z");
  });
});
