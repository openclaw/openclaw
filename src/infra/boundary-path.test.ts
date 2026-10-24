import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { withTestDir } from "../test-helpers/temp-dir.js";
import {
  resolveIdentityPathViaExistingAncestorSync,
  resolveRealpathOrAbsolute,
  resolveRootPath,
  resolveRootPathSync,
} from "./boundary-path.js";
import { isPathInside } from "./path-guards.js";

afterEach(() => vi.restoreAllMocks());

function withBoundaryDir(
  run: (dirs: { base: string; root: string; outside: string }) => Promise<void>,
) {
  return withTestDir({ prefix: "openclaw-boundary-path-" }, async (base) => {
    const root = path.join(base, "workspace");
    const outside = path.join(base, "outside");
    await Promise.all([root, outside].map((dir) => fs.mkdir(dir, { recursive: true })));
    await run({ base, root, outside });
  });
}
function boundaryOptions(rootPath: string, absolutePath: string) {
  return { absolutePath, rootPath, boundaryLabel: "sandbox root" };
}

it("keeps missing paths lexical and falls back on non-missing errors", async () => {
  await withBoundaryDir(async ({ base }) => {
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

it.each([true, false])("resolves ancestor identity with a reachable ancestor: %s", (reachable) => {
  const aliasRoot = path.resolve("identity-alias");
  const targetPath = path.join(aliasRoot, "locked", "leaf");
  const canonicalRoot = path.resolve("identity-real");
  vi.spyOn(fsSync.realpathSync, "native").mockImplementation((candidate) => {
    const resolved = path.resolve(String(candidate));
    if (reachable && resolved === aliasRoot) {
      return canonicalRoot;
    }
    throw new Error("simulated realpath failure");
  });

  expect(resolveIdentityPathViaExistingAncestorSync(targetPath)).toBe(
    reachable ? path.join(canonicalRoot, "locked", "leaf") : targetPath,
  );
});

it.each(["dangling", "file"])("blocks symlink escapes (%s)", async (kind) => {
  if (process.platform === "win32") {
    return;
  }

  await withBoundaryDir(async ({ root, outside }) => {
    const linkPath = path.join(root, "alias-out");
    const outsideFile = path.join(outside, "target.txt");
    if (kind === "file") {
      await fs.writeFile(outsideFile, "x", "utf8");
    }
    await fs.symlink(kind === "file" ? outsideFile : outside, linkPath);
    const options = boundaryOptions(
      root,
      kind === "file" ? linkPath : path.join(linkPath, "missing.txt"),
    );
    await expect(resolveRootPath(options)).rejects.toThrow(/Symlink escapes sandbox root/i);
    if (kind === "dangling") {
      expect(() => resolveRootPathSync(options)).toThrow(/Symlink escapes sandbox root/i);
      return;
    }
    const allowed = await resolveRootPath({
      ...options,
      policy: { allowFinalSymlinkForUnlink: true },
    });
    expect(allowed).toMatchObject({
      exists: true,
      kind: "symlink",
      canonicalPath: path.join(await fs.realpath(root), "alias-out"),
    });
  });
});

it("allows canonical aliases that still resolve inside root", async () => {
  if (process.platform === "win32") {
    return;
  }

  await withBoundaryDir(async ({ base, root }) => {
    const aliasRoot = path.join(base, "workspace-alias");
    const fileName = "plugin.js";
    await fs.writeFile(path.join(root, fileName), "export default {}", "utf8");
    await fs.symlink(root, aliasRoot);

    const options = boundaryOptions(await fs.realpath(root), path.join(aliasRoot, fileName));
    for (const resolved of [await resolveRootPath(options), resolveRootPathSync(options)]) {
      expect(resolved.exists).toBe(true);
      expect(isPathInside(resolved.rootCanonicalPath, resolved.canonicalPath)).toBe(true);
    }
  });
});
