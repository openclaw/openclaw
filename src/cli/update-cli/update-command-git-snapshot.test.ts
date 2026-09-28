import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import * as diskSpace from "../../infra/disk-space.js";
import * as processRunner from "../../process/exec.js";
import { defaultRuntime } from "../../runtime.js";
import { withTestDir } from "../../test-helpers/temp-dir.js";
import { updateGitInstall } from "./update-command-git.js";

afterEach(() => vi.restoreAllMocks());

async function git(root: string, ...args: string[]): Promise<string> {
  const result = await processRunner.runCommandWithTimeout(["git", "-C", root, ...args], {
    timeoutMs: 5000,
  });
  if (result.code !== 0) {
    throw new Error(result.stderr);
  }
  return result.stdout.trim();
}

it.each([
  { current: true, recorded: true, noOp: true },
  { current: false, recorded: true, noOp: false },
  { current: true, recorded: false, noOp: false },
])(
  "checks snapshot space after the Git no-op decision (current=$current, recorded=$recorded)",
  async ({ current, recorded, noOp }) => {
    await withTestDir({ prefix: "git-update-snapshot-" }, async (base) => {
      const root = path.join(base, "checkout");
      const stateDir = path.join(base, "state");
      await fs.mkdir(root);
      await fs.mkdir(stateDir);
      const env = {
        HOME: base,
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
        TMPDIR: base,
      };
      await fs.writeFile(env.OPENCLAW_CONFIG_PATH, "{}\n");
      await fs.writeFile(
        path.join(root, "package.json"),
        '{"name":"openclaw","version":"2026.9.1"}',
      );
      await fs.writeFile(path.join(root, "openclaw.mjs"), "export {};\n");
      await fs.writeFile(path.join(root, ".gitignore"), "dist/\nnode_modules/\n.artifacts/\n");
      await git(root, "init", "--initial-branch=main");
      await git(root, "config", "user.name", "OpenClaw Test");
      await git(root, "config", "user.email", "openclaw@example.com");
      await git(root, "add", ".");
      await git(root, "commit", "-m", "fixture");
      const before = await git(root, "rev-parse", "HEAD");
      if (recorded) {
        await fs.mkdir(path.join(root, "dist"));
        await fs.writeFile(
          path.join(root, "dist", "build-info.json"),
          JSON.stringify({ commit: before }),
        );
      }
      let target = before;
      if (!current) {
        await fs.writeFile(path.join(root, "candidate.txt"), "candidate\n");
        await git(root, "add", "candidate.txt");
        await git(root, "commit", "-m", "candidate");
        target = await git(root, "rev-parse", "HEAD");
        await git(root, "checkout", "--detach", before);
      }
      const capacity = vi.spyOn(diskSpace, "tryReadDiskSpace").mockImplementation((targetPath) => ({
        targetPath,
        checkedPath: targetPath,
        availableBytes: 0,
        totalBytes: 1024 ** 3,
      }));
      const runCommand = processRunner.runCommandWithTimeout;
      const candidateCommand = vi.fn(() => ({
        stdout: "",
        stderr: "synthetic stop before candidate package commands",
        code: 1,
        signal: null,
        killed: false,
        termination: "exit" as const,
      }));
      vi.spyOn(processRunner, "runCommandWithTimeout").mockImplementation((argv, options) =>
        argv[0] === "git" ? runCommand(argv, options) : Promise.resolve(candidateCommand()),
      );
      const allocate = vi.spyOn(fs, "mkdtemp");
      const beforeGitMutation = vi.fn();
      const validateCandidate = vi.fn();
      const getSnapshotSource = vi.fn(async () => ({ config: {}, env }));
      vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
      const originalArgv = process.argv;
      process.argv = [process.execPath, path.join(root, "openclaw.mjs")];
      try {
        const result = await updateGitInstall({
          root,
          switchToGit: false,
          installKind: "git",
          timeoutMs: undefined,
          startedAt: Date.now(),
          progress: {},
          channel: "dev",
          devTarget: { mode: "detached", ref: target },
          beforeGitMutation,
          validateCandidate,
          inspectGitTarget: async () => {},
          getManagedServiceEnv: () => undefined,
          getSnapshotSource,
          jsonMode: true,
        });
        const headCommandOptions = vi
          .mocked(processRunner.runCommandWithTimeout)
          .mock.calls.find(([argv]) => argv.join(" ") === `git -C ${root} rev-parse HEAD`)?.[1];
        expect(
          typeof headCommandOptions === "number"
            ? headCommandOptions
            : headCommandOptions?.timeoutMs,
        ).toBe(20 * 60_000);
        expect(result).toMatchObject(
          noOp
            ? { status: "skipped", reason: "already-current" }
            : { status: "error", reason: "snapshot-capacity-insufficient" },
        );
        expect(capacity.mock.calls.length === 0).toBe(noOp);
        expect(getSnapshotSource).toHaveBeenCalledTimes(noOp ? 0 : 1);
        if (!noOp) {
          expect(result.steps).toContainEqual(
            expect.objectContaining({
              name: "snapshot-space-preflight",
              exitCode: 1,
            }),
          );
        }
        expect(
          allocate.mock.calls.some(
            ([prefix]) => prefix.includes("update-preflight-") || prefix.includes("ocu-pf-"),
          ),
        ).toBe(false);
        expect(candidateCommand).not.toHaveBeenCalled();
        expect(beforeGitMutation).not.toHaveBeenCalled();
        expect(validateCandidate).not.toHaveBeenCalled();
        expect(await git(root, "rev-parse", "HEAD")).toBe(before);
        expect(await fs.readdir(stateDir)).toEqual(["openclaw.json"]);
      } finally {
        process.argv = originalArgv;
      }
    });
  },
);
