import assert from "node:assert/strict";
import { spawnSync as realSpawnSync } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertRealOutputRoot } from "../../scripts/lib/output-root-guard.mjs";
import { resolveRuntimePostBuildRequirement } from "../../scripts/run-node.mts";
import {
  BUILD_STAMP,
  RUNTIME_POSTBUILD_STAMP,
  NEW_TIME,
  createBuildRequirementDeps,
  createSpawnRecorder,
  it as runtimeIt,
  runNodeCommand,
  setupStampedProject,
  touchProjectFiles,
  trackProjectWithGit,
} from "../../test/scripts/run-node.test-support.js";
import { CommandProcessCleanupError } from "../process/exec-result.js";
import { runCommandWithTimeout } from "../process/exec.js";
import {
  expectRuntime,
  writeRuntime,
  expectFile,
  expectMissing,
  readText,
  runFixtureGit,
  writeFixtureTree,
} from "./update-runner-git-candidate.test-support.js";
import { prepareGitRuntimePromotion } from "./update-runner-git-runtime.js";

const removeTree = (target: string) => fs.rm(target, { recursive: true, force: true });
const inode = async (target: string) => (await fs.lstat(target, { bigint: true })).ino;
const entries = async (target: string) =>
  (await fs.readdir(target, { recursive: true })).toSorted();
async function initCandidate(candidate: string, ignored = "node_modules/\ndist/\ndist-runtime/\n") {
  await runFixtureGit(candidate, "init", "--initial-branch=main");
  await writeFixtureTree(candidate, { ".gitignore": ignored });
}

