import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import { hasErrnoCode } from "../../../infra/errno.js";
import { createMacosAppInstallOwner } from "../../test-runtime-config-helpers.js";
import { writePluginJson } from "./missing-configured-plugin-install.fixtures.test-support.js";
import {
  collectStalePluginRuntimeSymlinkHealthFindings,
  removeStalePluginRuntimeSymlinks,
} from "./plugin-runtime-symlinks.js";

async function expectSymlinksPresent(...paths: string[]): Promise<void> {
  for (const targetPath of paths) {
    expect((await fs.lstat(targetPath)).isSymbolicLink()).toBe(true);
  }
}

async function writePackage(root: string, contents: string): Promise<void> {
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(path.join(root, "package.json"), contents);
}

function readPackage(root: string) {
  return fs.readFile(path.join(root, "package.json"), "utf8");
}

async function tryDirectorySymlink(target: string, link: string): Promise<boolean> {
  try {
    await fs.symlink(target, link, "dir");
    return true;
  } catch (error) {
    if (["EPERM", "EACCES", "ENOTSUP"].some((code) => hasErrnoCode(error, code))) {
      return false;
    }
    throw error;
  }
}

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());
let tempDir: string;
let packageRoot: string;

beforeEach(async () => {
  tempDir = tempDirs.make("openclaw-plugin-runtime-symlinks-");
  packageRoot = path.join(tempDir, "prefix", "node_modules", "openclaw");
  await fs.mkdir(packageRoot, { recursive: true });
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
    await fs.symlink(path.join(physicalRoot, "current"), path.join(runtimeRoot, "current"), "dir");
    // Keep .. in the stored link: POSIX follows the directory symlink before ascending.
    const target = `${path.relative(path.dirname(link), runtimeRoot)}/current/../dep`;
    await fs.symlink(target, link, "dir");
    expect(await readPackage(link)).toBe(contents);

    const findings = await collectStalePluginRuntimeSymlinkHealthFindings({ packageRoot });
    const repair = await removeStalePluginRuntimeSymlinks(packageRoot);
    expect({ findings, ...repair }).toEqual({ findings: [], changes: [], warnings: [] });
    await expectSymlinksPresent(link);
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
    const legacyRoot = path.join(tempDir, "state", "plugin-runtime-deps");
    const missingTarget = path.join(legacyRoot, "openclaw-slack/node_modules/@slack/web-api");
    const scopeRoot = path.join(path.dirname(packageRoot), scope);
    const staleLink = path.join(scopeRoot, "web-api");
    const liveTarget = path.join(legacyRoot, "openclaw-live", "node_modules", "@slack", "bolt");
    const liveLink = path.join(scopeRoot, "bolt");

    if (hostOwned) {
      writePluginJson(packageRoot, "openclaw-install-owner.json", createMacosAppInstallOwner());
    }
    await fs.mkdir(scopeRoot, { recursive: true });
    await writePackage(liveTarget, '{"name":"live-runtime"}\n');
    if (code === "ENOTDIR") {
      await fs.writeFile(path.join(legacyRoot, "openclaw-slack"), "not a directory\n");
    }
    if (!(await tryDirectorySymlink(missingTarget, staleLink))) {
      return;
    }
    await fs.symlink(liveTarget, liveLink, "dir");
    const packageDirectory = path.join(path.dirname(packageRoot), "ordinary-package");
    const nestedLink = path.join(packageDirectory, "nested-stale-link");
    await fs.mkdir(packageDirectory);
    await fs.symlink(missingTarget, nestedLink, "dir");

    expect(await collectStalePluginRuntimeSymlinkHealthFindings({ packageRoot })).toEqual(
      hostOwned ? [] : [expect.objectContaining({ path: staleLink })],
    );
    await expectSymlinksPresent(staleLink, liveLink);
    expect(await removeStalePluginRuntimeSymlinks(packageRoot)).toEqual({
      changes: hostOwned ? [] : [`Removed stale plugin-runtime symlink: ${staleLink}`],
      warnings: [],
    });
    if (hostOwned) {
      await expectSymlinksPresent(staleLink);
    } else {
      await expect(fs.lstat(staleLink)).rejects.toMatchObject({ code: "ENOENT" });
    }
    await expectSymlinksPresent(liveLink, nestedLink);
    expect(await readPackage(liveLink)).toBe('{"name":"live-runtime"}\n');
  },
);

it.each(["symlink", "file", "target"] as const)(
  "preserves a %s restored during dangling alias inspection",
  async (replacement) => {
    const staleLink = path.join(path.dirname(packageRoot), "runtime");
    const originalLink = path.join(tempDir, "original-alias");
    const missingTarget = path.join(tempDir, "plugin-runtime-deps", "missing");
    const liveTarget = path.join(tempDir, "live-package");
    const contents = '{"name":"replacement-package"}\n';
    await writePackage(liveTarget, contents);
    if (!(await tryDirectorySymlink(missingTarget, staleLink))) {
      return;
    }

    const stat = fs.stat.bind(fs);
    let replaced = false;
    vi.spyOn(fs, "stat").mockImplementation(async (...args) => {
      const pending = stat(...args);
      if (String(args[0]) !== staleLink || replaced) {
        return pending;
      }
      await expect(pending).rejects.toMatchObject({ code: "ENOENT" });
      replaced = true;
      if (replacement === "target") {
        await writePackage(missingTarget, contents);
      } else {
        // Retain the old inode so the replacement cannot reuse its identity.
        await fs.rename(staleLink, originalLink);
        await (replacement === "symlink"
          ? fs.symlink(liveTarget, staleLink, "dir")
          : fs.writeFile(staleLink, contents));
      }
      return pending;
    });
    const result = await removeStalePluginRuntimeSymlinks(packageRoot);
    expect(replaced).toBe(true);
    expect(result.changes).toEqual([]);
    expect(result.warnings).toHaveLength(1);
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
  },
);
