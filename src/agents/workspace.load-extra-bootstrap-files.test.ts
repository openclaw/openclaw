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

  it("loads arbitrary workspace files from glob patterns in deterministic order", async () => {
    const workspaceDir = await createWorkspaceDir("glob");
    const packageDir = path.join(workspaceDir, "packages", "core");
    await fs.mkdir(packageDir, { recursive: true });
    await fs.writeFile(path.join(packageDir, "TOOLS.md"), "tools", "utf-8");
    await fs.writeFile(path.join(packageDir, "README.md"), "readme", "utf-8");

    const files = await loadExtraBootstrapFiles(workspaceDir, ["packages/*/*"]);

    expect(files.map((file) => file.name)).toEqual(["README.md", "TOOLS.md"]);
    expect(files.map((file) => file.content)).toEqual(["readme", "tools"]);
  });

  it("preserves Node glob character class matching for extra file patterns", async () => {
    const workspaceDir = await createWorkspaceDir("glob-classes");
    const docsDir = path.join(workspaceDir, "docs");
    await fs.mkdir(docsDir, { recursive: true });
    await fs.writeFile(path.join(docsDir, "a.md"), "a", "utf-8");
    await fs.writeFile(path.join(docsDir, "b.md"), "b", "utf-8");
    await fs.writeFile(path.join(docsDir, "c.md"), "c", "utf-8");

    const files = await loadExtraBootstrapFiles(workspaceDir, ["docs/[ab]*.md"]);

    expect(files.map((file) => path.relative(workspaceDir, file.path))).toEqual([
      path.join("docs", "a.md"),
      path.join("docs", "b.md"),
    ]);
    expect(files.map((file) => file.content)).toEqual(["a", "b"]);
  });

  it("sorts literal paths deterministically before loading", async () => {
    const workspaceDir = await createWorkspaceDir("literal-order");
    const notesDir = path.join(workspaceDir, "notes");
    await fs.mkdir(notesDir, { recursive: true });
    await fs.writeFile(path.join(notesDir, "z.md"), "z", "utf-8");
    await fs.writeFile(path.join(notesDir, "a.md"), "a", "utf-8");

    const files = await loadExtraBootstrapFiles(workspaceDir, ["notes/z.md", "notes/a.md"]);

    expect(files.map((file) => path.relative(workspaceDir, file.path))).toEqual([
      path.join("notes", "a.md"),
      path.join("notes", "z.md"),
    ]);
    expect(files.map((file) => file.content)).toEqual(["a", "z"]);
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

  it("reports missing arbitrary files without adding placeholders", async () => {
    const workspaceDir = await createWorkspaceDir("missing");

    const { files, diagnostics } = await loadExtraBootstrapFilesWithDiagnostics(workspaceDir, [
      "docs/PROJECT.md",
    ]);

    expect(files).toHaveLength(0);
    expect(diagnostics).toEqual([
      expect.objectContaining({
        path: path.join(workspaceDir, "docs", "PROJECT.md"),
        reason: "missing",
      }),
    ]);
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
    await fs.writeFile(path.join(workspaceDir, "PROJECT.md"), "a".repeat(200), "utf-8");
    await fs.writeFile(path.join(workspaceDir, "TEAM.md"), "b".repeat(200), "utf-8");
    const files = await loadExtraBootstrapFiles(workspaceDir, ["PROJECT.md", "TEAM.md"]);
    const warnings: string[] = [];

    const embedded = buildBootstrapContextFiles(files, {
      maxChars: 80,
      totalMaxChars: 120,
      warn: (message) => warnings.push(message),
    });

    expect(embedded.reduce((sum, entry) => sum + entry.content.length, 0)).toBeLessThanOrEqual(120);
    expect(embedded[0]?.content.length).toBeLessThanOrEqual(80);
    expect(embedded[0]?.content).toContain("truncated");
    expect(warnings.some((warning) => warning.includes("PROJECT.md"))).toBe(true);
  });
});
