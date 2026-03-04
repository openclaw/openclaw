import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveBoundaryPath } from "./boundary-path.js";

async function withTempRoot<T>(prefix: string, run: (root: string) => Promise<T>): Promise<T> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    return await run(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

describe("resolveBoundaryPath - workspace symlinks", () => {
  it("allows symlinks to sibling workspace under common .openclaw parent", async () => {
    if (process.platform === "win32") {
      return;
    }

    await withTempRoot("openclaw-workspace-symlink-", async (base) => {
      // Simulate ~/.openclaw/ structure
      const openclawDir = path.join(base, ".openclaw");
      const workspace1 = path.join(openclawDir, "workspace");
      const workspace2 = path.join(openclawDir, "workspace-llama");

      await fs.mkdir(workspace1, { recursive: true });
      await fs.mkdir(workspace2, { recursive: true });

      // Create a bootstrap file in workspace1
      const agentsFile = path.join(workspace1, "AGENTS.md");
      await fs.writeFile(agentsFile, "# Shared agents config", "utf8");

      // Create symlink in workspace2 pointing to workspace1's file
      const symlinkPath = path.join(workspace2, "AGENTS.md");
      await fs.symlink(agentsFile, symlinkPath);

      // This should succeed because both workspaces are under .openclaw/
      const result = await resolveBoundaryPath({
        absolutePath: symlinkPath,
        rootPath: workspace2,
        boundaryLabel: "workspace root",
      });

      expect(result.exists).toBe(true);
      expect(result.kind).toBe("file");

      // The canonical path should resolve to the actual file
      const agentsFileReal = await fs.realpath(agentsFile);
      expect(result.canonicalPath).toBe(agentsFileReal);
    });
  });

  it("blocks symlinks to non-workspace directories even under .openclaw", async () => {
    if (process.platform === "win32") {
      return;
    }

    await withTempRoot("openclaw-workspace-symlink-", async (base) => {
      // Simulate ~/.openclaw/ structure
      const openclawDir = path.join(base, ".openclaw");
      const workspace = path.join(openclawDir, "workspace");
      const otherDir = path.join(openclawDir, "other-dir");

      await fs.mkdir(workspace, { recursive: true });
      await fs.mkdir(otherDir, { recursive: true });

      // Create a file in the non-workspace directory
      const targetFile = path.join(otherDir, "secret.txt");
      await fs.writeFile(targetFile, "secret data", "utf8");

      // Create symlink in workspace pointing to non-workspace file
      const symlinkPath = path.join(workspace, "secret.txt");
      await fs.symlink(targetFile, symlinkPath);

      // This should fail because the target is not in a workspace directory
      await expect(
        resolveBoundaryPath({
          absolutePath: symlinkPath,
          rootPath: workspace,
          boundaryLabel: "workspace root",
        }),
      ).rejects.toThrow(/Symlink escapes workspace root/i);
    });
  });

  it("blocks symlinks to directories outside .openclaw", async () => {
    if (process.platform === "win32") {
      return;
    }

    await withTempRoot("openclaw-workspace-symlink-", async (base) => {
      const openclawDir = path.join(base, ".openclaw");
      const workspace = path.join(openclawDir, "workspace");
      const outsideDir = path.join(base, "outside");

      await fs.mkdir(workspace, { recursive: true });
      await fs.mkdir(outsideDir, { recursive: true });

      // Create a file outside .openclaw
      const targetFile = path.join(outsideDir, "external.txt");
      await fs.writeFile(targetFile, "external data", "utf8");

      // Create symlink in workspace pointing to external file
      const symlinkPath = path.join(workspace, "external.txt");
      await fs.symlink(targetFile, symlinkPath);

      // This should fail because the target is outside .openclaw
      await expect(
        resolveBoundaryPath({
          absolutePath: symlinkPath,
          rootPath: workspace,
          boundaryLabel: "workspace root",
        }),
      ).rejects.toThrow(/Symlink escapes workspace root/i);
    });
  });
});
