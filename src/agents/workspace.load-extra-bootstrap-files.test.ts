// Extra bootstrap file tests cover glob/literal path loading, workspace
// containment checks, symlink handling, and diagnostics for skipped files.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { loadExtraBootstrapFilesWithDiagnostics } from "./workspace.js";

describe("loadExtraBootstrapFilesWithDiagnostics", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  const createWorkspaceDir = (prefix: string) => tempDirs.make(`openclaw-${prefix}-`);

  async function loadExtraBootstrapFileList(dir: string, extraPatterns: string[]) {
    const { files } = await loadExtraBootstrapFilesWithDiagnostics(dir, extraPatterns);
    return files;
  }

  it("loads recognized bootstrap files from glob patterns", async () => {
    const workspaceDir = createWorkspaceDir("glob");
    const packageDir = path.join(workspaceDir, "packages", "core");
    await fs.mkdir(packageDir, { recursive: true });
    await fs.writeFile(path.join(packageDir, "SOUL.md"), "soul", "utf-8");
    await fs.writeFile(path.join(packageDir, "README.md"), "not bootstrap", "utf-8");

    const files = await loadExtraBootstrapFileList(workspaceDir, ["./packages/*/*"]);

    expect(files).toStrictEqual([
      {
        name: "SOUL.md",
        path: path.join(packageDir, "SOUL.md"),
        content: "soul",
        missing: false,
      },
    ]);
  });

  it("loads literal bootstrap paths with square brackets", async () => {
    const workspaceDir = createWorkspaceDir("literal-brackets");
    const packageDir = path.join(workspaceDir, "pkg[1]");
    await fs.mkdir(packageDir, { recursive: true });
    await fs.writeFile(path.join(packageDir, "AGENTS.md"), "literal agents", "utf-8");

    const files = await loadExtraBootstrapFileList(workspaceDir, ["pkg[1]/AGENTS.md"]);

    expect(files).toStrictEqual([
      {
        name: "AGENTS.md",
        path: path.join(packageDir, "AGENTS.md"),
        content: "literal agents",
        missing: false,
      },
    ]);
  });

  it("keeps path-traversal attempts outside workspace excluded", async () => {
    const rootDir = createWorkspaceDir("root");
    const workspaceDir = path.join(rootDir, "workspace");
    const outsideDir = path.join(rootDir, "outside");
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.mkdir(outsideDir, { recursive: true });
    await fs.writeFile(path.join(outsideDir, "AGENTS.md"), "outside", "utf-8");

    const files = await loadExtraBootstrapFileList(workspaceDir, ["../outside/AGENTS.md"]);

    expect(files).toHaveLength(0);
  });

  it.runIf(process.platform !== "win32")(
    "falls back to a shallow scan without entering unrelated unreadable branches",
    async () => {
      const workspaceDir = createWorkspaceDir("shallow-pattern");
      const privateDir = path.join(workspaceDir, "packages", "blocked", "node_modules", "private");
      const readableDir = path.join(workspaceDir, "packages", "readable");
      await fs.mkdir(privateDir, { recursive: true });
      await fs.mkdir(readableDir, { recursive: true });
      await fs.writeFile(path.join(privateDir, "AGENTS.md"), "irrelevant", "utf-8");
      await fs.writeFile(path.join(readableDir, "AGENTS.md"), "readable", "utf-8");
      await fs.chmod(privateDir, 0o000);
      const glob = vi.spyOn(fs, "glob").mockImplementation(() => {
        throw new Error("native glob failed");
      });
      const readDirectory = vi.spyOn(fs, "readdir");
      try {
        const result = await loadExtraBootstrapFilesWithDiagnostics(workspaceDir, [
          "packages/*/AGENTS.md",
        ]);
        expect(result.diagnostics).toEqual([]);
        expect(result.files).toEqual([
          expect.objectContaining({ path: path.join(readableDir, "AGENTS.md") }),
        ]);
        expect(readDirectory).not.toHaveBeenCalledWith(privateDir, expect.anything());
      } finally {
        readDirectory.mockRestore();
        glob.mockRestore();
        await fs.chmod(privateDir, 0o700);
      }
    },
  );
});
