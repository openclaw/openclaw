import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import YAML from "yaml";
import { createTempHomeEnv, type TempHomeEnv } from "../test-utils/temp-home.js";
import { ProjectManager } from "./scaffold.js";
import { ProjectFrontmatterSchema } from "./schemas.js";

describe("ProjectManager", () => {
  let env: TempHomeEnv;

  beforeEach(async () => {
    env = await createTempHomeEnv("scaffold-test-");
  });

  afterEach(async () => {
    await env.restore();
  });

  it("create() produces PROJECT.md with valid YAML frontmatter", async () => {
    const pm = new ProjectManager(env.home);
    const dir = await pm.create({ name: "test-project" });

    const content = await fs.readFile(path.join(dir, "PROJECT.md"), "utf-8");
    // Extract frontmatter between --- delimiters
    const match = content.match(/^---\n([\s\S]*?)\n---/);
    expect(match).toBeTruthy();

    const parsed = YAML.parse(match![1]);
    const result = ProjectFrontmatterSchema.parse(parsed);
    expect(result.name).toBe("test-project");
    expect(result.status).toBe("active");
    expect(result.columns).toEqual(["Backlog", "In Progress", "Review", "Done"]);
    expect(result.dashboard.widgets).toEqual([
      "project-status",
      "task-counts",
      "active-agents",
      "sub-project-status",
      "recent-activity",
      "blockers",
    ]);
  });

  it("create() produces queue.md with four empty sections", async () => {
    const pm = new ProjectManager(env.home);
    const dir = await pm.create({ name: "test-project" });

    const content = await fs.readFile(path.join(dir, "queue.md"), "utf-8");
    expect(content).toContain("## Available");
    expect(content).toContain("## Claimed");
    expect(content).toContain("## Done");
    expect(content).toContain("## Blocked");
  });

  it("create() produces tasks/.gitkeep", async () => {
    const pm = new ProjectManager(env.home);
    const dir = await pm.create({ name: "test-project" });

    // Should not throw
    await fs.access(path.join(dir, "tasks", ".gitkeep"));
  });

  it("create() with description and owner populates frontmatter fields", async () => {
    const pm = new ProjectManager(env.home);
    const dir = await pm.create({
      name: "my-project",
      description: "A cool project",
      owner: "alice",
    });

    const content = await fs.readFile(path.join(dir, "PROJECT.md"), "utf-8");
    const match = content.match(/^---\n([\s\S]*?)\n---/);
    expect(match).toBeTruthy();

    const parsed = YAML.parse(match![1]);
    expect(parsed.description).toBe("A cool project");
    expect(parsed.owner).toBe("alice");
  });

  it("create() for existing project throws descriptive error", async () => {
    const pm = new ProjectManager(env.home);
    await pm.create({ name: "duplicate" });

    await expect(pm.create({ name: "duplicate" })).rejects.toThrow("Project already exists at");
  });

  it("create() with YAML special characters produces valid frontmatter", async () => {
    const pm = new ProjectManager(env.home);
    const dir = await pm.create({ name: "project: with #special chars" });

    const content = await fs.readFile(path.join(dir, "PROJECT.md"), "utf-8");
    const match = content.match(/^---\n([\s\S]*?)\n---/);
    expect(match).toBeTruthy();

    const parsed = YAML.parse(match![1]);
    const result = ProjectFrontmatterSchema.parse(parsed);
    expect(result.name).toBe("project: with #special chars");
  });

  it("constructor accepts custom homeDir; defaults to resolveRequiredHomeDir()", async () => {
    // With custom homeDir
    const pm = new ProjectManager(env.home);
    const dir = await pm.create({ name: "custom-home" });
    expect(dir).toContain(env.home);

    // Default constructor uses resolveRequiredHomeDir() (env.home is set in createTempHomeEnv)
    const pmDefault = new ProjectManager();
    const dirDefault = await pmDefault.create({ name: "default-home" });
    expect(dirDefault).toContain(env.home);
  });

  describe("createSubProject", () => {
    it("creates sub-project with PROJECT.md, queue.md, and tasks/.gitkeep", async () => {
      const pm = new ProjectManager(env.home);
      await pm.create({ name: "parent-proj" });

      const subDir = await pm.createSubProject({ name: "sub-one", parent: "parent-proj" });

      expect(subDir).toBe(
        path.join(env.home, ".openclaw", "projects", "parent-proj", "sub-projects", "sub-one"),
      );
      await fs.access(path.join(subDir, "PROJECT.md"));
      await fs.access(path.join(subDir, "queue.md"));
      await fs.access(path.join(subDir, "tasks", ".gitkeep"));
    });

    it("sub-project has its own independent queue.md with empty sections", async () => {
      const pm = new ProjectManager(env.home);
      await pm.create({ name: "parent-proj" });

      const subDir = await pm.createSubProject({ name: "sub-queue", parent: "parent-proj" });

      const content = await fs.readFile(path.join(subDir, "queue.md"), "utf-8");
      expect(content).toContain("## Available");
      expect(content).toContain("## Claimed");
      expect(content).toContain("## Done");
      expect(content).toContain("## Blocked");
    });

    it("throws for non-existent parent project", async () => {
      const pm = new ProjectManager(env.home);

      await expect(
        pm.createSubProject({ name: "orphan", parent: "no-such-parent" }),
      ).rejects.toThrow("does not exist");
    });

    it("throws for already-existing sub-project", async () => {
      const pm = new ProjectManager(env.home);
      await pm.create({ name: "parent-proj" });
      await pm.createSubProject({ name: "dup-sub", parent: "parent-proj" });

      await expect(pm.createSubProject({ name: "dup-sub", parent: "parent-proj" })).rejects.toThrow(
        "already exists",
      );
    });

    it("generated PROJECT.md validates against ProjectFrontmatterSchema", async () => {
      const pm = new ProjectManager(env.home);
      await pm.create({ name: "parent-proj" });

      const subDir = await pm.createSubProject({
        name: "valid-sub",
        parent: "parent-proj",
        description: "A sub-project",
        owner: "bob",
      });

      const content = await fs.readFile(path.join(subDir, "PROJECT.md"), "utf-8");
      const match = content.match(/^---\n([\s\S]*?)\n---/);
      expect(match).toBeTruthy();

      const parsed = YAML.parse(match![1]);
      const result = ProjectFrontmatterSchema.parse(parsed);
      expect(result.name).toBe("valid-sub");
      expect(result.description).toBe("A sub-project");
      expect(result.owner).toBe("bob");
    });

    it("multiple sub-projects coexist under the same parent", async () => {
      const pm = new ProjectManager(env.home);
      await pm.create({ name: "parent-proj" });

      const sub1 = await pm.createSubProject({ name: "alpha", parent: "parent-proj" });
      const sub2 = await pm.createSubProject({ name: "beta", parent: "parent-proj" });

      // Both directories exist and are distinct
      await fs.access(path.join(sub1, "PROJECT.md"));
      await fs.access(path.join(sub2, "PROJECT.md"));
      expect(sub1).not.toBe(sub2);

      // Verify both are under sub-projects/
      const subProjectsDir = path.join(
        env.home,
        ".openclaw",
        "projects",
        "parent-proj",
        "sub-projects",
      );
      const entries = await fs.readdir(subProjectsDir);
      expect(entries.toSorted()).toEqual(["alpha", "beta"]);
    });
  });

  describe("nextTaskId", () => {
    it("returns TASK-001 when tasks/ directory is empty (only .gitkeep)", async () => {
      const pm = new ProjectManager(env.home);
      const dir = await pm.create({ name: "id-test" });

      const id = await pm.nextTaskId(dir);
      expect(id).toBe("TASK-001");
    });

    it("returns TASK-001 when tasks/ directory does not exist", async () => {
      const pm = new ProjectManager(env.home);
      const dir = await pm.create({ name: "id-test" });

      // Remove the tasks/ directory entirely
      await fs.rm(path.join(dir, "tasks"), { recursive: true });

      const id = await pm.nextTaskId(dir);
      expect(id).toBe("TASK-001");
    });

    it("returns TASK-004 when tasks/ contains TASK-001 through TASK-003", async () => {
      const pm = new ProjectManager(env.home);
      const dir = await pm.create({ name: "id-test" });
      const tasksDir = path.join(dir, "tasks");

      for (const n of ["001", "002", "003"]) {
        await fs.writeFile(
          path.join(tasksDir, `TASK-${n}.md`),
          `---\nid: TASK-${n}\ntitle: test\n---\n`,
        );
      }

      const id = await pm.nextTaskId(dir);
      expect(id).toBe("TASK-004");
    });

    it("returns TASK-006 with gaps (never reuses lower IDs)", async () => {
      const pm = new ProjectManager(env.home);
      const dir = await pm.create({ name: "id-test" });
      const tasksDir = path.join(dir, "tasks");

      // Only TASK-002 and TASK-005 exist (gaps from deletions)
      await fs.writeFile(
        path.join(tasksDir, "TASK-002.md"),
        "---\nid: TASK-002\ntitle: test\n---\n",
      );
      await fs.writeFile(
        path.join(tasksDir, "TASK-005.md"),
        "---\nid: TASK-005\ntitle: test\n---\n",
      );

      const id = await pm.nextTaskId(dir);
      expect(id).toBe("TASK-006");
    });

    it("ignores non-task files in tasks/ directory", async () => {
      const pm = new ProjectManager(env.home);
      const dir = await pm.create({ name: "id-test" });
      const tasksDir = path.join(dir, "tasks");

      await fs.writeFile(path.join(tasksDir, "README.md"), "# Notes\n");
      await fs.writeFile(path.join(tasksDir, "notes.txt"), "some notes\n");
      await fs.writeFile(
        path.join(tasksDir, "TASK-001.md"),
        "---\nid: TASK-001\ntitle: test\n---\n",
      );

      const id = await pm.nextTaskId(dir);
      expect(id).toBe("TASK-002");
    });

    it("grows beyond 3 digits (TASK-1000 after TASK-999)", async () => {
      const pm = new ProjectManager(env.home);
      const dir = await pm.create({ name: "id-test" });
      const tasksDir = path.join(dir, "tasks");

      await fs.writeFile(
        path.join(tasksDir, "TASK-999.md"),
        "---\nid: TASK-999\ntitle: test\n---\n",
      );

      const id = await pm.nextTaskId(dir);
      expect(id).toBe("TASK-1000");
    });

    it("works independently per project (separate ID sequences)", async () => {
      const pm = new ProjectManager(env.home);
      const dirA = await pm.create({ name: "project-a" });
      const dirB = await pm.create({ name: "project-b" });

      // Add 3 tasks to project A
      for (const n of ["001", "002", "003"]) {
        await fs.writeFile(
          path.join(dirA, "tasks", `TASK-${n}.md`),
          `---\nid: TASK-${n}\ntitle: test\n---\n`,
        );
      }

      // Add 1 task to project B
      await fs.writeFile(
        path.join(dirB, "tasks", "TASK-001.md"),
        "---\nid: TASK-001\ntitle: test\n---\n",
      );

      expect(await pm.nextTaskId(dirA)).toBe("TASK-004");
      expect(await pm.nextTaskId(dirB)).toBe("TASK-002");
    });
  });
});
