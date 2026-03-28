import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectManager } from "../projects/scaffold.js";
import type { OutputRuntimeEnv } from "../runtime.js";
import { projectsValidateCommand } from "./projects.validate.js";

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

describe("projectsValidateCommand", () => {
  let tmpDir: string;
  let homeDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "oc-validate-test-"));
    homeDir = tmpDir;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("exits 0 and prints 'All files valid' when all frontmatter is correct", async () => {
    const manager = new ProjectManager(homeDir);
    const projectDir = await manager.create({ name: "clean-proj" });

    // Add a valid task file
    const taskContent = `---\nid: TASK-001\ntitle: A Task\nstatus: backlog\ncolumn: Backlog\npriority: medium\n---\n\n# A Task\n`;
    await fs.writeFile(path.join(projectDir, "tasks", "TASK-001.md"), taskContent, "utf-8");

    const runtime = makeRuntime();
    await projectsValidateCommand({}, { homeDir }, runtime);

    const output = vi
      .mocked(runtime.log)
      .mock.calls.map((c) => String(c[0]))
      .join("\n");
    expect(output).toContain("All files valid");
    expect(runtime.exit).not.toHaveBeenCalled();
  });

  it("reports file path and error for malformed PROJECT.md", async () => {
    const manager = new ProjectManager(homeDir);
    const projectDir = await manager.create({ name: "bad-proj" });

    // Overwrite PROJECT.md with invalid frontmatter (missing required 'name')
    await fs.writeFile(
      path.join(projectDir, "PROJECT.md"),
      "---\nstatus: active\n---\n\n# Bad Project\n",
      "utf-8",
    );

    const runtime = makeRuntime();
    await projectsValidateCommand({}, { homeDir }, runtime);

    const errorOutput = vi
      .mocked(runtime.error)
      .mock.calls.map((c) => String(c[0]))
      .join("\n");
    expect(errorOutput).toContain("PROJECT.md");
  });

  it("reports file path and error for malformed task file", async () => {
    const manager = new ProjectManager(homeDir);
    const projectDir = await manager.create({ name: "bad-task-proj" });

    // Write a task with invalid frontmatter (missing required 'id')
    await fs.writeFile(
      path.join(projectDir, "tasks", "TASK-001.md"),
      "---\ntitle: Missing ID\nstatus: backlog\n---\n\n# Bad Task\n",
      "utf-8",
    );

    const runtime = makeRuntime();
    await projectsValidateCommand({}, { homeDir }, runtime);

    const errorOutput = vi
      .mocked(runtime.error)
      .mock.calls.map((c) => String(c[0]))
      .join("\n");
    expect(errorOutput).toContain("TASK-001.md");
  });

  it("exits 1 when any parse errors found", async () => {
    const manager = new ProjectManager(homeDir);
    const projectDir = await manager.create({ name: "error-proj" });

    // Write invalid task
    await fs.writeFile(
      path.join(projectDir, "tasks", "TASK-001.md"),
      "---\ntitle: No ID\nstatus: backlog\n---\n",
      "utf-8",
    );

    const runtime = makeRuntime();
    await projectsValidateCommand({}, { homeDir }, runtime);

    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it("outputs JSON array of errors with --json flag", async () => {
    const manager = new ProjectManager(homeDir);
    const projectDir = await manager.create({ name: "json-err-proj" });

    // Write invalid task
    await fs.writeFile(
      path.join(projectDir, "tasks", "TASK-001.md"),
      "---\ntitle: No ID\nstatus: backlog\n---\n",
      "utf-8",
    );

    const runtime = makeRuntime();
    await projectsValidateCommand({ json: true }, { homeDir }, runtime);

    expect(runtime.writeJson).toHaveBeenCalled();
    const jsonArg = vi.mocked(runtime.writeJson).mock.calls[0][0] as Array<{
      file: string;
      error: string;
    }>;
    expect(Array.isArray(jsonArg)).toBe(true);
    expect(jsonArg.length).toBeGreaterThan(0);
    expect(jsonArg[0].file).toContain("TASK-001.md");
  });
});
