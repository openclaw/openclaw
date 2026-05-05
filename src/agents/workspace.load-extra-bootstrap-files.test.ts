import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildBootstrapContextFiles } from "./pi-embedded-helpers.js";
import { loadExtraBootstrapFiles, loadExtraBootstrapFilesWithDiagnostics } from "./workspace.js";

describe("loadExtraBootstrapFiles", () => {
  let fixtureRoot = "";
  let fixtureCount = 0;

  const createWorkspaceDir = async (prefix: string) => {
    const dir = path.join(fixtureRoot, `${prefix}-${fixtureCount++}`);
    await fs.mkdir(dir, { recursive: true });
    return dir;
  };

  beforeAll(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-extra-bootstrap-"));
  });

  afterAll(async () => {
    if (fixtureRoot) {
      await fs.rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("loads recognized bootstrap files from glob patterns", async () => {
    const workspaceDir = await createWorkspaceDir("glob");
    const packageDir = path.join(workspaceDir, "packages", "core");
    await fs.mkdir(packageDir, { recursive: true });
    await fs.writeFile(path.join(packageDir, "TOOLS.md"), "tools", "utf-8");
    await fs.writeFile(path.join(packageDir, "README.md"), "not bootstrap", "utf-8");

    const files = await loadExtraBootstrapFiles(workspaceDir, ["packages/*/*"]);

    expect(files).toHaveLength(1);
    expect(files[0]?.name).toBe("TOOLS.md");
    expect(files[0]?.content).toBe("tools");
  });

  it("preserves Node glob character class matching for extra file patterns", async () => {
    const workspaceDir = await createWorkspaceDir("glob-classes");
    const docsDir = path.join(workspaceDir, "docs");
    await fs.mkdir(path.join(docsDir, "a"), { recursive: true });
    await fs.mkdir(path.join(docsDir, "b"), { recursive: true });
    await fs.mkdir(path.join(docsDir, "c"), { recursive: true });
    await fs.writeFile(path.join(docsDir, "a", "TOOLS.md"), "a", "utf-8");
    await fs.writeFile(path.join(docsDir, "b", "TOOLS.md"), "b", "utf-8");
    await fs.writeFile(path.join(docsDir, "c", "TOOLS.md"), "c", "utf-8");

    const files = await loadExtraBootstrapFiles(workspaceDir, ["docs/[ab]/TOOLS.md"]);

    expect(files.map((file) => path.relative(workspaceDir, file.path))).toEqual([
      path.join("docs", "a", "TOOLS.md"),
      path.join("docs", "b", "TOOLS.md"),
    ]);
    expect(files.map((file) => file.content)).toEqual(["a", "b"]);
  });

  it("preserves configured literal path order before loading", async () => {
    const workspaceDir = await createWorkspaceDir("literal-order");
    const notesDir = path.join(workspaceDir, "notes");
    await fs.mkdir(notesDir, { recursive: true });
    await fs.writeFile(path.join(notesDir, "TOOLS.md"), "tools", "utf-8");
    await fs.writeFile(path.join(notesDir, "AGENTS.md"), "agents", "utf-8");

    const files = await loadExtraBootstrapFiles(workspaceDir, [
      "notes/TOOLS.md",
      "notes/AGENTS.md",
    ]);

    expect(files.map((file) => path.relative(workspaceDir, file.path))).toEqual([
      path.join("notes", "TOOLS.md"),
      path.join("notes", "AGENTS.md"),
    ]);
    expect(files.map((file) => file.content)).toEqual(["tools", "agents"]);
  });

  it("keeps path-traversal attempts outside workspace excluded", async () => {
    const rootDir = await createWorkspaceDir("root");
    const workspaceDir = path.join(rootDir, "workspace");
    const outsideDir = path.join(rootDir, "outside");
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.mkdir(outsideDir, { recursive: true });
    await fs.writeFile(path.join(outsideDir, "AGENTS.md"), "outside", "utf-8");

    const files = await loadExtraBootstrapFiles(workspaceDir, ["../outside/AGENTS.md"]);

    expect(files).toHaveLength(0);
  });

  it("reports missing recognized files without adding placeholders", async () => {
    const workspaceDir = await createWorkspaceDir("missing");

    const { files, diagnostics } = await loadExtraBootstrapFilesWithDiagnostics(workspaceDir, [
      "docs/TOOLS.md",
    ]);

    expect(files).toHaveLength(0);
    expect(diagnostics).toEqual([
      expect.objectContaining({
        path: path.join(workspaceDir, "docs", "TOOLS.md"),
        reason: "missing",
      }),
    ]);
  });

  it("allows arbitrary basenames only when explicitly requested", async () => {
    const workspaceDir = await createWorkspaceDir("arbitrary");
    await fs.writeFile(path.join(workspaceDir, "PROJECT.md"), "project", "utf-8");

    const defaultResult = await loadExtraBootstrapFilesWithDiagnostics(workspaceDir, [
      "PROJECT.md",
    ]);
    const arbitraryResult = await loadExtraBootstrapFilesWithDiagnostics(
      workspaceDir,
      ["PROJECT.md"],
      { allowArbitraryBasenames: true },
    );

    expect(defaultResult.files).toHaveLength(0);
    expect(defaultResult.diagnostics).toEqual([
      expect.objectContaining({ reason: "invalid-bootstrap-filename" }),
    ]);
    expect(arbitraryResult.files.map((file) => file.content)).toEqual(["project"]);
    expect(arbitraryResult.diagnostics).toHaveLength(0);
  });

  it("supports symlinked workspace roots with realpath checks", async () => {
    if (process.platform === "win32") {
      return;
    }

    const rootDir = await createWorkspaceDir("symlink");
    const realWorkspace = path.join(rootDir, "real-workspace");
    const linkedWorkspace = path.join(rootDir, "linked-workspace");
    await fs.mkdir(realWorkspace, { recursive: true });
    await fs.writeFile(path.join(realWorkspace, "AGENTS.md"), "linked agents", "utf-8");
    await fs.symlink(realWorkspace, linkedWorkspace, "dir");

    const files = await loadExtraBootstrapFiles(linkedWorkspace, ["AGENTS.md"]);

    expect(files).toHaveLength(1);
    expect(files[0]?.name).toBe("AGENTS.md");
    expect(files[0]?.content).toBe("linked agents");
  });

  it("rejects hardlinked aliases to files outside workspace", async () => {
    if (process.platform === "win32") {
      return;
    }

    const rootDir = await createWorkspaceDir("hardlink");
    const workspaceDir = path.join(rootDir, "workspace");
    const outsideDir = path.join(rootDir, "outside");
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.mkdir(outsideDir, { recursive: true });
    const outsideFile = path.join(outsideDir, "AGENTS.md");
    const linkedFile = path.join(workspaceDir, "AGENTS.md");
    await fs.writeFile(outsideFile, "outside", "utf-8");
    try {
      await fs.link(outsideFile, linkedFile);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EXDEV") {
        return;
      }
      throw err;
    }

    const files = await loadExtraBootstrapFiles(workspaceDir, ["AGENTS.md"]);
    expect(files).toHaveLength(0);
  });

  it("skips oversized bootstrap files and reports diagnostics", async () => {
    const workspaceDir = await createWorkspaceDir("oversized");
    const payload = "x".repeat(2 * 1024 * 1024 + 1);
    await fs.writeFile(path.join(workspaceDir, "AGENTS.md"), payload, "utf-8");

    const { files, diagnostics } = await loadExtraBootstrapFilesWithDiagnostics(workspaceDir, [
      "AGENTS.md",
    ]);

    expect(files).toHaveLength(0);
    expect(diagnostics.some((d) => d.reason === "security")).toBe(true);
  });

  it("passes arbitrary extra files through existing per-file and total bootstrap budgets", async () => {
    const workspaceDir = await createWorkspaceDir("budget");
    await fs.writeFile(path.join(workspaceDir, "BOOTSTRAP-EUROTRIP.md"), "a".repeat(200), "utf-8");
    await fs.writeFile(path.join(workspaceDir, "PROJECT.md"), "b".repeat(200), "utf-8");
    const { files } = await loadExtraBootstrapFilesWithDiagnostics(
      workspaceDir,
      ["BOOTSTRAP-EUROTRIP.md", "PROJECT.md"],
      { allowArbitraryBasenames: true },
    );
    const warnings: string[] = [];

    const embedded = buildBootstrapContextFiles(files, {
      maxChars: 80,
      totalMaxChars: 120,
      warn: (message) => warnings.push(message),
    });

    expect(embedded.reduce((sum, entry) => sum + entry.content.length, 0)).toBeLessThanOrEqual(120);
    expect(embedded[0]?.content.length).toBeLessThanOrEqual(80);
    expect(embedded[0]?.content).toContain("truncated");
    expect(warnings.some((warning) => warning.includes("BOOTSTRAP-EUROTRIP.md"))).toBe(true);
  });
});
