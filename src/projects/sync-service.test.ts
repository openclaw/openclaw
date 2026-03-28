import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateAllIndexes } from "./index-generator.js";
import { ProjectSyncService } from "./sync-service.js";
import type { SyncEvent } from "./sync-types.js";

/** Minimal PROJECT.md with valid frontmatter. */
const PROJECT_MD = `---
name: test-project
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

# Test Project
`;

/** Minimal valid task frontmatter. */
const TASK_MD = `---
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
`;

/** Minimal queue.md. */
const QUEUE_MD = `---
updated: "2026-01-01"
---

## Available

- TASK-001

## Claimed

## Done

## Blocked
`;

describe("ProjectSyncService", () => {
  let tmpDir: string;
  const tmpDirs: string[] = [];

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "sync-svc-test-"));
    tmpDirs.push(tmpDir);
  });

  afterEach(async () => {
    for (const dir of tmpDirs) {
      await fs.rm(dir, { recursive: true, force: true });
    }
    tmpDirs.length = 0;
  });

  /** Helper: set up a project folder structure. */
  async function createProject(
    root: string,
    name: string,
    opts?: { skipQueue?: boolean; extraTask?: string },
  ): Promise<string> {
    const projectDir = path.join(root, name);
    await fs.mkdir(path.join(projectDir, "tasks"), { recursive: true });
    await fs.writeFile(path.join(projectDir, "PROJECT.md"), PROJECT_MD, "utf-8");
    await fs.writeFile(path.join(projectDir, "tasks", "TASK-001.md"), TASK_MD, "utf-8");
    if (!opts?.skipQueue) {
      await fs.writeFile(path.join(projectDir, "queue.md"), QUEUE_MD, "utf-8");
    }
    if (opts?.extraTask) {
      await fs.writeFile(path.join(projectDir, "tasks", "TASK-002.md"), opts.extraTask, "utf-8");
    }
    return projectDir;
  }

  describe("discoverProjects", () => {
    it("finds project dirs containing PROJECT.md", async () => {
      await createProject(tmpDir, "alpha");
      await createProject(tmpDir, "beta");
      // A non-project directory (no PROJECT.md)
      await fs.mkdir(path.join(tmpDir, "not-a-project"), { recursive: true });

      const service = new ProjectSyncService(tmpDir);
      const projects = await service.discoverProjects();

      expect(projects).toHaveLength(2);
      expect(projects.toSorted()).toEqual([path.join(tmpDir, "alpha"), path.join(tmpDir, "beta")]);
    });

    it("finds sub-project directories", async () => {
      const parentDir = await createProject(tmpDir, "parent");
      // Create sub-project
      const subDir = path.join(parentDir, "sub-projects", "child");
      await fs.mkdir(path.join(subDir, "tasks"), { recursive: true });
      await fs.writeFile(path.join(subDir, "PROJECT.md"), PROJECT_MD, "utf-8");

      const service = new ProjectSyncService(tmpDir);
      const projects = await service.discoverProjects();

      expect(projects).toHaveLength(2);
      expect(projects).toContainEqual(parentDir);
      expect(projects).toContainEqual(subDir);
    });
  });

  describe("start and stop lifecycle", () => {
    it("start() performs full reindex and creates .index/ files", async () => {
      const projectDir = await createProject(tmpDir, "my-project");
      const service = new ProjectSyncService(tmpDir);

      await service.start();

      // Verify .index/ files were created
      const projectJson = JSON.parse(
        await fs.readFile(path.join(projectDir, ".index", "project.json"), "utf-8"),
      );
      expect(projectJson.name).toBe("test-project");
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

      await service.stop();
    });

    it("start() then stop() cleans up without errors", async () => {
      await createProject(tmpDir, "project-a");
      const service = new ProjectSyncService(tmpDir);

      await service.start();
      await service.stop();

      // Double stop should be safe (idempotent)
      await service.stop();
    });
  });

  describe("reindex after .index/ deletion (SYNC-07)", () => {
    it("generateAllIndexes regenerates after .index/ deletion", async () => {
      const projectDir = await createProject(tmpDir, "regen-project");
      const service = new ProjectSyncService(tmpDir);

      await service.start();

      // Verify initial index exists
      await expect(
        fs.access(path.join(projectDir, ".index", "project.json")),
      ).resolves.toBeUndefined();

      // Delete .index/
      await fs.rm(path.join(projectDir, ".index"), { recursive: true, force: true });

      // Verify it is gone
      await expect(fs.access(path.join(projectDir, ".index"))).rejects.toThrow();

      // Re-generate using generateAllIndexes directly
      const events = await generateAllIndexes(projectDir);

      // Verify all .index/ files are recreated
      const projectJson = JSON.parse(
        await fs.readFile(path.join(projectDir, ".index", "project.json"), "utf-8"),
      );
      expect(projectJson.name).toBe("test-project");

      expect(events).toContainEqual({ type: "reindex:complete", project: "regen-project" });

      await service.stop();
    });
  });

  describe("error handling", () => {
    it("skips files with invalid frontmatter during reindex (D-09)", async () => {
      const projectDir = await createProject(tmpDir, "partial-project", {
        extraTask: `---
not_a_valid_field: true
---
# Bad Task
`,
      });

      const service = new ProjectSyncService(tmpDir);

      // Should not throw
      await service.start();

      // Valid project.json should exist
      const projectJson = JSON.parse(
        await fs.readFile(path.join(projectDir, ".index", "project.json"), "utf-8"),
      );
      expect(projectJson.name).toBe("test-project");

      // Only TASK-001 should be indexed (TASK-002 has invalid frontmatter)
      await expect(
        fs.access(path.join(projectDir, ".index", "tasks", "TASK-001.json")),
      ).resolves.toBeUndefined();

      await service.stop();
    });
  });

  describe("event emission", () => {
    it("emits sync events on reindex", async () => {
      await createProject(tmpDir, "event-project");
      const service = new ProjectSyncService(tmpDir);
      const events: SyncEvent[] = [];

      service.on("sync", (event: SyncEvent) => {
        events.push(event);
      });

      await service.start();

      // Should have emitted reindex:complete and project/task/queue events
      expect(events.length).toBeGreaterThan(0);
      expect(events).toContainEqual({
        type: "reindex:complete",
        project: "event-project",
      });

      await service.stop();
    });
  });
});
