import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveBoundaryPath, resolveBoundaryPathSync } from "./boundary-path.js";
import { isPathInside } from "./path-guards.js";

async function withTempRoot<T>(prefix: string, run: (root: string) => Promise<T>): Promise<T> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    return await run(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

function createSeededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

describe("resolveBoundaryPath", () => {
  it("resolves symlink parents with non-existent leafs inside root", async () => {
    if (process.platform === "win32") {
      return;
    }

    await withTempRoot("openclaw-boundary-path-", async (base) => {
      const root = path.join(base, "workspace");
      const targetDir = path.join(root, "target-dir");
      const linkPath = path.join(root, "alias");
      await fs.mkdir(targetDir, { recursive: true });
      await fs.symlink(targetDir, linkPath);

      const unresolved = path.join(linkPath, "missing.txt");
      const result = await resolveBoundaryPath({
        absolutePath: unresolved,
        rootPath: root,
        boundaryLabel: "sandbox root",
      });

      const targetReal = await fs.realpath(targetDir);
      expect(result.exists).toBe(false);
      expect(result.kind).toBe("missing");
      expect(result.canonicalPath).toBe(path.join(targetReal, "missing.txt"));
      expect(isPathInside(result.rootCanonicalPath, result.canonicalPath)).toBe(true);
    });
  });

  it("blocks dangling symlink leaf escapes outside root", async () => {
    if (process.platform === "win32") {
      return;
    }

    await withTempRoot("openclaw-boundary-path-", async (base) => {
      const root = path.join(base, "workspace");
      const outside = path.join(base, "outside");
      const linkPath = path.join(root, "alias-out");
      await fs.mkdir(root, { recursive: true });
      await fs.mkdir(outside, { recursive: true });
      await fs.symlink(outside, linkPath);
      const dangling = path.join(linkPath, "missing.txt");

      await expect(
        resolveBoundaryPath({
          absolutePath: dangling,
          rootPath: root,
          boundaryLabel: "sandbox root",
        }),
      ).rejects.toThrow(/Symlink escapes sandbox root/i);
      expect(() =>
        resolveBoundaryPathSync({
          absolutePath: dangling,
          rootPath: root,
          boundaryLabel: "sandbox root",
        }),
      ).toThrow(/Symlink escapes sandbox root/i);
    });
  });

  it("allows final symlink only when unlink policy opts in", async () => {
    if (process.platform === "win32") {
      return;
    }

    await withTempRoot("openclaw-boundary-path-", async (base) => {
      const root = path.join(base, "workspace");
      const outside = path.join(base, "outside");
      const outsideFile = path.join(outside, "target.txt");
      const linkPath = path.join(root, "link.txt");
      await fs.mkdir(root, { recursive: true });
      await fs.mkdir(outside, { recursive: true });
      await fs.writeFile(outsideFile, "x", "utf8");
      await fs.symlink(outsideFile, linkPath);

      await expect(
        resolveBoundaryPath({
          absolutePath: linkPath,
          rootPath: root,
          boundaryLabel: "sandbox root",
        }),
      ).rejects.toThrow(/Symlink escapes sandbox root/i);

      const allowed = await resolveBoundaryPath({
        absolutePath: linkPath,
        rootPath: root,
        boundaryLabel: "sandbox root",
        policy: { allowFinalSymlinkForUnlink: true },
      });
      const rootReal = await fs.realpath(root);
      expect(allowed.exists).toBe(true);
      expect(allowed.kind).toBe("symlink");
      expect(allowed.canonicalPath).toBe(path.join(rootReal, "link.txt"));
    });
  });

  it("allows canonical aliases that still resolve inside root", async () => {
    if (process.platform === "win32") {
      return;
    }

    await withTempRoot("openclaw-boundary-path-", async (base) => {
      const root = path.join(base, "workspace");
      const aliasRoot = path.join(base, "workspace-alias");
      const fileName = "plugin.js";
      await fs.mkdir(root, { recursive: true });
      await fs.writeFile(path.join(root, fileName), "export default {}", "utf8");
      await fs.symlink(root, aliasRoot);

      const resolved = await resolveBoundaryPath({
        absolutePath: path.join(aliasRoot, fileName),
        rootPath: await fs.realpath(root),
        boundaryLabel: "plugin root",
      });
      expect(resolved.exists).toBe(true);
      expect(isPathInside(resolved.rootCanonicalPath, resolved.canonicalPath)).toBe(true);

      const resolvedSync = resolveBoundaryPathSync({
        absolutePath: path.join(aliasRoot, fileName),
        rootPath: await fs.realpath(root),
        boundaryLabel: "plugin root",
      });
      expect(resolvedSync.exists).toBe(true);
      expect(isPathInside(resolvedSync.rootCanonicalPath, resolvedSync.canonicalPath)).toBe(true);
    });
  });

  it("maintains containment invariant across randomized alias cases", async () => {
    if (process.platform === "win32") {
      return;
    }

    await withTempRoot("openclaw-boundary-path-fuzz-", async (base) => {
      const root = path.join(base, "workspace");
      const outside = path.join(base, "outside");
      const safeTarget = path.join(root, "safe-target");
      await fs.mkdir(root, { recursive: true });
      await fs.mkdir(outside, { recursive: true });
      await fs.mkdir(safeTarget, { recursive: true });

      const rand = createSeededRandom(0x5eed1234);
      for (let idx = 0; idx < 64; idx += 1) {
        const token = Math.floor(rand() * 1_000_000)
          .toString(16)
          .padStart(5, "0");
        const safeName = `safe-${idx}-${token}`;
        const useLink = rand() > 0.5;
        const safeBase = useLink ? path.join(root, `safe-link-${idx}`) : path.join(root, safeName);
        if (useLink) {
          await fs.symlink(safeTarget, safeBase);
        } else {
          await fs.mkdir(safeBase, { recursive: true });
        }
        const safeCandidate = path.join(safeBase, `new-${token}.txt`);
        const safeResolved = await resolveBoundaryPath({
          absolutePath: safeCandidate,
          rootPath: root,
          boundaryLabel: "sandbox root",
        });
        expect(isPathInside(safeResolved.rootCanonicalPath, safeResolved.canonicalPath)).toBe(true);

        const escapeLink = path.join(root, `escape-${idx}`);
        await fs.symlink(outside, escapeLink);
        const unsafeCandidate = path.join(escapeLink, `new-${token}.txt`);
        await expect(
          resolveBoundaryPath({
            absolutePath: unsafeCandidate,
            rootPath: root,
            boundaryLabel: "sandbox root",
          }),
        ).rejects.toThrow(/Symlink escapes sandbox root/i);
      }
    });
  });
});
