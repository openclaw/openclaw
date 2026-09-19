// Source-runner recovery and profile selection for the live Gateway dist fence.
import type { SpawnOptions } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, vi } from "vitest";
import {
  BUILD_STAMP,
  DIST_ENTRY,
  ROOT_SRC,
  RUNTIME_POSTBUILD_STAMP,
  createCurrentGitSpawnRecorder,
  createExitedProcess,
  it,
  resolvePath,
  runNodeCommand,
  runStatusCommand,
  setupStampedProject,
  setupTrackedProject,
} from "../../test/scripts/run-node.test-support.js";
import { withTestDir } from "../test-helpers/temp-dir.js";

describe("run-node live Gateway dist fence", () => {
  it.each([
    { label: "profile-prefixed gateway status", args: ["--profile", "ops", "gateway", "status"] },
    { label: "gateway stop", args: ["gateway", "stop"] },
    { label: "gateway restart", args: ["gateway", "restart"] },
    { label: "profile-prefixed gateway stop", args: ["--profile", "ops", "gateway", "stop"] },
  ])("does not rebuild for $label calls against an existing dirty dist", async ({ args }) => {
    await withTestDir({ prefix: "openclaw-run-node-" }, async (tmp) => {
      await setupStampedProject(tmp, {
        files: { [RUNTIME_POSTBUILD_STAMP]: '{"head":"abc123","inputsClean":true}\n' },
        trackConfig: true,
      });

      const runRuntimePostBuild = vi.fn();
      const { spawnCalls, spawn, spawnSync } = createCurrentGitSpawnRecorder({
        gitStatus: ` M ${ROOT_SRC}\0`,
      });
      const exitCode = await runStatusCommand({
        tmp,
        args,
        spawn,
        spawnSync,
        runRuntimePostBuild,
      });

      expect(exitCode).toBe(0);
      expect(spawnCalls).toEqual([[process.execPath, "openclaw.mjs", ...args]]);
      expect(runRuntimePostBuild).not.toHaveBeenCalled();
    });
  });

  it("dispatches gateway stop from existing dist when stamps are stale and the fence would refuse", async ({
    tmp,
  }) => {
    await setupStampedProject(tmp, {
      files: { [RUNTIME_POSTBUILD_STAMP]: '{"head":"abc123","inputsClean":true}\n' },
      trackConfig: true,
    });
    await fs.rm(resolvePath(tmp, BUILD_STAMP));
    const resolveLiveGatewayDistFence = vi.fn(async () => ({
      refuse: true as const,
      message: "[openclaw] Refusing to rebuild dist while a managed Gateway is still running.",
    }));
    const runRuntimePostBuild = vi.fn();
    const { spawnCalls, spawn, spawnSync } = createCurrentGitSpawnRecorder({
      gitStatus: ` M ${ROOT_SRC}\0`,
    });
    const exitCode = await runNodeCommand(tmp, {
      args: ["gateway", "stop"],
      spawn,
      spawnSync,
      runRuntimePostBuild,
      resolveLiveGatewayDistFence,
    });
    expect(exitCode).toBe(0);
    expect(spawnCalls).toEqual([[process.execPath, "openclaw.mjs", "gateway", "stop"]]);
    expect(resolveLiveGatewayDistFence).not.toHaveBeenCalled();
    expect(runRuntimePostBuild).not.toHaveBeenCalled();
  });

  it("applies --profile to fence inspection and the rebuild child", async ({ tmp }) => {
    const fenceEnvs: Array<NodeJS.ProcessEnv | undefined> = [];
    const resolveLiveGatewayDistFence = vi.fn(
      async (_cwd: string, deps?: { env?: NodeJS.ProcessEnv }) => {
        fenceEnvs.push(deps?.env);
        return { refuse: false as const };
      },
    );
    const spawnCalls: Array<{ args: string[]; env?: NodeJS.ProcessEnv }> = [];
    const spawn = (_cmd: string, args: string[], options: SpawnOptions) => {
      spawnCalls.push({ args, env: options.env });
      return createExitedProcess(0);
    };
    const exitCode = await runNodeCommand(tmp, {
      args: ["--profile", "ops", "models", "status"],
      env: { OPENCLAW_FORCE_BUILD: "1" },
      spawn,
      resolveLiveGatewayDistFence,
    });
    expect(exitCode).toBe(0);
    expect(fenceEnvs[0]?.OPENCLAW_PROFILE).toBe("ops");
    expect(spawnCalls[0]?.env?.OPENCLAW_PROFILE).toBe("ops");
    expect(resolveLiveGatewayDistFence).toHaveBeenCalledOnce();
  });

  it("still fences non-recovery rebuilds on a dirty live checkout", async ({ tmp }) => {
    await setupStampedProject(tmp, {
      files: { [RUNTIME_POSTBUILD_STAMP]: '{"head":"abc123","inputsClean":true}\n' },
      trackConfig: true,
    });
    const stderr: string[] = [];
    const resolveLiveGatewayDistFence = vi.fn(async () => ({
      refuse: true as const,
      message: "[openclaw] Refusing to rebuild dist while a managed Gateway is still running.",
    }));
    const { spawnCalls, spawn, spawnSync } = createCurrentGitSpawnRecorder({
      gitStatus: ` M ${ROOT_SRC}\0`,
    });
    const exitCode = await runNodeCommand(tmp, {
      args: ["models", "status"],
      spawn,
      spawnSync,
      resolveLiveGatewayDistFence,
      stderr: { write: (chunk: string | Uint8Array) => stderr.push(String(chunk)) },
      runRuntimePostBuild: vi.fn(),
    });
    expect(exitCode).toBe(1);
    expect(resolveLiveGatewayDistFence).toHaveBeenCalledOnce();
    expect(stderr.join("")).toContain("Refusing to rebuild dist");
    expect(spawnCalls).toEqual([]);
  });

  it.each([
    {
      command: "parity-report",
      reportScript: "qa-parity-report.ts",
      reportArgs: [
        "--candidate-summary",
        ".artifacts/qa-e2e/openai-candidate/qa-suite-summary.json",
        "--baseline-summary",
        ".artifacts/qa-e2e/anthropic-baseline/qa-suite-summary.json",
      ],
    },
    {
      command: "coverage",
      reportScript: "qa-coverage-report.ts",
      reportArgs: [
        "--json",
        "--tools",
        "--summary",
        ".artifacts/qa-e2e/runtime-pair-core/qa-suite-summary.json",
      ],
    },
  ])(
    "dispatches source-only QA $command before the live dist fence",
    async ({ command, reportScript, reportArgs }) => {
      await withTestDir({ prefix: "openclaw-run-node-" }, async (tmp) => {
        await setupTrackedProject(tmp, {
          files: { "extensions/qa-lab/src/cli.runtime.ts": "export {};\n" },
          buildPaths: [DIST_ENTRY, BUILD_STAMP],
        });
        const resolveLiveGatewayDistFence = vi.fn(async () => ({
          refuse: true as const,
          message: "[openclaw] Refusing to rebuild dist while a managed Gateway is still running.",
        }));
        const spawnCalls: string[][] = [];
        const spawn = (cmd: string, args: string[]) => {
          spawnCalls.push([cmd, ...args]);
          return createExitedProcess(0);
        };
        const exitCode = await runNodeCommand(tmp, {
          args: ["qa", command, ...reportArgs],
          spawn,
          resolveLiveGatewayDistFence,
        });
        expect(exitCode).toBe(0);
        expect(resolveLiveGatewayDistFence).not.toHaveBeenCalled();
        expect(spawnCalls).toEqual([
          [
            process.execPath,
            "--import",
            "tsx",
            path.join(tmp, "scripts", reportScript),
            ...reportArgs,
          ],
        ]);
      });
    },
  );
});
