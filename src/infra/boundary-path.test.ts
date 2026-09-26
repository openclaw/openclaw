// Tests path boundary enforcement for safe file access.
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withTestDir } from "../test-helpers/temp-dir.js";
import {
  resolveIdentityPathViaExistingAncestorSync,
  resolveRealpathOrAbsolute,
  resolveRootPath,
  resolveRootPathSync,
} from "./boundary-path.js";
import { isPathInside } from "./path-guards.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("resolveRealpathOrAbsolute", () => {
  it("canonicalizes existing symlinks", async () => {
    await withTestDir({ prefix: "openclaw-boundary-path-" }, async (base) => {
      const target = path.join(base, "target");
      const alias = path.join(base, "alias");
      await fs.mkdir(target);
      await fs.symlink(target, alias);
      expect(resolveRealpathOrAbsolute(alias)).toBe(await fs.realpath(target));
    });
  });

  it("keeps missing paths lexical and falls back on non-missing errors", async () => {
    await withTestDir({ prefix: "openclaw-boundary-path-" }, async (base) => {
      const alias = path.join(base, "alias");
      await fs.symlink(path.join(base, "target"), alias);
      const missing = path.join(alias, "missing");
      expect(resolveRealpathOrAbsolute(missing)).toBe(path.resolve(missing));
      vi.spyOn(fsSync, "realpathSync").mockImplementation(() => {
        throw Object.assign(new Error("denied"), { code: "EACCES" });
      });
      expect(resolveRealpathOrAbsolute("denied")).toBe(path.resolve("denied"));
    });
  });
});

describe("resolveIdentityPathViaExistingAncestorSync", () => {
  it("continues through native realpath failures to preserve ancestor identity", () => {
    const aliasRoot = path.resolve("identity-alias");
    const targetPath = path.join(aliasRoot, "locked", "leaf");
    const lockedPath = path.dirname(targetPath);
    const canonicalRoot = path.resolve("identity-real");
    const calls: string[] = [];

    vi.spyOn(fsSync.realpathSync, "native").mockImplementation((candidate) => {
      const resolved = path.resolve(String(candidate));
      calls.push(resolved);
      if (resolved === aliasRoot) {
        return canonicalRoot;
      }
      throw new Error("simulated realpath failure");
    });

    expect(resolveIdentityPathViaExistingAncestorSync(targetPath)).toBe(
      path.join(canonicalRoot, "locked", "leaf"),
    );
    expect(calls).toEqual([targetPath, lockedPath, aliasRoot]);
  });

  it("falls back lexically only after native realpath fails through the root", () => {
    const targetPath = path.resolve("identity-alias", "locked", "leaf");
    const calls: string[] = [];
    const expectedCalls: string[] = [];
    let cursor = targetPath;
    while (true) {
      expectedCalls.push(cursor);
      const parent = path.dirname(cursor);
      if (parent === cursor) {
        break;
      }
      cursor = parent;
    }

    vi.spyOn(fsSync.realpathSync, "native").mockImplementation((candidate) => {
      calls.push(path.resolve(String(candidate)));
      throw new Error("simulated realpath failure");
    });

    expect(resolveIdentityPathViaExistingAncestorSync(targetPath)).toBe(targetPath);
    expect(calls).toEqual(expectedCalls);
  });
});

describe("resolveRootPath", () => {
  it("resolves symlink parents with non-existent leafs inside root", async () => {
    if (process.platform === "win32") {
      return;
    }

    await withTestDir({ prefix: "openclaw-boundary-path-" }, async (base) => {
      const root = path.join(base, "workspace");
      const targetDir = path.join(root, "target-dir");
      const linkPath = path.join(root, "alias");
      await fs.mkdir(targetDir, { recursive: true });
      await fs.symlink(targetDir, linkPath);

      const unresolved = path.join(linkPath, "missing.txt");
      const result = await resolveRootPath({
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

    await withTestDir({ prefix: "openclaw-boundary-path-" }, async (base) => {
      const root = path.join(base, "workspace");
      const outside = path.join(base, "outside");
      const linkPath = path.join(root, "alias-out");
      await fs.mkdir(root, { recursive: true });
      await fs.mkdir(outside, { recursive: true });
      await fs.symlink(outside, linkPath);
      const dangling = path.join(linkPath, "missing.txt");

      await expect(
        resolveRootPath({
          absolutePath: dangling,
          rootPath: root,
          boundaryLabel: "sandbox root",
        }),
      ).rejects.toThrow(/Symlink escapes sandbox root/i);
      expect(() =>
        resolveRootPathSync({
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

    await withTestDir({ prefix: "openclaw-boundary-path-" }, async (base) => {
      const root = path.join(base, "workspace");
      const outside = path.join(base, "outside");
      const outsideFile = path.join(outside, "target.txt");
      const linkPath = path.join(root, "link.txt");
      await fs.mkdir(root, { recursive: true });
      await fs.mkdir(outside, { recursive: true });
      await fs.writeFile(outsideFile, "x", "utf8");
      await fs.symlink(outsideFile, linkPath);

      await expect(
        resolveRootPath({
          absolutePath: linkPath,
          rootPath: root,
          boundaryLabel: "sandbox root",
        }),
      ).rejects.toThrow(/Symlink escapes sandbox root/i);

      const allowed = await resolveRootPath({
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

    await withTestDir({ prefix: "openclaw-boundary-path-" }, async (base) => {
      const root = path.join(base, "workspace");
      const aliasRoot = path.join(base, "workspace-alias");
      const fileName = "plugin.js";
      await fs.mkdir(root, { recursive: true });
      await fs.writeFile(path.join(root, fileName), "export default {}", "utf8");
      await fs.symlink(root, aliasRoot);

      const resolved = await resolveRootPath({
        absolutePath: path.join(aliasRoot, fileName),
        rootPath: await fs.realpath(root),
        boundaryLabel: "plugin root",
      });
      expect(resolved.exists).toBe(true);
      expect(isPathInside(resolved.rootCanonicalPath, resolved.canonicalPath)).toBe(true);

      const resolvedSync = resolveRootPathSync({
        absolutePath: path.join(aliasRoot, fileName),
        rootPath: await fs.realpath(root),
        boundaryLabel: "plugin root",
      });
      expect(resolvedSync.exists).toBe(true);
      expect(isPathInside(resolvedSync.rootCanonicalPath, resolvedSync.canonicalPath)).toBe(true);
    });
  });
});
