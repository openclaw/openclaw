import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  collectStalePluginRuntimeSymlinkHealthFindings,
  removeStalePluginRuntimeSymlinks,
} from "./plugin-runtime-symlinks.js";

async function expectSymlinkPresent(targetPath: string): Promise<void> {
  expect((await fs.lstat(targetPath)).isSymbolicLink()).toBe(true);
}

async function writePackage(root: string, contents: string): Promise<void> {
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(path.join(root, "package.json"), contents);
}

function readPackage(root: string) {
  return fs.readFile(path.join(root, "package.json"), "utf8");
}

async function canCreateDirectorySymlink(root: string): Promise<boolean> {
  const target = path.join(root, "symlink-capability-target");
  const link = path.join(root, "symlink-capability-link");
  await fs.mkdir(target, { recursive: true });
  try {
    await fs.symlink(target, link, "dir");
    return (await fs.lstat(link)).isSymbolicLink();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "EPERM" || code === "EACCES" || code === "ENOTSUP") {
      return false;
    }
    throw error;
  } finally {
    await fs.rm(link, { recursive: true, force: true });
    await fs.rm(target, { recursive: true, force: true });
  }
}

describe("plugin runtime symlink health findings", () => {
  let tempDir: string;
  let packageRoot: string;

  beforeEach(async () => {
    tempDir = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-plugin-runtime-symlinks-")),
    );
    packageRoot = path.join(tempDir, "prefix", "node_modules", "openclaw");
    await fs.mkdir(packageRoot, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it.runIf(process.platform !== "win32")(
    "preserves POSIX relative runtime links across directory symlinks and ..",
    async () => {
      const runtimeRoot = path.join(tempDir, "shared", "plugin-runtime-deps");
      const physicalRoot = path.join(tempDir, "physical");
      const dependency = path.join(physicalRoot, "dep");
      const link = path.join(path.dirname(packageRoot), "relative-runtime");
      const contents = '{"name":"live-relative-runtime"}\n';
      await fs.mkdir(runtimeRoot, { recursive: true });
      await fs.mkdir(path.join(physicalRoot, "current"), { recursive: true });
      await writePackage(dependency, contents);
      await fs.symlink(
        path.join(physicalRoot, "current"),
        path.join(runtimeRoot, "current"),
        "dir",
      );
      // Keep .. in the stored link: POSIX follows the directory symlink before ascending.
      const target = `${path.relative(path.dirname(link), runtimeRoot)}/current/../dep`;
      await fs.symlink(target, link, "dir");
      expect(await readPackage(link)).toBe(contents);

      const findings = await collectStalePluginRuntimeSymlinkHealthFindings({ packageRoot });
      const repair = await removeStalePluginRuntimeSymlinks(packageRoot);
      expect({ findings, ...repair }).toEqual({ findings: [], changes: [], warnings: [] });
      await expectSymlinkPresent(link);
      expect(await fs.readlink(link)).toBe(target);
      expect(await readPackage(link)).toBe(contents);
    },
  );

  it.each([
    { code: "ENOENT", scope: "@slack", hostOwned: false },
    { code: "ENOTDIR", scope: "@slack", hostOwned: false },
    { code: "ENOENT", scope: "", hostOwned: false },
    { code: "ENOENT", scope: "@slack", hostOwned: true },
  ])(
    "repairs dangling $scope links only outside host-owned payloads ($code, hostOwned=$hostOwned)",
    async ({ code, scope, hostOwned }) => {
      if (!(await canCreateDirectorySymlink(tempDir))) {
        return;
      }
      const legacyRoot = path.join(tempDir, "state", "plugin-runtime-deps");
      const missingTarget = path.join(legacyRoot, "openclaw-slack/node_modules/@slack/web-api");
      const scopeRoot = path.join(path.dirname(packageRoot), scope);
      const packageName = scope ? `${scope}/web-api` : "web-api";
      const staleLink = path.join(scopeRoot, "web-api");
      const liveTarget = path.join(legacyRoot, "openclaw-live", "node_modules", "@slack", "bolt");
      const liveLink = path.join(scopeRoot, "bolt");

      if (hostOwned) {
        await fs.writeFile(
          path.join(packageRoot, "openclaw-install-owner.json"),
          JSON.stringify({
            schemaVersion: 1,
            owner: "macos-app",
            displayName: "OpenClaw.app",
            updateHint: "Update OpenClaw.app to update this Gateway.",
          }),
        );
      }
      await fs.mkdir(scopeRoot, { recursive: true });
      await writePackage(liveTarget, '{"name":"live-runtime"}\n');
      if (code === "ENOTDIR") {
        await fs.writeFile(path.join(legacyRoot, "openclaw-slack"), "not a directory\n");
      }
      await fs.symlink(missingTarget, staleLink, "dir");
      await fs.symlink(liveTarget, liveLink, "dir");
      const packageDirectory = path.join(path.dirname(packageRoot), "ordinary-package");
      const nestedLink = path.join(packageDirectory, "nested-stale-link");
      await fs.mkdir(packageDirectory);
      await fs.symlink(missingTarget, nestedLink, "dir");

      if (hostOwned) {
        expect(await collectStalePluginRuntimeSymlinkHealthFindings({ packageRoot })).toEqual([]);
        expect(await removeStalePluginRuntimeSymlinks(packageRoot)).toEqual({
          changes: [],
          warnings: [],
        });
        await expectSymlinkPresent(staleLink);
        await expectSymlinkPresent(liveLink);
        await expectSymlinkPresent(nestedLink);
        return;
      }

      expect(await collectStalePluginRuntimeSymlinkHealthFindings({ packageRoot })).toEqual([
        {
          checkId: "core/doctor/stale-plugin-runtime-symlinks",
          severity: "warning",
          message: `Stale plugin-runtime symlink ${packageName} points at ${missingTarget}.`,
          path: staleLink,
          target: staleLink,
          requirement: "stale-plugin-runtime-symlink-removed",
          fixHint: "Run `openclaw doctor --fix` to remove stale plugin-runtime symlinks.",
        },
      ]);
      await expectSymlinkPresent(staleLink);
      await expectSymlinkPresent(liveLink);
      expect(await removeStalePluginRuntimeSymlinks(packageRoot)).toEqual({
        changes: [`Removed stale plugin-runtime symlink: ${staleLink}`],
        warnings: [],
      });
      await expect(fs.lstat(staleLink)).rejects.toMatchObject({ code: "ENOENT" });
      await expectSymlinkPresent(liveLink);
      await expectSymlinkPresent(nestedLink);
      expect(await readPackage(liveLink)).toBe('{"name":"live-runtime"}\n');
    },
  );

  it.each(["symlink", "file", "target"] as const)(
    "preserves a %s restored during dangling alias inspection",
    async (replacement) => {
      if (!(await canCreateDirectorySymlink(tempDir))) {
        return;
      }
      const staleLink = path.join(path.dirname(packageRoot), "runtime");
      const originalLink = path.join(tempDir, "original-alias");
      const missingTarget = path.join(tempDir, "plugin-runtime-deps", "missing");
      const liveTarget = path.join(tempDir, "live-package");
      const contents = '{"name":"replacement-package"}\n';
      await writePackage(liveTarget, contents);
      await fs.symlink(missingTarget, staleLink, "dir");

      const stat = fs.stat.bind(fs);
      let replaced = false;
      const inspection = vi.spyOn(fs, "stat").mockImplementation(async (...args) => {
        try {
          return await stat(...args);
        } catch (error) {
          if (String(args[0]) === staleLink && !replaced) {
            expect(error).toMatchObject({ code: "ENOENT" });
            replaced = true;
            if (replacement === "target") {
              await writePackage(missingTarget, contents);
            } else {
              // Retain the old inode so the replacement cannot reuse its identity.
              await fs.rename(staleLink, originalLink);
              if (replacement === "symlink") {
                await fs.symlink(liveTarget, staleLink, "dir");
              } else {
                await fs.writeFile(staleLink, contents);
              }
            }
          }
          throw error;
        }
      });
      try {
        const result = await removeStalePluginRuntimeSymlinks(packageRoot);
        expect(replaced).toBe(true);
        expect(result.changes).toEqual([]);
        expect(result.warnings).toEqual([
          expect.stringContaining(`Failed to remove stale plugin-runtime symlink ${staleLink}:`),
        ]);
        if (replacement === "file") {
          expect(await fs.readFile(staleLink, "utf8")).toBe(contents);
        } else {
          expect(await fs.readlink(staleLink)).toBe(
            replacement === "target" ? missingTarget : liveTarget,
          );
          expect(await readPackage(staleLink)).toBe(contents);
        }
        if (replacement !== "target") {
          expect(await fs.readlink(originalLink)).toBe(missingTarget);
        }
      } finally {
        inspection.mockRestore();
      }
    },
  );
});
