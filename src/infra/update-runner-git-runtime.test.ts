import { spawnSync as realSpawnSync } from "node:child_process";
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
import { expectRuntime, writeRuntime } from "./update-runner-git-candidate.test-support.js";
import { prepareGitRuntimePromotion } from "./update-runner-git-runtime.js";

describe("Git runtime promotion", () => {
  let directory: string;
  let root: string;

  async function writeCheckout(checkout: string, sha: string) {
    await fs.mkdir(path.join(checkout, "packages", "runtime"), { recursive: true });
    await fs.writeFile(
      path.join(checkout, "packages", "runtime", "index.js"),
      "module.exports = require('./node_modules/nested.cjs');",
    );
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
    await fs.rm(directory, { recursive: true, force: true });
  });

  async function createCandidate() {
    const candidateRoot = path.join(directory, "candidate-scope", "worktree");
    await writeCheckout(candidateRoot, "candidate");
    const initialized = await runCommandWithTimeout(
      ["git", "-C", candidateRoot, "init", "--initial-branch=main"],
      { timeoutMs: 5000 },
    );
    expect(initialized.code, initialized.stderr).toBe(0);
    await fs.writeFile(
      path.join(candidateRoot, ".gitignore"),
      "node_modules/\ndist/\ndist-runtime/\n",
    );
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
    await fs.rm(path.dirname(candidateRoot), { recursive: true, force: true });
    await promotion.activate();
    await promotion.cleanup();
  }

  it.each([false, true])(
    "does not repeat completed restoration after authority is lost (previous runtime: %s)",
    async (previous) => {
      const candidateRoot = await createCandidate();
      const destination = path.join(root, "dist");
      if (!previous) {
        await fs.rm(destination, { recursive: true, force: true });
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
      try {
        await expect(
          promotion.restore(() => {
            if (revoked) {
              throw new Error("restoration authority lost");
            }
          }),
        ).rejects.toThrow("restoration authority lost");
      } finally {
        renameSpy.mockRestore();
        removeSpy.mockRestore();
      }
      // A completed destination is no longer rollback-owned, even if admission then fails.
      if (!previous) {
        await fs.mkdir(destination);
        await fs.writeFile(path.join(destination, "subsequent-owner"), "preserve");
      }
      await promotion.restore();
      if (previous) {
        await expectRuntime(root, "original");
      } else {
        expect(await fs.readFile(path.join(destination, "subsequent-owner"), "utf8")).toBe(
          "preserve",
        );
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
      const original = await fs.lstat(destination, { bigint: true });
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
      try {
        const failure: unknown = await promotion.activate().catch((error: unknown) => error);
        expect(previous).toBeDefined();
        if (outcome === "uncertain") {
          expect(failure).toBe(uncertainty);
          await expect(promotion.restore()).rejects.toBe(uncertainty);
          await expect(promotion.cleanup()).rejects.toBe(uncertainty);
          expect(renameSpy.mock.calls).toHaveLength(renamedAtUncertainty);
          expect((await fs.lstat(previous!, { bigint: true })).ino).toBe(original.ino);
          return;
        }
        if (outcome === "absent") {
          expect(failure).toBe(activationError);
          expect((await fs.lstat(destination, { bigint: true })).ino).toBe(original.ino);
        } else {
          const retained = outcome === "retained-replaced" ? `${previous!}.operator` : previous!;
          expect((await fs.lstat(retained, { bigint: true })).ino).toBe(original.ino);
          if (outcome === "retained-replaced") {
            const foreign = await fs.lstat(previous!, { bigint: true });
            await expect(promotion.restore()).rejects.toThrow();
            await promotion.cleanup();
            expect((await fs.lstat(retained, { bigint: true })).ino).toBe(original.ino);
            expect((await fs.lstat(previous!, { bigint: true })).ino).toBe(foreign.ino);
            await fs.rmdir(previous!);
            await rename(retained, previous!);
          } else if (outcome === "foreign") {
            const foreign = await fs.lstat(destination, { bigint: true });
            await expect(promotion.restore()).rejects.toThrow();
            expect((await fs.lstat(destination, { bigint: true })).ino).toBe(foreign.ino);
            await promotion.cleanup();
            expect((await fs.lstat(previous!, { bigint: true })).ino).toBe(original.ino);
            await fs.rmdir(destination);
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
      } finally {
        renameSpy.mockRestore();
      }
    },
  );

  it("checks the source destination policy before any runtime staging writes", async () => {
    const candidateRoot = await createCandidate();
    const outside = path.join(directory, "outside-packages");
    await fs.rename(path.join(root, "packages"), outside);
    await fs.symlink(outside, path.join(root, "packages"), "junction");
    const before = await fs.readdir(outside, { recursive: true });
    await expect(preparePromotion(candidateRoot, assertDestination)).rejects.toThrow(
      "symbolic link",
    );
    expect(await fs.readdir(outside, { recursive: true })).toEqual(before);
    // Restore the fixture's physical depth before resolving its relative dependency links.
    await fs.unlink(path.join(root, "packages"));
    await fs.rename(outside, path.join(root, "packages"));
    await expectRuntime(root, "original");
  });

  it.each(["activate", "restore", "cleanup"] as const)(
    "retains originals when a source destination parent changes before %s",
    async (phase) => {
      const candidateRoot = await createCandidate();
      const promotion = await preparePromotion(candidateRoot, assertDestination);
      if (phase !== "activate") {
        await promotion.activate();
        await expectRuntime(root, "candidate");
      }
      const heldPackages = path.join(directory, "held-packages");
      const outside = path.join(directory, "outside-packages");
      const outsideModules = path.join(outside, "runtime", "node_modules");
      await fs.mkdir(outsideModules, { recursive: true });
      await fs.writeFile(path.join(outsideModules, "operator.cjs"), "outside content\n");
      await fs.rename(path.join(root, "packages"), heldPackages);
      await fs.symlink(outside, path.join(root, "packages"), "junction");

      await expect(promotion[phase]()).rejects.toThrow("symbolic link");
      expect(await fs.readFile(path.join(outsideModules, "operator.cjs"), "utf8")).toBe(
        "outside content\n",
      );
      expect(await fs.readdir(outsideModules)).toEqual(["operator.cjs"]);

      await fs.unlink(path.join(root, "packages"));
      await fs.rename(heldPackages, path.join(root, "packages"));
      if (phase === "activate") {
        await expectRuntime(root, "original");
        await promotion.activate();
      }
      await promotion.restore();
      await expectRuntime(root, "original");
      await promotion.cleanup();
    },
  );

  it.each(["dependency", "cache-link", "parent-link"] as const)(
    "preserves tool cache paths owned by a %s",
    async (layout) => {
      const candidateRoot = await createCandidate();
      const modules = path.join(candidateRoot, "node_modules");
      const payload = path.join(modules, layout === "dependency" ? ".vite" : "payload");
      await fs.mkdir(payload, { recursive: true });
      await fs.writeFile(path.join(payload, "index.cjs"), "module.exports = 'retained';\n");
      if (layout === "dependency") {
        await fs.symlink(payload, path.join(modules, "linked-runtime"), "junction");
        // Once retained, this cache's own link must keep the second cache too.
        await fs.mkdir(path.join(modules, ".cache", "jiti"), { recursive: true });
        await fs.writeFile(
          path.join(modules, ".cache", "jiti", "value.cjs"),
          "module.exports = 'nested';\n",
        );
        await fs.symlink(
          path.join(modules, ".cache", "jiti"),
          path.join(payload, "nested"),
          "junction",
        );
      } else if (layout === "cache-link") {
        await fs.symlink(payload, path.join(modules, ".vite"), "junction");
      } else {
        await fs.mkdir(path.join(payload, "jiti"));
        await fs.writeFile(
          path.join(payload, "jiti", "index.cjs"),
          "module.exports = 'retained';\n",
        );
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
          await fs.readFile(
            path.join(root, "node_modules", "linked-runtime", "nested", "value.cjs"),
            "utf8",
          ),
        ).toContain("nested");
      }
      await expectRuntime(root, "candidate");
    },
  );

  it.skipIf(process.platform === "win32").each(["missing", "cycle"])(
    "preserves unresolved %s links without blocking runtime promotion",
    async (layout) => {
      const candidateRoot = await createCandidate();
      const modules = path.join(candidateRoot, "node_modules");
      await fs.mkdir(path.join(modules, ".vite"));
      await fs.writeFile(path.join(modules, ".vite", "content"), "retained");
      await fs.symlink(
        layout === "cycle" ? "unresolved" : "missing",
        path.join(modules, "unresolved"),
      );
      await activate(candidateRoot);
      expect(await fs.readlink(path.join(root, "node_modules", "unresolved"))).toBe(
        layout === "cycle" ? "unresolved" : "missing",
      );
      expect(await fs.readFile(path.join(root, "node_modules", ".vite", "content"), "utf8")).toBe(
        "retained",
      );
      await expectRuntime(root, "candidate");
    },
  );

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
      const candidateRuntime = path.join(candidateRoot, replacedRoot);
      await fs.mkdir(candidateRuntime, { recursive: true });
      await fs.writeFile(path.join(candidateRuntime, "candidate.cjs"), "module.exports = 1;\n");
    }
    if (store === ".artifacts/checkout") {
      await fs.symlink(directory, path.join(root, ".artifacts"), "junction");
    }
    await runCommandWithTimeout(["git", "-C", candidateRoot, "init", "--initial-branch=main"], {
      timeoutMs: 5000,
    });
    await fs.writeFile(path.join(candidateRoot, ".gitignore"), "node_modules/\ndist/\n");
    await fs.writeFile(
      path.join(modules, ".modules.yaml"),
      JSON.stringify({
        virtualStoreDir: path.relative(modules, storePath),
      }),
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
    const expected = {
      shouldSync: newerBuild,
      reason: newerBuild ? "build_stamp_newer" : "clean",
    };
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
