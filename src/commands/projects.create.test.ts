import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OutputRuntimeEnv } from "../runtime.js";
import { projectsCreateCommand } from "./projects.create.js";

vi.mock("@clack/prompts", () => ({
  text: vi.fn(),
  isCancel: vi.fn(() => false),
}));

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

describe("projectsCreateCommand", () => {
  let tmpDir: string;
  let homeDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "oc-create-test-"));
    homeDir = tmpDir;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("creates project directory with PROJECT.md, queue.md, and tasks/", async () => {
    const runtime = makeRuntime();

    await projectsCreateCommand(
      { name: "myproject", description: "A test project", owner: "alice" },
      { homeDir },
      runtime,
    );

    const projectDir = path.join(homeDir, ".openclaw", "projects", "myproject");
    const stat = await fs.stat(projectDir);
    expect(stat.isDirectory()).toBe(true);

    const projectMd = await fs.readFile(path.join(projectDir, "PROJECT.md"), "utf-8");
    expect(projectMd).toContain("myproject");

    const queueMd = await fs.readFile(path.join(projectDir, "queue.md"), "utf-8");
    expect(queueMd).toBeTruthy();

    const tasksStat = await fs.stat(path.join(projectDir, "tasks"));
    expect(tasksStat.isDirectory()).toBe(true);
  });

  it("prints success message on creation", async () => {
    const runtime = makeRuntime();

    await projectsCreateCommand({ name: "testproj" }, { homeDir }, runtime);

    expect(runtime.log).toHaveBeenCalledWith(expect.stringContaining("Created project at"));
  });

  it("calls createSubProject when --parent is provided", async () => {
    const runtime = makeRuntime();

    // First create parent
    await projectsCreateCommand({ name: "parent-proj" }, { homeDir }, runtime);

    // Then create sub-project
    await projectsCreateCommand(
      { name: "child-proj", parent: "parent-proj" },
      { homeDir },
      runtime,
    );

    const subDir = path.join(
      homeDir,
      ".openclaw",
      "projects",
      "parent-proj",
      "sub-projects",
      "child-proj",
    );
    const stat = await fs.stat(subDir);
    expect(stat.isDirectory()).toBe(true);
  });

  it("outputs JSON with --json flag", async () => {
    const runtime = makeRuntime();

    await projectsCreateCommand({ name: "jsonproj", json: true }, { homeDir }, runtime);

    expect(runtime.writeJson).toHaveBeenCalledWith(
      expect.objectContaining({ name: "jsonproj", path: expect.stringContaining("jsonproj") }),
    );
  });

  it("prompts interactively when name not given", async () => {
    const prompts = await import("@clack/prompts");
    const textMock = vi.mocked(prompts.text);
    textMock
      .mockResolvedValueOnce("interactive-proj")
      .mockResolvedValueOnce("A description")
      .mockResolvedValueOnce("bob");

    const runtime = makeRuntime();

    await projectsCreateCommand({}, { homeDir }, runtime);

    expect(textMock).toHaveBeenCalled();
    const projectDir = path.join(homeDir, ".openclaw", "projects", "interactive-proj");
    const stat = await fs.stat(projectDir);
    expect(stat.isDirectory()).toBe(true);
  });

  it("prints error and exits 1 for duplicate project name", async () => {
    const runtime = makeRuntime();

    await projectsCreateCommand({ name: "dupproj" }, { homeDir }, runtime);
    await projectsCreateCommand({ name: "dupproj" }, { homeDir }, runtime);

    expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("already exists"));
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });
});
