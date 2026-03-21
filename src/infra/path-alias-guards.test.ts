import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTempDir } from "../test-helpers/temp-dir.js";
import { assertNoPathAliasEscape } from "./path-alias-guards.js";

describe("assertNoPathAliasEscape", () => {
  it.runIf(process.platform !== "win32")(
    "rejects broken final symlink targets outside root",
    async () => {
      await withTempDir(
        { prefix: "openclaw-path-alias-", parentDir: process.cwd(), subdir: "root" },
        async (root) => {
          const outside = path.join(path.dirname(root), "outside");
          await fs.mkdir(outside, { recursive: true });
          const linkPath = path.join(root, "jump");
          await fs.symlink(path.join(outside, "owned.txt"), linkPath);

          await expect(
            assertNoPathAliasEscape({
              absolutePath: linkPath,
              rootPath: root,
              boundaryLabel: "sandbox root",
            }),
          ).rejects.toThrow(/Symlink escapes sandbox root/);
        },
      );
    },
  );

  it.runIf(process.platform !== "win32")(
    "allows broken final symlink targets that remain inside root",
    async () => {
      await withTempDir(
        { prefix: "openclaw-path-alias-", parentDir: process.cwd(), subdir: "root" },
        async (root) => {
          const linkPath = path.join(root, "jump");
          await fs.symlink(path.join(root, "missing", "owned.txt"), linkPath);

          await expect(
            assertNoPathAliasEscape({
              absolutePath: linkPath,
              rootPath: root,
              boundaryLabel: "sandbox root",
            }),
          ).resolves.toBeUndefined();
        },
      );
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects broken targets that traverse via an in-root symlink alias",
    async () => {
      await withTempDir(
        { prefix: "openclaw-path-alias-", parentDir: process.cwd(), subdir: "root" },
        async (root) => {
          const outside = path.join(path.dirname(root), "outside");
          await fs.mkdir(outside, { recursive: true });
          await fs.symlink(outside, path.join(root, "hop"));
          const linkPath = path.join(root, "jump");
          await fs.symlink(path.join("hop", "missing", "owned.txt"), linkPath);

          await expect(
            assertNoPathAliasEscape({
              absolutePath: linkPath,
              rootPath: root,
              boundaryLabel: "sandbox root",
            }),
          ).rejects.toThrow(/Symlink escapes sandbox root/);
        },
      );
    },
  );
});
