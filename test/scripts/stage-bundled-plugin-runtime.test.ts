import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stageBundledPluginRuntime } from "../../scripts/stage-bundled-plugin-runtime.mjs";

async function withTempDir(run: (dir: string) => Promise<void>) {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "openclaw-stage-runtime-"));
  try {
    await run(dir);
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
}

describe("stageBundledPluginRuntime", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("copies SKILL.md into dist-runtime while leaving other skill assets linked", async () => {
    await withTempDir(async (repoRoot) => {
      const skillDir = path.join(repoRoot, "dist", "extensions", "acpx", "skills", "acp-router");
      const skillFile = path.join(skillDir, "SKILL.md");
      const assetFile = path.join(skillDir, "notes.txt");
      await fs.promises.mkdir(skillDir, { recursive: true });
      await fs.promises.writeFile(skillFile, "skill-body\n", "utf8");
      await fs.promises.writeFile(assetFile, "notes\n", "utf8");

      stageBundledPluginRuntime({ repoRoot });

      const runtimeSkillFile = path.join(
        repoRoot,
        "dist-runtime",
        "extensions",
        "acpx",
        "skills",
        "acp-router",
        "SKILL.md",
      );
      const runtimeAssetFile = path.join(
        repoRoot,
        "dist-runtime",
        "extensions",
        "acpx",
        "skills",
        "acp-router",
        "notes.txt",
      );
      expect(await fs.promises.readFile(runtimeSkillFile, "utf8")).toBe("skill-body\n");
      expect(fs.lstatSync(runtimeSkillFile).isSymbolicLink()).toBe(false);
      expect(fs.lstatSync(runtimeAssetFile).isSymbolicLink()).toBe(true);
    });
  });

  it("copies files when Windows rejects runtime overlay symlinks", async () => {
    await withTempDir(async (repoRoot) => {
      const skillFile = path.join(
        repoRoot,
        "dist",
        "extensions",
        "acpx",
        "skills",
        "acp-router",
        "SKILL.md",
      );
      const sourceFile = path.join(path.dirname(skillFile), "notes.txt");
      await fs.promises.mkdir(path.dirname(skillFile), { recursive: true });
      await fs.promises.writeFile(skillFile, "skill-body\n", "utf8");
      await fs.promises.writeFile(sourceFile, "notes\n", "utf8");

      vi.spyOn(process, "platform", "get").mockReturnValue("win32");
      const symlinkSpy = vi
        .spyOn(fs, "symlinkSync")
        .mockImplementation((target, targetPath, type) => {
          if (
            String(targetPath).includes(`${path.sep}dist-runtime${path.sep}`) &&
            type !== "junction"
          ) {
            const error = new Error("no symlink privilege");
            Object.assign(error, { code: "EPERM" });
            throw error;
          }
          return undefined;
        });

      stageBundledPluginRuntime({ repoRoot });

      const runtimeFile = path.join(
        repoRoot,
        "dist-runtime",
        "extensions",
        "acpx",
        "skills",
        "acp-router",
        "notes.txt",
      );
      expect(await fs.promises.readFile(runtimeFile, "utf8")).toBe("notes\n");
      expect(fs.lstatSync(runtimeFile).isSymbolicLink()).toBe(false);
      expect(symlinkSpy).toHaveBeenCalled();
    });
  });
});
