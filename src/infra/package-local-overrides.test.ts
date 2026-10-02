import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { __setFsSafeTestHooksForTest } from "@openclaw/fs-safe/test-hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writePackageDistInventory } from "../../scripts/lib/package-dist-inventory.ts";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  applyLocalPackageOverrides,
  captureLocalPackageOverrides,
} from "./package-local-overrides.js";
import {
  expectPathMissing,
  useLocalOverrideTestState,
} from "./package-local-overrides.test-support.js";
import { writePackageRoot } from "./package-update-steps.test-support.js";

useLocalOverrideTestState();
const dirs = useAutoCleanupTempDirTracker(afterEach);
let base: string;
let packageRoot: string;
let distPath: string;
let indexPath: string;

beforeEach(async () => {
  base = dirs.make("openclaw-package-local-overrides-");
  packageRoot = path.join(base, "package");
  distPath = path.join(packageRoot, "dist");
  indexPath = path.join(distPath, "index.js");
  await writePackageRoot(packageRoot, "1.0.0");
});

afterEach(() => {
  __setFsSafeTestHooksForTest(undefined);
  vi.restoreAllMocks();
});

describe("local package overrides", () => {
  it("rejects recovery roots inside the package being updated", async () => {
    await fs.writeFile(indexPath, "export const local = true;\n", "utf8");

    const priorStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = path.join(packageRoot, "state");
    try {
      await expect(captureLocalPackageOverrides({ packageRoot })).rejects.toThrow(
        "local override recovery root must be outside package root",
      );
    } finally {
      if (priorStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = priorStateDir;
      }
    }
    await expectPathMissing(path.join(packageRoot, "state"));
  });

  it.runIf(process.platform !== "win32")(
    "does not capture override payloads through symlinked source ancestors",
    async () => {
      const preservedDistPath = path.join(packageRoot, "preserved-dist");
      const outsideRoot = path.join(base, "outside");
      const outsideIndexPath = path.join(outsideRoot, "index.js");
      await fs.writeFile(indexPath, "export const local = true;\n", "utf8");
      await fs.mkdir(outsideRoot);
      await fs.writeFile(outsideIndexPath, "export const outside = true;\n", "utf8");

      let ancestorChanged = false;
      __setFsSafeTestHooksForTest({
        afterPreOpenLstat: async (filePath) => {
          if (!ancestorChanged && path.basename(filePath) === path.basename(indexPath)) {
            ancestorChanged = true;
            await fs.rename(distPath, preservedDistPath);
            await fs.symlink(outsideRoot, distPath, "dir");
          }
        },
      });

      await expect(captureLocalPackageOverrides({ packageRoot })).rejects.toMatchObject({
        code: expect.stringMatching(/outside-workspace|path-mismatch|symlink/),
      });
      expect(ancestorChanged).toBe(true);
      await expect(fs.readFile(outsideIndexPath, "utf8")).resolves.toBe(
        "export const outside = true;\n",
      );
    },
  );

  it("does not classify baseline files replaced by directories as deletions", async () => {
    await fs.rm(indexPath);
    await fs.mkdir(indexPath);

    await expect(captureLocalPackageOverrides({ packageRoot })).rejects.toMatchObject({
      code: "not-file",
    });
    expect((await fs.stat(indexPath)).isDirectory()).toBe(true);
  });

  it.runIf(process.platform !== "win32")(
    "opens override capture reads nonblocking so unsupported entries cannot stall capture",
    async () => {
      await fs.writeFile(indexPath, "export const local = true;\n", "utf8");

      const openFlags: number[] = [];
      __setFsSafeTestHooksForTest({
        beforeOpen: (_filePath, flags) => {
          openFlags.push(flags);
        },
      });

      await expect(captureLocalPackageOverrides({ packageRoot })).resolves.not.toBeNull();
      expect(openFlags.length).toBeGreaterThan(0);
      expect(openFlags.every((flags) => (flags & fsConstants.O_NONBLOCK) !== 0)).toBe(true);
    },
  );

  it.runIf(process.platform !== "win32")(
    "does not reapply added overrides through symlinked target ancestors",
    async () => {
      const outsideRoot = path.join(base, "outside");
      const localAddedPath = path.join(packageRoot, "dist", "local", "added.js");
      await fs.mkdir(path.dirname(localAddedPath), { recursive: true });
      await fs.writeFile(localAddedPath, "export const local = true;\n", "utf8");

      const plan = await captureLocalPackageOverrides({ packageRoot });
      expect(plan).not.toBeNull();
      await fs.rm(path.join(packageRoot, "dist"), { recursive: true, force: true });
      await fs.mkdir(outsideRoot, { recursive: true });
      await fs.symlink(outsideRoot, path.join(packageRoot, "dist"), "dir");

      const result = await applyLocalPackageOverrides({
        packageRoot,
        plan,
        reapply: true,
      });

      expect(result.status).toBe("conflict");
      expect(result.applied).toBe(0);
      expect(result.conflicts).toEqual([
        { path: "dist/local/added.js", reason: "target-inspection-failed" },
      ]);
      await expectPathMissing(path.join(outsideRoot, "local", "added.js"));
    },
  );

  it.runIf(process.platform !== "win32")(
    "does not publish overrides when a target ancestor swaps at the final mutation boundary",
    async () => {
      const preservedDistPath = path.join(packageRoot, "preserved-dist");
      const localAddedPath = path.join(distPath, "local.js");
      const outsideRoot = path.join(base, "outside");
      const outsideAddedPath = path.join(outsideRoot, "local.js");
      await fs.writeFile(localAddedPath, "export const local = true;\n", "utf8");

      const plan = await captureLocalPackageOverrides({ packageRoot });
      expect(plan).not.toBeNull();
      await writePackageRoot(packageRoot, "2.0.0");
      await fs.rm(localAddedPath);
      await writePackageDistInventory(packageRoot);
      await fs.mkdir(outsideRoot);

      const realRealpath = fs.realpath.bind(fs);
      let ancestorChanged = false;
      vi.spyOn(fs, "realpath").mockImplementation(
        async (...args: Parameters<typeof fs.realpath>) => {
          const result = await realRealpath(...args);
          const entries =
            String(args[0]) === distPath
              ? await fs.readdir(distPath).catch(() => [] as string[])
              : [];
          if (
            !ancestorChanged &&
            entries.some((entry) => entry.startsWith(".openclaw-override-next-"))
          ) {
            ancestorChanged = true;
            await fs.rename(distPath, preservedDistPath);
            await fs.symlink(outsideRoot, distPath, "dir");
          }
          return result;
        },
      );

      const result = await applyLocalPackageOverrides({
        packageRoot,
        plan,
        reapply: true,
      });

      expect(ancestorChanged).toBe(true);
      expect(result.status).toBe("error");
      expect(result.applied).toBe(0);
      await expectPathMissing(outsideAddedPath);
    },
  );

  it.runIf(process.platform !== "win32")(
    "reapplies added overrides through a stable package-root symlink",
    async () => {
      const aliasRoot = path.join(base, "package-alias");
      const addedPath = path.join(packageRoot, "dist", "local.js");
      const content = "export const local = true;\n";
      await fs.writeFile(addedPath, content);
      await fs.symlink(packageRoot, aliasRoot, "dir");

      const plan = await captureLocalPackageOverrides({ packageRoot: aliasRoot });
      expect(plan).not.toBeNull();
      await writePackageRoot(packageRoot, "2.0.0");
      await fs.rm(addedPath);
      await writePackageDistInventory(packageRoot);

      const result = await applyLocalPackageOverrides({
        packageRoot: aliasRoot,
        plan,
        reapply: true,
      });

      expect(result).toMatchObject({ status: "applied", applied: 1, conflicts: [] });
      await expect(fs.readFile(addedPath, "utf8")).resolves.toBe(content);
      expect((await fs.lstat(aliasRoot)).isSymbolicLink()).toBe(true);
    },
  );

  it("does not reapply added overrides after the package root changes", async () => {
    const replacementRoot = path.join(base, "replacement");
    const preservedRoot = path.join(base, "preserved");
    const addedPath = path.join(packageRoot, "dist", "local.js");
    await fs.writeFile(addedPath, "export const local = true;\n", "utf8");

    const plan = await captureLocalPackageOverrides({ packageRoot });
    expect(plan).not.toBeNull();
    await writePackageRoot(packageRoot, "2.0.0");
    await fs.rm(addedPath);
    await writePackageDistInventory(packageRoot);
    await writePackageRoot(replacementRoot, "2.0.0");

    const realRealpath = fs.realpath.bind(fs);
    let rootChanged = false;
    vi.spyOn(fs, "realpath").mockImplementation(async (...args: Parameters<typeof fs.realpath>) => {
      const result = await realRealpath(...args);
      if (!rootChanged && String(args[0]) === path.join(packageRoot, "dist")) {
        rootChanged = true;
        await fs.rename(packageRoot, preservedRoot);
        await fs.rename(replacementRoot, packageRoot);
      }
      return result;
    });

    const result = await applyLocalPackageOverrides({
      packageRoot,
      plan,
      reapply: true,
    });

    expect(rootChanged).toBe(true);
    expect(result.status).toBe("conflict");
    expect(result.applied).toBe(0);
    expect(result.conflicts).toEqual([
      { path: "dist/local.js", reason: "target-inspection-failed" },
    ]);
    await expectPathMissing(path.join(packageRoot, "dist", "local.js"));
    await expectPathMissing(path.join(preservedRoot, "dist", "local.js"));
  });

  it.runIf(process.platform !== "win32").each([
    ["modified", "outside"],
    ["deleted", "outside"],
    ["added", "outside"],
    ["added", "inside"],
  ] as const)(
    "does not reapply %s overrides after a target ancestor becomes an %s symlink",
    async (overrideKind, redirectKind) => {
      const redirectRoot =
        redirectKind === "outside"
          ? path.join(base, "outside")
          : path.join(packageRoot, "redirect");
      const addedPath = path.join(packageRoot, "dist", "local.js");
      const redirectIndexPath = path.join(redirectRoot, "index.js");
      const redirectAddedPath = path.join(redirectRoot, "local.js");
      if (overrideKind === "modified") {
        await fs.writeFile(indexPath, "export const local = true;\n", "utf8");
      } else if (overrideKind === "deleted") {
        await fs.rm(indexPath);
      } else {
        await fs.writeFile(addedPath, "export const local = true;\n", "utf8");
      }

      const plan = await captureLocalPackageOverrides({ packageRoot });
      expect(plan).not.toBeNull();
      await writePackageRoot(packageRoot, "2.0.0");
      if (overrideKind === "added") {
        await fs.rm(addedPath);
        await writePackageDistInventory(packageRoot);
      }
      await fs.mkdir(redirectRoot, { recursive: true });
      await fs.writeFile(redirectIndexPath, "export const redirect = true;\n", "utf8");

      const realMkdtemp = fs.mkdtemp.bind(fs);
      vi.spyOn(fs, "mkdtemp").mockImplementation(async (prefixArg, options) => {
        if (prefixArg.endsWith(`${path.sep}rollback-`)) {
          await fs.rm(path.join(packageRoot, "dist"), { recursive: true, force: true });
          await fs.symlink(redirectRoot, path.join(packageRoot, "dist"), "dir");
        }
        return await realMkdtemp(prefixArg, options);
      });

      const result = await applyLocalPackageOverrides({
        packageRoot,
        plan,
        reapply: true,
      });

      expect(result.status).toBe("error");
      expect(result.applied).toBe(0);
      await expect(fs.readFile(redirectIndexPath, "utf8")).resolves.toBe(
        "export const redirect = true;\n",
      );
      await expectPathMissing(redirectAddedPath);
    },
  );

  it.runIf(process.platform !== "win32")(
    "does not hash replay targets after they are replaced with symlinks",
    async () => {
      const outsidePath = path.join(base, "outside.js");
      await fs.writeFile(indexPath, "export const local = true;\n", "utf8");

      const plan = await captureLocalPackageOverrides({ packageRoot });
      expect(plan).not.toBeNull();
      await writePackageRoot(packageRoot, "2.0.0");
      await fs.writeFile(outsidePath, "export const outside = true;\n", "utf8");
      const realIndexPath = await fs.realpath(indexPath);

      let targetReplaced = false;
      __setFsSafeTestHooksForTest({
        afterPreOpenLstat: async (filePath) => {
          if (!targetReplaced && filePath === realIndexPath) {
            targetReplaced = true;
            await fs.rm(indexPath);
            await fs.symlink(outsidePath, indexPath, "file");
          }
        },
      });

      const result = await applyLocalPackageOverrides({
        packageRoot,
        plan,
        reapply: true,
      });

      expect(targetReplaced).toBe(true);
      expect(result.status).toBe("conflict");
      expect(result.applied).toBe(0);
      expect(result.conflicts).toEqual([
        { path: "dist/index.js", reason: "target-inspection-failed" },
      ]);
      await expect(fs.readFile(outsidePath, "utf8")).resolves.toBe(
        "export const outside = true;\n",
      );
    },
  );
});
