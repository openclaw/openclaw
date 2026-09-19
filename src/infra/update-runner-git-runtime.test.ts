import { spawnSync as realSpawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { expect, vi } from "vitest";
import { resolveRuntimePostBuildRequirement } from "../../scripts/run-node.mts";
import {
  BUILD_STAMP,
  RUNTIME_POSTBUILD_STAMP,
  NEW_TIME,
  createBuildRequirementDeps,
  createSpawnRecorder,
  it,
  runNodeCommand,
  setupStampedProject,
  touchProjectFiles,
  trackProjectWithGit,
} from "../../test/scripts/run-node.test-support.js";
import { runCommandWithTimeout } from "../process/exec.js";
import { prepareGitRuntimePromotion } from "./update-runner-git-runtime.js";

it.for([false, true])(
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
