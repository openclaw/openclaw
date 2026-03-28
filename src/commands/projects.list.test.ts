import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectManager } from "../projects/scaffold.js";
import { projectsListCommand } from "./projects.list.js";

describe("projectsListCommand", () => {
  let tmpDir: string;
  let homeDir: string;
  let projectsRoot: string;
  let logSpy: ReturnType<typeof vi.fn>;
  let errorSpy: ReturnType<typeof vi.fn>;
  let exitSpy: ReturnType<typeof vi.fn>;
  let writeJsonSpy: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "oc-list-test-"));
    homeDir = tmpDir;
    projectsRoot = path.join(homeDir, ".openclaw", "projects");
    logSpy = vi.fn();
    errorSpy = vi.fn();
    exitSpy = vi.fn();
    writeJsonSpy = vi.fn();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("displays table with Name, Status, Tasks, Owner columns when projects exist", async () => {
    const manager = new ProjectManager(homeDir);
    await manager.create({ name: "alpha", description: "First project", owner: "alice" });
    await manager.create({ name: "beta", description: "Second project", owner: "bob" });

    await projectsListCommand(
      {},
      { homeDir },
      { log: logSpy, error: errorSpy, exit: exitSpy, writeStdout: vi.fn(), writeJson: writeJsonSpy },
    );

    const output = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
    expect(output).toContain("alpha");
    expect(output).toContain("beta");
    // Should contain table headers
    expect(output).toContain("Name");
    expect(output).toContain("Status");
    expect(output).toContain("Tasks");
    expect(output).toContain("Owner");
  });

  it("prints helpful message when no projects found", async () => {
    await projectsListCommand(
      {},
      { homeDir },
      { log: logSpy, error: errorSpy, exit: exitSpy, writeStdout: vi.fn(), writeJson: writeJsonSpy },
    );

    const output = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
    expect(output).toContain("No projects found. Create one with: openclaw projects create");
  });

  it("outputs JSON array with --json flag", async () => {
    const manager = new ProjectManager(homeDir);
    await manager.create({ name: "gamma", owner: "carol" });

    await projectsListCommand(
      { json: true },
      { homeDir },
      { log: logSpy, error: errorSpy, exit: exitSpy, writeStdout: vi.fn(), writeJson: writeJsonSpy },
    );

    expect(writeJsonSpy).toHaveBeenCalled();
    const jsonArg = writeJsonSpy.mock.calls[0][0];
    expect(Array.isArray(jsonArg)).toBe(true);
    expect(jsonArg.length).toBe(1);
    expect(jsonArg[0].name).toBe("gamma");
  });
});
