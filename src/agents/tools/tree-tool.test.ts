import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTreeTool } from "./tree-tool.js";

// Helper to parse the JSON result from tool execution
function parseResult(result: { content: Array<{ text: string }> }): Record<string, unknown> {
  return JSON.parse(result.content[0].text);
}

describe("tree-tool", () => {
  // ---------------------------------------------------------------------------
  // Metadata
  // ---------------------------------------------------------------------------

  const tool = createTreeTool({ workspaceDir: process.cwd() });

  it("has correct metadata", () => {
    expect(tool.name).toBe("tree");
    expect(tool.label).toBe("Tree");
    expect(tool.description).toContain("directory");
    expect(tool.parameters).toBeDefined();
  });

  // ---------------------------------------------------------------------------
  // Basic functionality — real codebase
  // ---------------------------------------------------------------------------

  it("lists the current directory by default", async () => {
    const result = await tool.execute("test-1", {});
    const parsed = parseResult(result);
    expect(parsed.root).toBe(process.cwd());
    expect(parsed.tree).toBeDefined();
    expect(typeof parsed.tree).toBe("string");
    const stats = parsed.stats as Record<string, number>;
    expect(stats.files).toBeGreaterThan(0);
    expect(stats.directories).toBeGreaterThan(0);
    expect(stats.total).toBe(stats.files + stats.directories + stats.symlinks);
  });

  it("lists a specific subdirectory", async () => {
    const result = await tool.execute("test-2", { path: "src/agents/tools" });
    const parsed = parseResult(result);
    expect(parsed.root).toContain("src/agents/tools");
    const tree = parsed.tree as string;
    // Should contain known files in that directory
    expect(tree).toContain("common.ts");
    expect(tree).toContain("ripgrep-tool.ts");
  });

  it("returns error for non-existent path", async () => {
    const result = await tool.execute("test-3", {
      path: "/nonexistent/path/that/does/not/exist",
    });
    const parsed = parseResult(result);
    expect(parsed.error).toBeDefined();
  });

  it("returns error when path is a file, not a directory", async () => {
    const result = await tool.execute("test-4", {
      path: "src/agents/tools/common.ts",
    });
    const parsed = parseResult(result);
    expect(parsed.error).toContain("Not a directory");
  });

  // ---------------------------------------------------------------------------
  // Temp directory-based tests for precise control
  // ---------------------------------------------------------------------------

  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "tree-tool-test-"));
    // Build a test directory structure:
    // tmpDir/
    //   file1.ts
    //   file2.js
    //   .hidden-file
    //   subdir/
    //     nested.ts
    //     deep/
    //       deep-file.txt
    //   .hidden-dir/
    //     secret.txt
    //   empty-dir/

    await fs.writeFile(path.join(tmpDir, "file1.ts"), "console.log('hello');");
    await fs.writeFile(path.join(tmpDir, "file2.js"), "console.log('world');");
    await fs.writeFile(path.join(tmpDir, ".hidden-file"), "secret");

    await fs.mkdir(path.join(tmpDir, "subdir"));
    await fs.writeFile(path.join(tmpDir, "subdir", "nested.ts"), "export {};");
    await fs.mkdir(path.join(tmpDir, "subdir", "deep"));
    await fs.writeFile(path.join(tmpDir, "subdir", "deep", "deep-file.txt"), "deep content");

    await fs.mkdir(path.join(tmpDir, ".hidden-dir"));
    await fs.writeFile(path.join(tmpDir, ".hidden-dir", "secret.txt"), "top secret");

    await fs.mkdir(path.join(tmpDir, "empty-dir"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("hides hidden files by default", async () => {
    const tmpTool = createTreeTool({ workspaceDir: tmpDir });
    const result = await tmpTool.execute("test-5", {});
    const parsed = parseResult(result);
    const tree = parsed.tree as string;
    expect(tree).not.toContain(".hidden-file");
    expect(tree).not.toContain(".hidden-dir");
    expect(tree).toContain("file1.ts");
    expect(tree).toContain("subdir");
  });

  it("shows hidden files when include_hidden is true", async () => {
    const tmpTool = createTreeTool({ workspaceDir: tmpDir });
    const result = await tmpTool.execute("test-6", { include_hidden: true });
    const parsed = parseResult(result);
    const tree = parsed.tree as string;
    expect(tree).toContain(".hidden-file");
    expect(tree).toContain(".hidden-dir");
    expect(tree).toContain("file1.ts");
  });

  it("respects depth limit", async () => {
    const tmpTool = createTreeTool({ workspaceDir: tmpDir });

    // Depth 1: should show subdir but NOT its children
    const result = await tmpTool.execute("test-7", { depth: 1 });
    const parsed = parseResult(result);
    const tree = parsed.tree as string;
    expect(tree).toContain("subdir/");
    expect(tree).not.toContain("nested.ts");
    expect(tree).not.toContain("deep-file.txt");
  });

  it("recurses to full depth by default", async () => {
    const tmpTool = createTreeTool({ workspaceDir: tmpDir });

    const result = await tmpTool.execute("test-8", {});
    const parsed = parseResult(result);
    const tree = parsed.tree as string;
    // Default depth is 3, so deep-file.txt at depth 2 should be visible
    expect(tree).toContain("deep-file.txt");
  });

  it("filters files by glob pattern", async () => {
    const tmpTool = createTreeTool({ workspaceDir: tmpDir });

    const result = await tmpTool.execute("test-9", { glob: "*.ts" });
    const parsed = parseResult(result);
    const tree = parsed.tree as string;
    expect(tree).toContain("file1.ts");
    expect(tree).toContain("nested.ts");
    // .js files should not appear
    expect(tree).not.toContain("file2.js");
    // .txt files should not appear
    expect(tree).not.toContain("deep-file.txt");
    // Directories should still appear (they're not filtered by glob)
    expect(tree).toContain("subdir/");
  });

  it("supports multiple glob patterns via comma", async () => {
    const tmpTool = createTreeTool({ workspaceDir: tmpDir });

    const result = await tmpTool.execute("test-10", { glob: "*.ts,*.txt" });
    const parsed = parseResult(result);
    const tree = parsed.tree as string;
    expect(tree).toContain("file1.ts");
    expect(tree).toContain("deep-file.txt");
    expect(tree).not.toContain("file2.js");
  });

  it("supports brace expansion in globs", async () => {
    const tmpTool = createTreeTool({ workspaceDir: tmpDir });

    const result = await tmpTool.execute("test-brace", { glob: "*.{ts,js}" });
    const parsed = parseResult(result);
    const tree = parsed.tree as string;
    expect(tree).toContain("file1.ts");
    expect(tree).toContain("file2.js");
    expect(tree).not.toContain("deep-file.txt");
  });

  it("includes metadata when requested", async () => {
    const tmpTool = createTreeTool({ workspaceDir: tmpDir });

    const result = await tmpTool.execute("test-11", { include_metadata: true, glob: "*.ts" });
    const parsed = parseResult(result);
    const tree = parsed.tree as string;
    // Size should be shown in parentheses
    expect(tree).toMatch(/\(\d+(\.\d+)?(B|KB|MB|GB)\)/);
  });

  it("directories_only mode", async () => {
    const tmpTool = createTreeTool({ workspaceDir: tmpDir });

    const result = await tmpTool.execute("test-12", { directories_only: true });
    const parsed = parseResult(result);
    const tree = parsed.tree as string;
    expect(tree).toContain("subdir/");
    expect(tree).toContain("empty-dir/");
    expect(tree).not.toContain("file1.ts");
    expect(tree).not.toContain("file2.js");
    const stats = parsed.stats as Record<string, number>;
    expect(stats.files).toBe(0);
  });

  it("files_only mode", async () => {
    const tmpTool = createTreeTool({ workspaceDir: tmpDir });

    const result = await tmpTool.execute("test-13", { files_only: true });
    const parsed = parseResult(result);
    const tree = parsed.tree as string;
    expect(tree).toContain("file1.ts");
    expect(tree).toContain("file2.js");
    expect(tree).toContain("nested.ts");
    // Directories themselves should not appear as entries
    const stats = parsed.stats as Record<string, number>;
    expect(stats.directories).toBe(0);
    expect(stats.files).toBeGreaterThan(0);
  });

  it("rejects both directories_only and files_only", async () => {
    const tmpTool = createTreeTool({ workspaceDir: tmpDir });

    const result = await tmpTool.execute("test-14", {
      directories_only: true,
      files_only: true,
    });
    const parsed = parseResult(result);
    expect(parsed.error).toContain("Cannot use both");
  });

  it("respects max_entries limit", async () => {
    const tmpTool = createTreeTool({ workspaceDir: tmpDir });

    // Set max_entries to 2 — should truncate
    const result = await tmpTool.execute("test-15", { max_entries: 2 });
    const parsed = parseResult(result);
    const stats = parsed.stats as Record<string, number>;
    expect(stats.total).toBeLessThanOrEqual(2);
    expect(parsed.truncated).toBe(true);
    expect(parsed.note).toContain("truncated");
  });

  it("respects .gitignore rules", async () => {
    // Create a .gitignore in tmpDir
    await fs.writeFile(path.join(tmpDir, ".gitignore"), "*.js\nempty-dir/\n");

    const tmpTool = createTreeTool({ workspaceDir: tmpDir });
    const result = await tmpTool.execute("test-16", { include_hidden: true });
    const parsed = parseResult(result);
    const tree = parsed.tree as string;
    // .js files should be ignored
    expect(tree).not.toContain("file2.js");
    // empty-dir should be ignored
    expect(tree).not.toContain("empty-dir");
    // .ts files should still appear
    expect(tree).toContain("file1.ts");
  });

  it("ignores .gitignore when no_ignore is true", async () => {
    // Create a .gitignore that ignores everything
    await fs.writeFile(path.join(tmpDir, ".gitignore"), "*.js\n");

    const tmpTool = createTreeTool({ workspaceDir: tmpDir });
    const result = await tmpTool.execute("test-17", { no_ignore: true });
    const parsed = parseResult(result);
    const tree = parsed.tree as string;
    // .js files should appear when ignoring .gitignore
    expect(tree).toContain("file2.js");
  });

  it("handles depth 0 (root only)", async () => {
    const tmpTool = createTreeTool({ workspaceDir: tmpDir });

    const result = await tmpTool.execute("test-18", { depth: 0 });
    const parsed = parseResult(result);
    const tree = parsed.tree as string;
    // Should show immediate files but not recurse into directories
    expect(tree).toContain("file1.ts");
    // Should not show nested files
    expect(tree).not.toContain("nested.ts");
    expect(tree).not.toContain("deep-file.txt");
  });

  it("handles symlinks gracefully", async () => {
    // Create a symlink
    const symlinkPath = path.join(tmpDir, "link-to-subdir");
    try {
      await fs.symlink(path.join(tmpDir, "subdir"), symlinkPath);
    } catch {
      // Symlinks may not work on all platforms/environments; skip
      return;
    }

    const tmpTool = createTreeTool({ workspaceDir: tmpDir });
    const result = await tmpTool.execute("test-19", {});
    const parsed = parseResult(result);
    const tree = parsed.tree as string;
    expect(tree).toContain("link-to-subdir");
    expect(tree).toContain("→"); // symlink indicator
    const stats = parsed.stats as Record<string, number>;
    expect(stats.symlinks).toBeGreaterThanOrEqual(1);
  });

  it("renders tree with proper visual connectors", async () => {
    const tmpTool = createTreeTool({ workspaceDir: tmpDir });
    const result = await tmpTool.execute("test-20", { depth: 1 });
    const parsed = parseResult(result);
    const tree = parsed.tree as string;
    // Should contain tree connectors
    expect(tree).toMatch(/[├└]── /);
  });

  it("clamps depth to hard max", async () => {
    const tmpTool = createTreeTool({ workspaceDir: tmpDir });
    // Request absurdly deep depth — should be clamped to HARD_MAX_DEPTH (10)
    const result = await tmpTool.execute("test-21", { depth: 999 });
    const parsed = parseResult(result);
    // Should still work without error
    expect(parsed.error).toBeUndefined();
    expect(parsed.tree).toBeDefined();
  });

  it("tree text starts with root directory name", async () => {
    const tmpTool = createTreeTool({ workspaceDir: tmpDir });
    const result = await tmpTool.execute("test-22", {});
    const parsed = parseResult(result);
    const tree = parsed.tree as string;
    const rootName = path.basename(tmpDir);
    expect(tree.startsWith(`${rootName}/`)).toBe(true);
  });
});
