import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectManager } from "../projects/scaffold.js";
import type { OutputRuntimeEnv } from "../runtime.js";
import { projectsReindexCommand } from "./projects.reindex.js";

function makeRuntime(overrides?: Partial<OutputRuntimeEnv>): OutputRuntimeEnv {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
    writeStdout: vi.fn(),
    writeJson: vi.fn(),
    ...overrides,
  };
}

async function writeTask(projectDir: string, id: string): Promise<void> {
  const content = `---\nid: ${id}\ntitle: Task ${id}\nstatus: backlog\ncolumn: Backlog\npriority: medium\n---\n\n# Task ${id}\n`;
  await fs.writeFile(path.join(projectDir, "tasks", `${id}.md`), content, "utf-8");
}

describe("projectsReindexCommand", () => {
  let tmpDir: string;
  let homeDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "oc-reindex-test-"));
    homeDir = tmpDir;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("regenerates .index/ directory for each discovered project", async () => {
    const manager = new ProjectManager(homeDir);
    const projectDir = await manager.create({ name: "proj1" });
    await writeTask(projectDir, "TASK-001");

    const runtime = makeRuntime();
    await projectsReindexCommand({}, { homeDir }, runtime);

    // .index/ should exist with project.json
    const indexDir = path.join(projectDir, ".index");
    const stat = await fs.stat(indexDir);
    expect(stat.isDirectory()).toBe(true);

    const projectJson = await fs.readFile(path.join(indexDir, "project.json"), "utf-8");
    const parsed = JSON.parse(projectJson);
    expect(parsed.name).toBe("proj1");
  });

  it("prints per-project progress with task count", async () => {
    const manager = new ProjectManager(homeDir);
    const projectDir = await manager.create({ name: "alpha" });
    await writeTask(projectDir, "TASK-001");
    await writeTask(projectDir, "TASK-002");

    const runtime = makeRuntime();
    await projectsReindexCommand({}, { homeDir }, runtime);

    const output = vi
      .mocked(runtime.log)
      .mock.calls.map((c) => String(c[0]))
      .join("\n");
    expect(output).toContain("Reindexed: alpha (2 tasks)");
  });

  it("removes stale .lock files older than 60s", async () => {
    const manager = new ProjectManager(homeDir);
    const projectDir = await manager.create({ name: "locked-proj" });

    // Create a stale lock file (timestamp 2 minutes ago, dead PID)
    const lockPath = path.join(projectDir, "queue.md.lock");
    const staleLock = JSON.stringify({ pid: 999999, timestamp: Date.now() - 120_000 });
    await fs.writeFile(lockPath, staleLock, "utf-8");

    const runtime = makeRuntime();
    await projectsReindexCommand({}, { homeDir }, runtime);

    // Lock file should be removed
    await expect(fs.access(lockPath)).rejects.toThrow();

    const output = vi
      .mocked(runtime.log)
      .mock.calls.map((c) => String(c[0]))
      .join("\n");
    expect(output).toContain("Cleared 1 stale lock(s)");
  });

  it("preserves fresh .lock files from live PIDs", async () => {
    const manager = new ProjectManager(homeDir);
    const projectDir = await manager.create({ name: "fresh-proj" });

    // Create a fresh lock file with our own PID (alive)
    const lockPath = path.join(projectDir, "queue.md.lock");
    const freshLock = JSON.stringify({ pid: process.pid, timestamp: Date.now() });
    await fs.writeFile(lockPath, freshLock, "utf-8");

    const runtime = makeRuntime();
    await projectsReindexCommand({}, { homeDir }, runtime);

    // Lock file should still exist
    const stat = await fs.stat(lockPath);
    expect(stat.isFile()).toBe(true);

    const output = vi
      .mocked(runtime.log)
      .mock.calls.map((c) => String(c[0]))
      .join("\n");
    expect(output).toContain("Cleared 0 stale lock(s)");
  });

  it("outputs JSON summary with --json flag", async () => {
    const manager = new ProjectManager(homeDir);
    await manager.create({ name: "json-proj" });

    const runtime = makeRuntime();
    await projectsReindexCommand({ json: true }, { homeDir }, runtime);

    expect(runtime.writeJson).toHaveBeenCalledWith(
      expect.objectContaining({ projects: 1, locksCleared: 0 }),
    );
  });

  it("prints 'No projects found' when empty", async () => {
    const runtime = makeRuntime();
    await projectsReindexCommand({}, { homeDir }, runtime);

    const output = vi
      .mocked(runtime.log)
      .mock.calls.map((c) => String(c[0]))
      .join("\n");
    expect(output).toContain("No projects found. Create one with: openclaw projects create");
  });
});
