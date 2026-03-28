import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { projectsCreateCommand } from "./projects.create.js";

vi.mock("@clack/prompts", () => ({
  text: vi.fn(),
  isCancel: vi.fn(() => false),
}));

describe("projectsCreateCommand", () => {
  let tmpDir: string;
  let homeDir: string;
  let logSpy: ReturnType<typeof vi.fn>;
  let errorSpy: ReturnType<typeof vi.fn>;
  let exitSpy: ReturnType<typeof vi.fn>;
  let writeJsonSpy: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "oc-create-test-"));
    homeDir = tmpDir;
    logSpy = vi.fn();
    errorSpy = vi.fn();
    exitSpy = vi.fn();
    writeJsonSpy = vi.fn();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("creates project directory with PROJECT.md, queue.md, and tasks/", async () => {
    await projectsCreateCommand(
      { name: "myproject", description: "A test project", owner: "alice" },
      { homeDir },
      { log: logSpy, error: errorSpy, exit: exitSpy, writeStdout: vi.fn(), writeJson: writeJsonSpy },
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
    await projectsCreateCommand(
      { name: "testproj" },
      { homeDir },
      { log: logSpy, error: errorSpy, exit: exitSpy, writeStdout: vi.fn(), writeJson: writeJsonSpy },
    );

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Created project at"));
  });

  it("calls createSubProject when --parent is provided", async () => {
    // First create parent
    await projectsCreateCommand(
      { name: "parent-proj" },
      { homeDir },
      { log: logSpy, error: errorSpy, exit: exitSpy, writeStdout: vi.fn(), writeJson: writeJsonSpy },
    );

    // Then create sub-project
    await projectsCreateCommand(
      { name: "child-proj", parent: "parent-proj" },
      { homeDir },
      { log: logSpy, error: errorSpy, exit: exitSpy, writeStdout: vi.fn(), writeJson: writeJsonSpy },
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
    await projectsCreateCommand(
      { name: "jsonproj", json: true },
      { homeDir },
      { log: logSpy, error: errorSpy, exit: exitSpy, writeStdout: vi.fn(), writeJson: writeJsonSpy },
    );

    expect(writeJsonSpy).toHaveBeenCalledWith(
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

    await projectsCreateCommand(
      {},
      { homeDir },
      { log: logSpy, error: errorSpy, exit: exitSpy, writeStdout: vi.fn(), writeJson: writeJsonSpy },
    );

    expect(textMock).toHaveBeenCalled();
    const projectDir = path.join(homeDir, ".openclaw", "projects", "interactive-proj");
    const stat = await fs.stat(projectDir);
    expect(stat.isDirectory()).toBe(true);
  });

  it("prints error and exits 1 for duplicate project name", async () => {
    const runtime = { log: logSpy, error: errorSpy, exit: exitSpy, writeStdout: vi.fn(), writeJson: writeJsonSpy };

    await projectsCreateCommand({ name: "dupproj" }, { homeDir }, runtime);

    await projectsCreateCommand({ name: "dupproj" }, { homeDir }, runtime);

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("already exists"));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
