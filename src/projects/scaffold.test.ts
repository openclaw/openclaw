import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import YAML from "yaml";
import { ProjectFrontmatterSchema } from "./schemas.js";
import { ProjectManager } from "./scaffold.js";
import { createTempHomeEnv, type TempHomeEnv } from "../test-utils/temp-home.js";

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
});