describe("Git runtime promotion", () => {
  let directory: string;
  let root: string;

  async function writeCheckout(checkout: string, sha: string) {
    await writeFixtureTree(checkout, {
      "packages/runtime/index.js": "module.exports = require('./node_modules/nested.cjs');",
    });
    await writeRuntime(checkout, sha, path.join(directory, "shared-store"), "node_modules/.pnpm");
  }

  beforeEach(async () => {
    directory = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-git-runtime-")),
    );
    root = path.join(directory, "checkout");
    await writeCheckout(root, "original");
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await removeTree(directory);
  });

  async function createCandidate() {
    const candidateRoot = path.join(directory, "candidate-scope", "worktree");
    await writeCheckout(candidateRoot, "candidate");
    await initCandidate(candidateRoot);
    return candidateRoot;
  }

  function preparePromotion(candidateRoot: string, validateDestination?: (path: string) => void) {
    return prepareGitRuntimePromotion(
      root,
      candidateRoot,
      runCommandWithTimeout,
      5000,
      path.dirname(candidateRoot),
      validateDestination,
    );
  }

  async function activate(candidateRoot: string) {
    const promotion = await preparePromotion(candidateRoot);
    // Activation must stand alone after the disposable candidate has gone.
    await removeTree(path.dirname(candidateRoot));
    await promotion.activate();
    await promotion.cleanup();
  }

  it("stages a packaged plugin's checkout self-link without Windows symbolic-link privileges", async () => {
    const candidateRoot = await createCandidate();
    const relative = path.join("dist", "extensions", "x", "node_modules", "openclaw");
    await fs.mkdir(path.dirname(path.join(candidateRoot, relative)), { recursive: true });
    await fs.symlink(candidateRoot, path.join(candidateRoot, relative), "junction");
    const copy = fs.cp.bind(fs);
    const copySpy = vi.spyOn(fs, "cp").mockImplementation(async (source, destination, options) => {
      // Windows' native directory copy can expand junctions despite verbatimSymlinks.
      expect(options?.filter).toBeTypeOf("function");
      return copy(source, destination, {
        ...options,
        filter: async (sourceEntry, destinationEntry) => {
          if (!(await options?.filter?.(sourceEntry, destinationEntry))) {
            return false;
          }
          if (
            (await fs.lstat(sourceEntry)).isSymbolicLink() &&
            (await fs.stat(sourceEntry)).isDirectory()
          ) {
            throw Object.assign(new Error("Directory symbolic-link privilege is unavailable"), {
              code: "EPERM",
            });
          }
          return true;
        },
      });
    });
    const symlink = fsSync.symlinkSync.bind(fsSync);
    const junctionSpy = vi.spyOn(fsSync, "symlinkSync").mockImplementation((target, dest, type) => {
      if (type !== "junction") {
        throw Object.assign(new Error("Symbolic-link privilege is unavailable"), { code: "EPERM" });
      }
      symlink(target, dest, type);
    });
    const hostPlatform = process.platform;
    const platform = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const promotion = await prepareGitRuntimePromotion(
      root,
      candidateRoot,
      async (argv, options) => {
        platform.mockReturnValue(hostPlatform);
        try {
          return await runCommandWithTimeout(argv, options);
        } finally {
          platform.mockReturnValue("win32");
        }
      },
      5000,
      path.dirname(candidateRoot),
    );
    platform.mockRestore();
    copySpy.mockRestore();
    junctionSpy.mockRestore();
    await removeTree(path.dirname(candidateRoot));
    await promotion.activate();
    expect((await fs.lstat(path.join(root, relative))).isSymbolicLink()).toBe(true);
    expect(await fs.realpath(path.join(root, relative))).toBe(root);
    await expectRuntime(root, "candidate");
    await promotion.cleanup();
  });

  it.each([false, true])(
    "retries partial runtime restoration without losing originals (cleanup first: %s)",
    async (cleanupFirst) => {
      const candidate = await createCandidate();
      const promotion = await preparePromotion(candidate);
      await removeTree(path.dirname(candidate));
      const rename = fs.rename.bind(fs);
      const destination = path.join(root, "dist");
      let backup: string | undefined;
      let rejectRestore = true;
      vi.spyOn(fs, "rename").mockImplementation(async (source, target) => {
        if (source === destination) {
          backup = String(target);
        }
        if (rejectRestore && source === backup && target === destination) {
          await writeFixtureTree(target, { "restore-race": "occupied" });
        }
        return rename(source, target);
      });
      await promotion.activate();
      await expectRuntime(root, "candidate");
      await expect(promotion.restore()).rejects.toThrow();
      if (cleanupFirst) {
        await promotion.cleanup();
      }
      assert(backup, "The original dist backup was not observed.");
      expect(JSON.parse(await readText(path.join(backup, "build-info.json")))).toMatchObject({
        commit: "original",
      });
      expect(await readText(path.join(root, "node_modules", "identity.cjs"))).toContain("original");
      rejectRestore = false;
      await promotion.restore();
      await expectRuntime(root, "original");
      await promotion.cleanup();
      await expectMissing(path.dirname(backup));
    },
  );

  it.each([false, true])(
    "does not repeat completed restoration after authority is lost (previous runtime: %s)",
    async (previous) => {
      const candidateRoot = await createCandidate();
      const destination = path.join(root, "dist");
      if (!previous) {
        await removeTree(destination);
      }
      const promotion = await preparePromotion(candidateRoot);
      await promotion.activate();
      let revoked = false;
      const rename = fs.rename.bind(fs);
      const remove = fs.rm.bind(fs);
      const renameSpy = vi.spyOn(fs, "rename").mockImplementation(async (source, target) => {
        await rename(source, target);
        if (previous && path.basename(String(source)) === "previous" && target === destination) {
          revoked = true;
        }
      });
      const removeSpy = vi.spyOn(fs, "rm").mockImplementation(async (target, options) => {
        await remove(target, options);
        if (!previous && target === destination) {
          revoked = true;
        }
      });
      await expect(
        promotion.restore(() => {
          if (revoked) {
            throw new Error("restoration authority lost");
          }
        }),
      ).rejects.toThrow("restoration authority lost");
      renameSpy.mockRestore();
      removeSpy.mockRestore();
      // A completed destination is no longer rollback-owned, even if admission then fails.
      if (!previous) {
        await fs.mkdir(destination);
        await fs.writeFile(path.join(destination, "subsequent-owner"), "preserve");
      }
      await promotion.restore();
      if (previous) {
        await expectRuntime(root, "original");
      } else {
        await expectFile(path.join(destination, "subsequent-owner"), "preserve");
      }
      await promotion.cleanup();
    },
  );

  function assertDestination(destination: string) {
    let current = root;
    assertRealOutputRoot(current);
    for (const component of path.relative(root, destination).split(path.sep)) {
      current = path.join(current, component);
      assertRealOutputRoot(current);
    }
  }

  it.each(["absent", "foreign", "authority-lost", "retained-replaced", "uncertain"] as const)(
    "compensates only an owned partial activation (%s)",
    async (outcome) => {
      const candidateRoot = await createCandidate();
      let current = true;
      const uncertainty = new CommandProcessCleanupError();
      const promotion = await preparePromotion(candidateRoot, (destination) => {
        if (!current) {
          throw outcome === "uncertain" ? uncertainty : new Error("source authority lost");
        }
        assertDestination(destination);
      });
      const destination = path.join(root, "dist");
      const original = await inode(destination);
      const rename = fs.rename.bind(fs);
      const activationError = new Error("candidate rename refused");
      let previous: string | undefined;
      let renamedAtUncertainty = 0;
      const renameSpy = vi.spyOn(fs, "rename").mockImplementation(async (source, target) => {
        if (source === destination) {
          previous = String(target);
        }
        if (String(source).endsWith(`${path.sep}candidate`) && target === destination) {
          if (outcome === "foreign") {
            await fs.mkdir(destination);
          }
          if (outcome === "authority-lost") {
            current = false;
          }
          if (outcome === "retained-replaced") {
            await rename(previous!, `${previous!}.operator`);
            await fs.mkdir(previous!);
          }
          throw activationError;
        }
        const result = await rename(source, target);
        if (outcome === "uncertain" && source === destination) {
          current = false;
          renamedAtUncertainty = renameSpy.mock.calls.length;
        }
        return result;
      });
      const failure: unknown = await promotion.activate().catch((error: unknown) => error);
      expect(previous).toBeDefined();
      if (outcome === "uncertain") {
        expect(failure).toBe(uncertainty);
        await expect(promotion.restore()).rejects.toBe(uncertainty);
        await expect(promotion.cleanup()).rejects.toBe(uncertainty);
        expect(renameSpy.mock.calls).toHaveLength(renamedAtUncertainty);
        expect(await inode(previous!)).toBe(original);
        return;
      }
      if (outcome === "absent") {
        expect(failure).toBe(activationError);
        expect(await inode(destination)).toBe(original);
      } else {
        const retained = outcome === "retained-replaced" ? `${previous!}.operator` : previous!;
        expect(await inode(retained)).toBe(original);
        if (outcome === "retained-replaced" || outcome === "foreign") {
          const occupied = outcome === "foreign" ? destination : previous!;
          const foreign = await inode(occupied);
          await expect(promotion.restore()).rejects.toThrow();
          expect(await inode(occupied)).toBe(foreign);
          await promotion.cleanup();
          expect(await inode(retained)).toBe(original);
          expect(await inode(occupied)).toBe(foreign);
          await fs.rmdir(occupied);
          if (outcome === "retained-replaced") {
            await rename(retained, previous!);
          }
        } else {
          await expect(promotion.restore()).rejects.toThrow("source authority lost");
          await expect(promotion.cleanup()).rejects.toThrow("source authority lost");
          await expect(fs.lstat(destination)).rejects.toMatchObject({ code: "ENOENT" });
          current = true;
        }
        expect(failure).toMatchObject({ errors: [activationError, expect.any(Error)] });
      }
      await promotion.restore();
      await expectRuntime(root, "original");
      await promotion.cleanup();
    },
  );

  it.each(["prepare", "activate", "restore", "cleanup"] as const)(
    "retains originals when a source destination parent changes before %s",
    async (phase) => {
      const candidateRoot = await createCandidate();
      const outside = path.join(directory, "outside-packages");
      const promotion =
        phase === "prepare" ? undefined : await preparePromotion(candidateRoot, assertDestination);
      if (promotion && phase !== "activate") {
        await promotion.activate();
        await expectRuntime(root, "candidate");
      }
      const heldPackages = phase === "prepare" ? outside : path.join(directory, "held-packages");
      const outsideModules = path.join(outside, "runtime", "node_modules");
      if (promotion) {
        await writeFixtureTree(outsideModules, { "operator.cjs": "outside content\n" });
      }
      await fs.rename(path.join(root, "packages"), heldPackages);
      await fs.symlink(outside, path.join(root, "packages"), "junction");
      const before = await entries(outside);
      await expect(
        phase === "prepare"
          ? preparePromotion(candidateRoot, assertDestination)
          : promotion![phase](),
      ).rejects.toThrow("symbolic link");
      expect(await entries(outside)).toEqual(before);
      if (promotion) {
        await expectFile(path.join(outsideModules, "operator.cjs"), "outside content\n");
        expect(await fs.readdir(outsideModules)).toEqual(["operator.cjs"]);
      }
      // Restore physical depth before resolving the fixture's relative dependency links.
      await fs.unlink(path.join(root, "packages"));
      await fs.rename(heldPackages, path.join(root, "packages"));
      await promotion?.restore();
      await expectRuntime(root, "original");
      await promotion?.cleanup();
    },
  );

  it.each([
    "dependency",
    "cache-link",
    "parent-link",
    ...(process.platform === "win32" ? [] : ["missing", "cycle"]),
  ])("preserves tool cache paths owned by a %s", async (layout) => {
    const candidateRoot = await createCandidate();
    const modules = path.join(candidateRoot, "node_modules");
    if (layout === "missing" || layout === "cycle") {
      await writeFixtureTree(modules, { ".vite/content": "retained" });
      const target = layout === "cycle" ? "unresolved" : "missing";
      await fs.symlink(target, path.join(modules, "unresolved"));
      await activate(candidateRoot);
      expect(await fs.readlink(path.join(root, "node_modules/unresolved"))).toBe(target);
      await expectFile(path.join(root, "node_modules/.vite/content"), "retained");
      await expectRuntime(root, "candidate");
      return;
    }
    const payload = path.join(modules, layout === "dependency" ? ".vite" : "payload");
    await writeFixtureTree(payload, { "index.cjs": "module.exports = 'retained';\n" });
    if (layout === "dependency") {
      await fs.symlink(payload, path.join(modules, "linked-runtime"), "junction");
      // Once retained, this cache's own link must keep the second cache too.
      const nested = path.join(modules, ".cache/jiti");
      await writeFixtureTree(nested, { "value.cjs": "module.exports = 'nested';\n" });
      await fs.symlink(nested, path.join(payload, "nested"), "junction");
    } else if (layout === "cache-link") {
      await fs.symlink(payload, path.join(modules, ".vite"), "junction");
    } else {
      await writeFixtureTree(payload, { "jiti/index.cjs": "module.exports = 'retained';\n" });
      await fs.symlink(payload, path.join(modules, ".cache"), "junction");
    }
    await activate(candidateRoot);
    const relative =
      layout === "dependency"
        ? "linked-runtime"
        : layout === "cache-link"
          ? ".vite"
          : ".cache/jiti";
    const probe = await runCommandWithTimeout(
      [
        process.execPath,
        "-e",
        `console.log(require(${JSON.stringify(path.join(root, "node_modules", relative, "index.cjs"))}));`,
      ],
      { timeoutMs: 5000 },
    );
    expect(probe.code, probe.stderr).toBe(0);
    expect(probe.stdout.trim()).toBe("retained");
    if (layout === "dependency") {
      expect(
        await readText(path.join(root, "node_modules/linked-runtime/nested/value.cjs")),
      ).toContain("nested");
    }
    await expectRuntime(root, "candidate");
  });

  it.each([
    ".",
    "..",
    "../checkout",
    ".artifacts/checkout",
    "live:node_modules",
    "live:packages/runtime/node_modules",
    "link:node_modules",
  ])("refuses virtual store %s before promotion can replace a checkout", async (store) => {
    const cleanupRoot = path.join(directory, "candidate-scope");
    const candidateRoot = path.join(cleanupRoot, "worktree");
    const modules = path.join(candidateRoot, "node_modules");
    await fs.mkdir(modules, { recursive: true });
    const replacedRoot = /^(?:live|link):(.+)$/u.exec(store)?.[1];
    const payload = replacedRoot
      ? path.join(root, replacedRoot, "operator-store")
      : path.resolve(candidateRoot, store);
    const storePath = store.startsWith("link:") ? path.join(directory, "external-store") : payload;
    await fs.mkdir(payload, { recursive: true });
    if (storePath !== payload) {
      await fs.symlink(payload, storePath, "junction");
    }
    if (replacedRoot) {
      await writeFixtureTree(path.join(candidateRoot, replacedRoot), {
        "candidate.cjs": "module.exports = 1;\n",
      });
    }
    if (store === ".artifacts/checkout") {
      await fs.symlink(directory, path.join(root, ".artifacts"), "junction");
    }
    await initCandidate(candidateRoot, "node_modules/\ndist/\n");
    await fs.writeFile(
      path.join(modules, ".modules.yaml"),
      JSON.stringify({ virtualStoreDir: path.relative(modules, storePath) }),
    );
    await expect(preparePromotion(candidateRoot)).rejects.toThrow(/virtual store/i);
    await expectRuntime(root, "original");
  });
});

