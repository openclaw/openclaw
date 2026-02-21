import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveExistingPathsWithinRoot } from "./paths.js";

async function createFixtureRoot(): Promise<{ baseDir: string; uploadsDir: string }> {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-browser-paths-"));
  const uploadsDir = path.join(baseDir, "uploads");
  await fs.mkdir(uploadsDir, { recursive: true });
  return { baseDir, uploadsDir };
}

async function withFixtureRoot<T>(
  run: (ctx: { baseDir: string; uploadsDir: string }) => Promise<T>,
): Promise<T> {
  const fixture = await createFixtureRoot();
  try {
    return await run(fixture);
  } finally {
    await fs.rm(fixture.baseDir, { recursive: true, force: true });
  }
}

describe("resolveExistingPathsWithinRoot", () => {
  it("accepts existing files under the upload root", async () => {
    await withFixtureRoot(async ({ uploadsDir }) => {
      const nestedDir = path.join(uploadsDir, "nested");
      await fs.mkdir(nestedDir, { recursive: true });
      const filePath = path.join(nestedDir, "ok.txt");
      await fs.writeFile(filePath, "ok", "utf8");

      const result = await resolveExistingPathsWithinRoot({
        rootDir: uploadsDir,
        requestedPaths: [filePath],
        scopeLabel: "uploads directory",
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.paths).toEqual([await fs.realpath(filePath)]);
      }
    });
  });

  it("rejects traversal outside the upload root", async () => {
    await withFixtureRoot(async ({ baseDir, uploadsDir }) => {
      const outsidePath = path.join(baseDir, "outside.txt");
      await fs.writeFile(outsidePath, "nope", "utf8");

      const result = await resolveExistingPathsWithinRoot({
        rootDir: uploadsDir,
        requestedPaths: ["../outside.txt"],
        scopeLabel: "uploads directory",
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("must stay within uploads directory");
      }
    });
  });

  it("keeps lexical in-root paths when files do not exist yet", async () => {
    await withFixtureRoot(async ({ uploadsDir }) => {
      const result = await resolveExistingPathsWithinRoot({
        rootDir: uploadsDir,
        requestedPaths: ["missing.txt"],
        scopeLabel: "uploads directory",
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.paths).toEqual([path.join(uploadsDir, "missing.txt")]);
      }
    });
  });

  it("rejects directory paths inside upload root", async () => {
    await withFixtureRoot(async ({ uploadsDir }) => {
      const nestedDir = path.join(uploadsDir, "nested");
      await fs.mkdir(nestedDir, { recursive: true });

      const result = await resolveExistingPathsWithinRoot({
        rootDir: uploadsDir,
        requestedPaths: ["nested"],
        scopeLabel: "uploads directory",
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("regular non-symlink file");
      }
    });
  });

  it.runIf(process.platform !== "win32")(
    "rejects symlink escapes outside upload root",
    async () => {
      await withFixtureRoot(async ({ baseDir, uploadsDir }) => {
        const outsidePath = path.join(baseDir, "secret.txt");
        await fs.writeFile(outsidePath, "secret", "utf8");
        const symlinkPath = path.join(uploadsDir, "leak.txt");
        await fs.symlink(outsidePath, symlinkPath);

        const result = await resolveExistingPathsWithinRoot({
          rootDir: uploadsDir,
          requestedPaths: ["leak.txt"],
          scopeLabel: "uploads directory",
        });

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toContain("regular non-symlink file");
        }
      });
    },
  );
});
