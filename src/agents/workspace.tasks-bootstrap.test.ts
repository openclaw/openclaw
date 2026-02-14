import { describe, expect, it } from "vitest";
import { makeTempWorkspace, writeWorkspaceFile } from "../test-helpers/workspace.js";
import {
  DEFAULT_TASKS_FILENAME,
  filterBootstrapFilesForSession,
  loadWorkspaceBootstrapFiles,
} from "./workspace.js";

describe("TASKS.md bootstrap", () => {
  it("DEFAULT_TASKS_FILENAME equals TASKS.md", () => {
    expect(DEFAULT_TASKS_FILENAME).toBe("TASKS.md");
  });

  it("loadWorkspaceBootstrapFiles includes TASKS.md entry", async () => {
    const tempDir = await makeTempWorkspace("openclaw-tasks-");

    const files = await loadWorkspaceBootstrapFiles(tempDir);
    const tasksEntry = files.find((f) => f.name === DEFAULT_TASKS_FILENAME);

    expect(tasksEntry).toBeDefined();
  });

  it("loads TASKS.md content when the file exists", async () => {
    const tempDir = await makeTempWorkspace("openclaw-tasks-");
    await writeWorkspaceFile({ dir: tempDir, name: "TASKS.md", content: "- [ ] finish tests" });

    const files = await loadWorkspaceBootstrapFiles(tempDir);
    const tasksEntry = files.find((f) => f.name === DEFAULT_TASKS_FILENAME);

    expect(tasksEntry).toBeDefined();
    expect(tasksEntry!.missing).toBe(false);
    expect(tasksEntry!.content).toBe("- [ ] finish tests");
  });

  it("marks TASKS.md as missing (not error) when the file does not exist", async () => {
    const tempDir = await makeTempWorkspace("openclaw-tasks-");

    const files = await loadWorkspaceBootstrapFiles(tempDir);
    const tasksEntry = files.find((f) => f.name === DEFAULT_TASKS_FILENAME);

    expect(tasksEntry).toBeDefined();
    expect(tasksEntry!.missing).toBe(true);
    expect(tasksEntry!.content).toBeUndefined();
  });

  it("TASKS.md is in SUBAGENT_BOOTSTRAP_ALLOWLIST (kept for subagent sessions)", () => {
    const files = [
      {
        name: DEFAULT_TASKS_FILENAME as const,
        path: "/tmp/TASKS.md",
        missing: false,
        content: "tasks",
      },
      { name: "SOUL.md" as const, path: "/tmp/SOUL.md", missing: false, content: "soul" },
    ];

    const filtered = filterBootstrapFilesForSession(files, "agent:main:subagent:test-123");

    const tasksKept = filtered.find((f) => f.name === DEFAULT_TASKS_FILENAME);
    expect(tasksKept).toBeDefined();
  });

  it("filterBootstrapFilesForSession drops non-allowlisted files for subagent sessions", () => {
    const files = [
      {
        name: DEFAULT_TASKS_FILENAME as const,
        path: "/tmp/TASKS.md",
        missing: false,
        content: "tasks",
      },
      { name: "SOUL.md" as const, path: "/tmp/SOUL.md", missing: false, content: "soul" },
    ];

    const filtered = filterBootstrapFilesForSession(files, "agent:main:subagent:test-123");

    const soulKept = filtered.find((f) => f.name === "SOUL.md");
    expect(soulKept).toBeUndefined();
  });
});