runtimeIt.for([false, true])(
  "preserves runtime freshness across Git promotion (newer build: %s)",
  async (newerBuild, { tmp }) => {
    const candidate = path.join(tmp, "candidate");
    const installed = path.join(tmp, "installed");
    await setupStampedProject(candidate, {
      files: { ".gitignore": "dist/\ndist-runtime/\n.artifacts/\n" },
    });
    const { git, deps } = await trackProjectWithGit(candidate);
    git("clone", "--quiet", candidate, installed);
    await touchProjectFiles(
      candidate,
      [newerBuild ? BUILD_STAMP : RUNTIME_POSTBUILD_STAMP],
      NEW_TIME,
    );
    const expected = { shouldSync: newerBuild, reason: newerBuild ? "build_stamp_newer" : "clean" };
    expect(resolveRuntimePostBuildRequirement(deps)).toEqual(expected);

    const promotion = await prepareGitRuntimePromotion(
      installed,
      candidate,
      runCommandWithTimeout,
      5_000,
      tmp,
    );
    await promotion.activate();
    await promotion.cleanup();

    expect(
      resolveRuntimePostBuildRequirement({
        ...createBuildRequirementDeps(installed),
        env: {},
        spawnSync: realSpawnSync,
      }),
    ).toEqual(expected);
    for (const stamp of [BUILD_STAMP, RUNTIME_POSTBUILD_STAMP]) {
      expect((await fs.stat(path.join(installed, stamp))).mtimeMs).toBe(
        (await fs.stat(path.join(candidate, stamp))).mtimeMs,
      );
    }
    if (!newerBuild) {
      const runRuntimePostBuild = vi.fn();
      const { spawn, spawnCalls } = createSpawnRecorder();
      expect(
        await runNodeCommand(installed, {
          args: ["--version"],
          spawn,
          spawnSync: realSpawnSync,
          runRuntimePostBuild,
        }),
      ).toBe(0);
      expect(spawnCalls).toEqual([[process.execPath, "openclaw.mjs", "--version"]]);
      expect(runRuntimePostBuild).not.toHaveBeenCalled();
    }
  },
);
