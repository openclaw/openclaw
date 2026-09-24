import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  createNpmTarget,
  writePackageRoot,
} from "../../infra/package-update-steps.test-support.js";
import { runPackagePostInstallVerification } from "../../infra/package-update-verification-step.js";
import * as tempRoot from "../../infra/tmp-openclaw-dir.js";
import * as snapshotCapacity from "../../infra/update-candidate-snapshot.js";
import * as globalUpdate from "../../infra/update-global.js";
import * as gitRunner from "../../infra/update-runner-git.js";
import type { UpdateStepResult } from "../../infra/update-step-result.js";
import * as processRunner from "../../process/exec.js";
import * as shared from "./shared.js";
import { updateGitInstall } from "./update-command-git.js";
import * as packageUpdate from "./update-command-package.js";

afterEach(() => vi.restoreAllMocks());
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it.each(
  (["git", "package-to-git"] as const).flatMap((route) => [
    { route, timeout: "omitted", timeoutMs: undefined, expectedTimeoutMs: 30 * 60_000 },
    { route, timeout: "explicit", timeoutMs: 42_000, expectedTimeoutMs: 42_000 },
  ]),
)(
  "passes the $timeout update timeout to the $route activation Doctor",
  async ({ route, timeoutMs, expectedTimeoutMs }) => {
    const base = tempDirs.make("update-git-doctor-timeout-");
    const gitRoot = path.join(base, "checkout");
    const target = createNpmTarget(path.join(base, "node_modules"));
    assert(target.packageRoot);
    await writePackageRoot(target.packageRoot, "2026.9.3");
    await writePackageRoot(gitRoot, "2026.9.4");
    const env = {
      OPENCLAW_STATE_DIR: path.join(base, "state"),
      OPENCLAW_CONFIG_PATH: path.join(base, "openclaw.json"),
    };
    await fs.writeFile(env.OPENCLAW_CONFIG_PATH, "{}\n");
    vi.spyOn(tempRoot, "resolvePreferredOpenClawTmpDir").mockReturnValue(base);
    vi.spyOn(globalUpdate, "createGlobalInstallEnv").mockResolvedValue(env);
    vi.spyOn(globalUpdate, "resolveGlobalInstallTarget").mockResolvedValue(target);
    vi.spyOn(shared, "resolveGitInstallDir").mockReturnValue(gitRoot);
    vi.spyOn(shared, "resolveGlobalManager").mockResolvedValue("npm");
    vi.spyOn(shared, "ensureGitCheckout").mockResolvedValue({
      checkoutDir: gitRoot,
      step: null,
    });
    vi.spyOn(snapshotCapacity, "assessInitialUpdateSnapshotCapacity").mockResolvedValue({
      name: "snapshot-space-preflight",
      command: "snapshot-space-preflight",
      cwd: base,
      durationMs: 0,
      exitCode: 0,
    });
    const exposure = vi
      .spyOn(packageUpdate, "prepareGitPackageExposure")
      .mockImplementation(async ({ postVerifyStep }) => {
        assert(postVerifyStep);
        return {
          activate: async () => ({
            steps: [await runPackagePostInstallVerification(gitRoot, postVerifyStep)],
            activePackageRoot: gitRoot,
            afterVersion: "2026.9.4",
            failedStep: null,
            recovery: { serviceRestartSafe: true, version: "2026.9.4" },
          }),
          cancel: async () => ({
            steps: [],
            recovery: { serviceRestartSafe: true, version: "2026.9.3" },
          }),
        };
      });
    vi.spyOn(gitRunner, "updateGitCheckout").mockImplementation(async ({ opts }) => {
      const steps: UpdateStepResult[] = [];
      if (route === "package-to-git") {
        assert(opts.prepareGitExposure);
        await opts.prepareGitExposure(gitRoot, "a".repeat(40), env);
      } else {
        assert(opts.runGitDoctor);
        await opts.runGitDoctor(gitRoot, steps);
      }
      return { status: "ok", mode: "git", root: gitRoot, steps, durationMs: 0 };
    });
    const doctor = vi.spyOn(processRunner, "runCommandWithTimeout").mockResolvedValue({
      stdout: "",
      stderr: "",
      code: 0,
      signal: null,
      killed: false,
      termination: "exit",
    });

    const result = await updateGitInstall({
      root: route === "package-to-git" ? target.packageRoot : gitRoot,
      switchToGit: route === "package-to-git",
      installKind: route === "package-to-git" ? "package" : "git",
      timeoutMs,
      startedAt: Date.now(),
      progress: {},
      channel: "dev",
      inspectGitTarget: async () => {},
      beforeGitMutation: async () => {},
      validateCandidate: async () => {},
      getManagedServiceEnv: () => env,
      getSnapshotSource: async () => ({ config: {}, env }),
      nodeRunner: process.execPath,
      jsonMode: true,
    });

    expect(result).toMatchObject({ status: "ok", mode: "git", root: gitRoot });
    expect(result.steps.filter((step) => step.name === "openclaw doctor")).toEqual([
      expect.objectContaining({ exitCode: 0 }),
    ]);
    expect(exposure).toHaveBeenCalledTimes(route === "package-to-git" ? 1 : 0);
    expect(doctor).toHaveBeenCalledExactlyOnceWith(
      [
        process.execPath,
        path.join(gitRoot, "dist", "index.js"),
        "doctor",
        "--non-interactive",
        "--fix",
      ],
      expect.objectContaining({ cwd: gitRoot, timeoutMs: expectedTimeoutMs }),
    );
  },
);
