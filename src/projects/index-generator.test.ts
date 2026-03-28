import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  generateAllIndexes,
  generateBoardIndex,
  generateProjectIndex,
  generateQueueIndex,
  generateTaskIndex,
  writeIndexFile,
} from "./index-generator.js";
import type { ParsedQueue } from "./queue-parser.js";
import type { ProjectFrontmatter, TaskFrontmatter } from "./types.js";

describe("index-generator", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "index-gen-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe("generateProjectIndex", () => {
    it("returns ProjectIndex with all fields and indexedAt timestamp", () => {
      const fm: ProjectFrontmatter = {
        name: "test-project",
        status: "active",
        tags: ["dev"],
        columns: ["Backlog", "Done"],
        dashboard: { widgets: ["project-status"] },
      };
      const result = generateProjectIndex(fm);
      expect(result.name).toBe("test-project");
      expect(result.status).toBe("active");
      expect(result.tags).toEqual(["dev"]);
      expect(result.columns).toEqual(["Backlog", "Done"]);
      expect(result.indexedAt).toBeDefined();
      // indexedAt should be a valid ISO string
      expect(new Date(result.indexedAt).toISOString()).toBe(result.indexedAt);
    });
  });

  describe("generateTaskIndex", () => {
    it("returns TaskIndex with all fields and indexedAt timestamp", () => {
      const fm: TaskFrontmatter = {
        id: "TASK-001",
        title: "Build feature",
        status: "in-progress",
        column: "In Progress",
        priority: "high",
        capabilities: ["code"],
        depends_on: [],
        claimed_by: "agent-1",
        claimed_at: "2026-01-01T00:00:00Z",
        parent: null,
      };
      const result = generateTaskIndex(fm);
      expect(result.id).toBe("TASK-001");
      expect(result.title).toBe("Build feature");
      expect(result.status).toBe("in-progress");
      expect(result.priority).toBe("high");
      expect(result.claimed_by).toBe("agent-1");
      expect(result.indexedAt).toBeDefined();
    });
  });

  describe("generateBoardIndex", () => {
    it("groups tasks by column into provided columns", () => {
      const tasks: TaskFrontmatter[] = [
        {
          id: "TASK-001",
          title: "A",
          status: "backlog",
          column: "Backlog",
          priority: "medium",
          capabilities: [],
          depends_on: [],
          claimed_by: null,
          claimed_at: null,
          parent: null,
        },
        {
          id: "TASK-002",
          title: "B",
          status: "in-progress",
          column: "In Progress",
          priority: "high",
          capabilities: [],
          depends_on: [],
          claimed_by: "agent-1",
          claimed_at: null,
          parent: null,
        },
      ];
      const result = generateBoardIndex(tasks, ["Backlog", "In Progress", "Done"]);
      expect(result.columns).toHaveLength(3);
      expect(result.columns[0].name).toBe("Backlog");
      expect(result.columns[0].tasks).toHaveLength(1);
      expect(result.columns[0].tasks[0].id).toBe("TASK-001");
      expect(result.columns[1].name).toBe("In Progress");
      expect(result.columns[1].tasks).toHaveLength(1);
      expect(result.columns[1].tasks[0].id).toBe("TASK-002");
      expect(result.columns[2].name).toBe("Done");
      expect(result.columns[2].tasks).toHaveLength(0);
      expect(result.indexedAt).toBeDefined();
    });

    it("returns empty task arrays for each column when tasks array is empty", () => {
      const result = generateBoardIndex([], ["Backlog", "In Progress"]);
      expect(result.columns).toHaveLength(2);
      expect(result.columns[0].tasks).toHaveLength(0);
      expect(result.columns[1].tasks).toHaveLength(0);
    });

    it("places task with unknown column in first column as fallback", () => {
      const tasks: TaskFrontmatter[] = [
        {
          id: "TASK-001",
          title: "Orphan",
          status: "backlog",
          column: "NonExistent",
          priority: "low",
          capabilities: [],
          depends_on: [],
          claimed_by: null,
          claimed_at: null,
          parent: null,
        },
      ];
      const result = generateBoardIndex(tasks, ["Backlog", "Done"]);
      expect(result.columns[0].name).toBe("Backlog");
      expect(result.columns[0].tasks).toHaveLength(1);
      expect(result.columns[0].tasks[0].id).toBe("TASK-001");
    });
  });

  describe("generateQueueIndex", () => {
    it("returns QueueIndex with all queue sections and indexedAt", () => {
      const parsed: ParsedQueue = {
        frontmatter: { updated: "2026-01-01" },
        available: [{ taskId: "TASK-001", metadata: {} }],
        claimed: [{ taskId: "TASK-002", metadata: { agent: "bot" } }],
        blocked: [],
        done: [{ taskId: "TASK-003", metadata: {} }],
      };
      const result = generateQueueIndex(parsed);
      expect(result.available).toHaveLength(1);
      expect(result.available[0].taskId).toBe("TASK-001");
      expect(result.claimed).toHaveLength(1);
      expect(result.blocked).toHaveLength(0);
      expect(result.done).toHaveLength(1);
      expect(result.indexedAt).toBeDefined();
    });
  });

  describe("writeIndexFile", () => {
    it("writes JSON atomically and leaves no temp files", async () => {
      const filePath = path.join(tmpDir, "test.json");
      const data = { hello: "world", num: 42 };
      await writeIndexFile(filePath, data);

      const content = await fs.readFile(filePath, "utf-8");
      expect(JSON.parse(content)).toEqual(data);

      // No .tmp files should remain
      const files = await fs.readdir(tmpDir);
      const tmpFiles = files.filter((f) => f.endsWith(".tmp"));
      expect(tmpFiles).toHaveLength(0);
    });

    it("creates parent directories if they do not exist", async () => {
      const filePath = path.join(tmpDir, "nested", "deep", "test.json");
      await writeIndexFile(filePath, { nested: true });
      const content = await fs.readFile(filePath, "utf-8");
      expect(JSON.parse(content)).toEqual({ nested: true });
    });
  });

  describe("generateAllIndexes", () => {
    it("reads project files and writes all .index/ files", async () => {
      // Set up a project directory
      const projectDir = path.join(tmpDir, "my-project");
      await fs.mkdir(path.join(projectDir, "tasks"), { recursive: true });

      await fs.writeFile(
        path.join(projectDir, "PROJECT.md"),
        `---
name: my-project
status: active
tags: []
columns:
  - Backlog
  - In Progress
  - Done
dashboard:
  widgets:
    - project-status
---

# My Project
`,
        "utf-8",
      );

      await fs.writeFile(
        path.join(projectDir, "tasks", "TASK-001.md"),
        `---
id: TASK-001
title: First task
status: backlog
column: Backlog
priority: medium
capabilities: []
depends_on: []
claimed_by: null
claimed_at: null
parent: null
---

# TASK-001
`,
        "utf-8",
      );

      await fs.writeFile(
        path.join(projectDir, "queue.md"),
        `---
updated: "2026-01-01"
---

## Available

- TASK-001

## Claimed

## Done

## Blocked
`,
        "utf-8",
      );

      const events = await generateAllIndexes(projectDir);

      // Verify .index/ files exist
      const projectJson = JSON.parse(
        await fs.readFile(path.join(projectDir, ".index", "project.json"), "utf-8"),
      );
      expect(projectJson.name).toBe("my-project");
      expect(projectJson.indexedAt).toBeDefined();

      const boardJson = JSON.parse(
        await fs.readFile(path.join(projectDir, ".index", "board.json"), "utf-8"),
      );
      expect(boardJson.columns).toHaveLength(3);

      const queueJson = JSON.parse(
        await fs.readFile(path.join(projectDir, ".index", "queue.json"), "utf-8"),
      );
      expect(queueJson.available).toHaveLength(1);

      const taskJson = JSON.parse(
        await fs.readFile(path.join(projectDir, ".index", "tasks", "TASK-001.json"), "utf-8"),
      );
      expect(taskJson.id).toBe("TASK-001");

      // Verify events
      expect(events).toContainEqual({ type: "project:changed", project: "my-project" });
      expect(events).toContainEqual({
        type: "task:changed",
        project: "my-project",
        taskId: "TASK-001",
      });
      expect(events).toContainEqual({ type: "queue:changed", project: "my-project" });
      expect(events).toContainEqual({ type: "reindex:complete", project: "my-project" });
    });

    it("skips files with invalid frontmatter and still generates valid indexes", async () => {
      const projectDir = path.join(tmpDir, "partial-project");
      await fs.mkdir(path.join(projectDir, "tasks"), { recursive: true });

      await fs.writeFile(
        path.join(projectDir, "PROJECT.md"),
        `---
name: partial-project
status: active
tags: []
columns:
  - Backlog
  - Done
dashboard:
  widgets:
    - project-status
---

# Partial
`,
        "utf-8",
      );

      // Valid task
      await fs.writeFile(
        path.join(projectDir, "tasks", "TASK-001.md"),
        `---
id: TASK-001
title: Valid task
status: backlog
column: Backlog
priority: medium
capabilities: []
depends_on: []
claimed_by: null
claimed_at: null
parent: null
---
`,
        "utf-8",
      );

      // Invalid task (missing required fields)
      await fs.writeFile(
        path.join(projectDir, "tasks", "TASK-002.md"),
        `---
not_a_valid_field: true
---
`,
        "utf-8",
      );

      await fs.writeFile(
        path.join(projectDir, "queue.md"),
        `---
updated: "2026-01-01"
---

## Available

## Claimed

## Done

## Blocked
`,
        "utf-8",
      );

      const events = await generateAllIndexes(projectDir);

      // Board should have only TASK-001
      const boardJson = JSON.parse(
        await fs.readFile(path.join(projectDir, ".index", "board.json"), "utf-8"),
      );
      const allTasks = boardJson.columns.flatMap((c: { tasks: unknown[] }) => c.tasks);
      expect(allTasks).toHaveLength(1);

      // TASK-001.json should exist, TASK-002.json should not
      await expect(
        fs.access(path.join(projectDir, ".index", "tasks", "TASK-001.json")),
      ).resolves.toBeUndefined();
      await expect(
        fs.access(path.join(projectDir, ".index", "tasks", "TASK-002.json")),
      ).rejects.toThrow();

      // Events should still include reindex:complete
      expect(events).toContainEqual({
        type: "reindex:complete",
        project: "partial-project",
      });
    });
  });
});
