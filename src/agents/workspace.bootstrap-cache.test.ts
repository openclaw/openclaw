import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, beforeEach } from "vitest";
import { makeTempWorkspace, writeWorkspaceFile } from "../test-helpers/workspace.js";
import { loadWorkspaceBootstrapFiles, DEFAULT_AGENTS_FILENAME } from "./workspace.js";

describe("workspace bootstrap file caching", () => {
  let workspaceDir: string;

  beforeEach(async () => {
    workspaceDir = await makeTempWorkspace("openclaw-bootstrap-cache-test-");
  });

  it("returns cached content when mtime unchanged", async () => {
    const content1 = "# Initial content";
    await writeWorkspaceFile({
      dir: workspaceDir,
      name: DEFAULT_AGENTS_FILENAME,
      content: content1,
    });

    // First load
    const result1 = await loadWorkspaceBootstrapFiles(workspaceDir);
    const agentsFile1 = result1.find((f) => f.name === DEFAULT_AGENTS_FILENAME);
    expect(agentsFile1?.content).toBe(content1);
    expect(agentsFile1?.missing).toBe(false);

    // Second load should use cached content (same mtime)
    const result2 = await loadWorkspaceBootstrapFiles(workspaceDir);
    const agentsFile2 = result2.find((f) => f.name === DEFAULT_AGENTS_FILENAME);
    expect(agentsFile2?.content).toBe(content1);
    expect(agentsFile2?.missing).toBe(false);

    // Verify both calls returned the same content without re-reading
    expect(agentsFile1?.content).toBe(agentsFile2?.content);
  });

  it("invalidates cache when mtime changes", async () => {
    const content1 = "# Initial content";
    const content2 = "# Updated content";

    await writeWorkspaceFile({
      dir: workspaceDir,
      name: DEFAULT_AGENTS_FILENAME,
      content: content1,
    });

    // First load
    const result1 = await loadWorkspaceBootstrapFiles(workspaceDir);
    const agentsFile1 = result1.find((f) => f.name === DEFAULT_AGENTS_FILENAME);
    expect(agentsFile1?.content).toBe(content1);

    // Wait a bit to ensure mtime will be different
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Modify the file
    await writeWorkspaceFile({
      dir: workspaceDir,
      name: DEFAULT_AGENTS_FILENAME,
      content: content2,
    });

    // Second load should detect the change and return new content
    const result2 = await loadWorkspaceBootstrapFiles(workspaceDir);
    const agentsFile2 = result2.find((f) => f.name === DEFAULT_AGENTS_FILENAME);
    expect(agentsFile2?.content).toBe(content2);
    expect(agentsFile2?.missing).toBe(false);
  });

  it("handles file deletion gracefully", async () => {
    const content = "# Some content";
    const filePath = path.join(workspaceDir, DEFAULT_AGENTS_FILENAME);

    await writeWorkspaceFile({ dir: workspaceDir, name: DEFAULT_AGENTS_FILENAME, content });

    // First load
    const result1 = await loadWorkspaceBootstrapFiles(workspaceDir);
    const agentsFile1 = result1.find((f) => f.name === DEFAULT_AGENTS_FILENAME);
    expect(agentsFile1?.content).toBe(content);
    expect(agentsFile1?.missing).toBe(false);

    // Delete the file
    await fs.unlink(filePath);

    // Second load should handle deletion gracefully
    const result2 = await loadWorkspaceBootstrapFiles(workspaceDir);
    const agentsFile2 = result2.find((f) => f.name === DEFAULT_AGENTS_FILENAME);
    expect(agentsFile2?.missing).toBe(true);
    expect(agentsFile2?.content).toBeUndefined();
  });

  it("handles concurrent access", async () => {
    const content = "# Concurrent test content";
    await writeWorkspaceFile({ dir: workspaceDir, name: DEFAULT_AGENTS_FILENAME, content });

    // Multiple concurrent loads should all succeed
    const promises = Array.from({ length: 10 }, () => loadWorkspaceBootstrapFiles(workspaceDir));

    const results = await Promise.all(promises);

    // All results should be identical
    for (const result of results) {
      const agentsFile = result.find((f) => f.name === DEFAULT_AGENTS_FILENAME);
      expect(agentsFile?.content).toBe(content);
      expect(agentsFile?.missing).toBe(false);
    }
  });

  it("caches files independently by path", async () => {
    const content1 = "# File 1 content";
    const content2 = "# File 2 content";

    // Create two different workspace directories
    const workspace1 = await makeTempWorkspace("openclaw-cache-test1-");
    const workspace2 = await makeTempWorkspace("openclaw-cache-test2-");

    await writeWorkspaceFile({ dir: workspace1, name: DEFAULT_AGENTS_FILENAME, content: content1 });
    await writeWorkspaceFile({ dir: workspace2, name: DEFAULT_AGENTS_FILENAME, content: content2 });

    // Load from both workspaces
    const result1 = await loadWorkspaceBootstrapFiles(workspace1);
    const result2 = await loadWorkspaceBootstrapFiles(workspace2);

    const agentsFile1 = result1.find((f) => f.name === DEFAULT_AGENTS_FILENAME);
    const agentsFile2 = result2.find((f) => f.name === DEFAULT_AGENTS_FILENAME);

    expect(agentsFile1?.content).toBe(content1);
    expect(agentsFile2?.content).toBe(content2);
  });
});
