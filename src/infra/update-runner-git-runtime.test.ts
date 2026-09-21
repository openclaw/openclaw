import { spawnSync as realSpawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

  async function activate(candidateRoot: string) {
    const cleanupRoot = path.dirname(candidateRoot);
    const promotion = await prepareGitRuntimePromotion(
      root,
      candidateRoot,
      runCommandWithTimeout,
      5000,
      cleanupRoot,
    );
    // Activation must stand alone after the disposable candidate has gone.
    await fs.rm(cleanupRoot, { recursive: true, force: true });
    await promotion.activate();
    await promotion.cleanup();
  }

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
    "live:dist",
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
    await expect(
      prepareGitRuntimePromotion(root, candidateRoot, runCommandWithTimeout, 5000, cleanupRoot),
    ).rejects.toThrow(/virtual store/i);
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
