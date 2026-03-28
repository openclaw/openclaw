import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectManager } from "../projects/scaffold.js";
import type { OutputRuntimeEnv } from "../runtime.js";
import { projectsListCommand } from "./projects.list.js";

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

describe("projectsListCommand", () => {
  let tmpDir: string;
  let homeDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "oc-list-test-"));
    homeDir = tmpDir;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("displays table with Name, Status, Tasks, Owner columns when projects exist", async () => {
    const manager = new ProjectManager(homeDir);
    await manager.create({ name: "alpha", description: "First project", owner: "alice" });
    await manager.create({ name: "beta", description: "Second project", owner: "bob" });

    const runtime = makeRuntime();
    await projectsListCommand({}, { homeDir }, runtime);

    const output = vi
      .mocked(runtime.log)
      .mock.calls.map((c) => String(c[0]))
      .join("\n");
    expect(output).toContain("alpha");
    expect(output).toContain("beta");
    // Should contain table headers
    expect(output).toContain("Name");
    expect(output).toContain("Status");
    expect(output).toContain("Tasks");
    expect(output).toContain("Owner");
  });

  it("prints helpful message when no projects found", async () => {
    const runtime = makeRuntime();
    await projectsListCommand({}, { homeDir }, runtime);

    const output = vi
      .mocked(runtime.log)
      .mock.calls.map((c) => String(c[0]))
      .join("\n");
    expect(output).toContain("No projects found. Create one with: openclaw projects create");
  });

  it("outputs JSON array with --json flag", async () => {
    const manager = new ProjectManager(homeDir);
    await manager.create({ name: "gamma", owner: "carol" });

    const runtime = makeRuntime();
    await projectsListCommand({ json: true }, { homeDir }, runtime);

    expect(runtime.writeJson).toHaveBeenCalled();
    const jsonArg = vi.mocked(runtime.writeJson).mock.calls[0]?.[0] as Array<{ name: string }>;
    expect(Array.isArray(jsonArg)).toBe(true);
    expect(jsonArg.length).toBe(1);
    expect(jsonArg[0]?.name).toBe("gamma");
  });
});
