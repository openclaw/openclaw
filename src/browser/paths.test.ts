import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  resolveExistingPathsWithinRoot,
  resolvePathsWithinRoot,
  resolvePathWithinRoot,
} from "./paths.js";

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
  function expectInvalidResult(
    result: Awaited<ReturnType<typeof resolveExistingPathsWithinRoot>>,
    expectedSnippet: string,
  ) {
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain(expectedSnippet);
    }
  }

  function resolveWithinUploads(params: {
    uploadsDir: string;
    requestedPaths: string[];
  }): Promise<Awaited<ReturnType<typeof resolveExistingPathsWithinRoot>>> {
    return resolveExistingPathsWithinRoot({
      rootDir: params.uploadsDir,
      requestedPaths: params.requestedPaths,
      scopeLabel: "uploads directory",
    });
  }

  it("accepts existing files under the upload root", async () => {
    await withFixtureRoot(async ({ uploadsDir }) => {
      const nestedDir = path.join(uploadsDir, "nested");
      await fs.mkdir(nestedDir, { recursive: true });
      const filePath = path.join(nestedDir, "ok.txt");
      await fs.writeFile(filePath, "ok", "utf8");

      const result = await resolveWithinUploads({
        uploadsDir,
        requestedPaths: [filePath],
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

      const result = await resolveWithinUploads({
        uploadsDir,
        requestedPaths: ["../outside.txt"],
      });

      expectInvalidResult(result, "must stay within uploads directory");
    });
  });

  it("rejects blank paths", async () => {
    await withFixtureRoot(async ({ uploadsDir }) => {
      const result = await resolveWithinUploads({
        uploadsDir,
        requestedPaths: ["  "],
      });

      expectInvalidResult(result, "path is required");
    });
  });

  it("keeps lexical in-root paths when files do not exist yet", async () => {
    await withFixtureRoot(async ({ uploadsDir }) => {
      const result = await resolveWithinUploads({
        uploadsDir,
        requestedPaths: ["missing.txt"],
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

      const result = await resolveWithinUploads({
        uploadsDir,
        requestedPaths: ["nested"],
      });

      expectInvalidResult(result, "regular non-symlink file");
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

        const result = await resolveWithinUploads({
          uploadsDir,
          requestedPaths: ["leak.txt"],
        });

        expectInvalidResult(result, "regular non-symlink file");
      });
    },
  );

  it.runIf(process.platform !== "win32")(
    "accepts canonical absolute paths when upload root is a symlink alias",
    async () => {
      await withFixtureRoot(async ({ baseDir }) => {
        const canonicalUploadsDir = path.join(baseDir, "canonical", "uploads");
        const aliasedUploadsDir = path.join(baseDir, "uploads-link");
        await fs.mkdir(canonicalUploadsDir, { recursive: true });
        await fs.symlink(canonicalUploadsDir, aliasedUploadsDir);

        const filePath = path.join(canonicalUploadsDir, "ok.txt");
        await fs.writeFile(filePath, "ok", "utf8");
        const canonicalPath = await fs.realpath(filePath);

        const firstPass = await resolveWithinUploads({
          uploadsDir: aliasedUploadsDir,
          requestedPaths: [path.join(aliasedUploadsDir, "ok.txt")],
        });
        expect(firstPass.ok).toBe(true);

        const secondPass = await resolveWithinUploads({
          uploadsDir: aliasedUploadsDir,
          requestedPaths: [canonicalPath],
        });
        expect(secondPass.ok).toBe(true);
        if (secondPass.ok) {
          expect(secondPass.paths).toEqual([canonicalPath]);
        }
      });
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects canonical absolute paths outside symlinked upload root",
    async () => {
      await withFixtureRoot(async ({ baseDir }) => {
        const canonicalUploadsDir = path.join(baseDir, "canonical", "uploads");
        const aliasedUploadsDir = path.join(baseDir, "uploads-link");
        await fs.mkdir(canonicalUploadsDir, { recursive: true });
        await fs.symlink(canonicalUploadsDir, aliasedUploadsDir);

        const outsideDir = path.join(baseDir, "outside");
        await fs.mkdir(outsideDir, { recursive: true });
        const outsideFile = path.join(outsideDir, "secret.txt");
        await fs.writeFile(outsideFile, "secret", "utf8");

        const result = await resolveWithinUploads({
          uploadsDir: aliasedUploadsDir,
          requestedPaths: [await fs.realpath(outsideFile)],
        });
        expectInvalidResult(result, "must stay within uploads directory");
      });
    },
  );
});

describe("resolvePathWithinRoot", () => {
  it("uses default file name when requested path is blank", () => {
    const result = resolvePathWithinRoot({
      rootDir: "/tmp/uploads",
      requestedPath: " ",
      scopeLabel: "uploads directory",
      defaultFileName: "fallback.txt",
    });
    expect(result).toEqual({
      ok: true,
      path: path.resolve("/tmp/uploads", "fallback.txt"),
    });
  });

  it("rejects root-level path aliases that do not point to a file", () => {
    const result = resolvePathWithinRoot({
      rootDir: "/tmp/uploads",
      requestedPath: ".",
      scopeLabel: "uploads directory",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("must stay within uploads directory");
    }
  });
});

describe("resolvePathsWithinRoot", () => {
  it("resolves all valid in-root paths", () => {
    const result = resolvePathsWithinRoot({
      rootDir: "/tmp/uploads",
      requestedPaths: ["a.txt", "nested/b.txt"],
      scopeLabel: "uploads directory",
    });
    expect(result).toEqual({
      ok: true,
      paths: [path.resolve("/tmp/uploads", "a.txt"), path.resolve("/tmp/uploads", "nested/b.txt")],
    });
  });

  it("returns the first path validation error", () => {
    const result = resolvePathsWithinRoot({
      rootDir: "/tmp/uploads",
      requestedPaths: ["a.txt", "../outside.txt", "b.txt"],
      scopeLabel: "uploads directory",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("must stay within uploads directory");
    }
  });
});
