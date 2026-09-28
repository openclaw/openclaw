import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { expect, it, vi } from "vitest";
import * as commandExec from "../../process/exec.js";
import { useStateDatabaseTempDirs } from "../../test-utils/state-database-temp-dirs.js";
import { getRegistryWorktree, updateRegistryWorktree } from "./registry.js";
import { resolveRepository } from "./service-preparation.js";
import { ManagedWorktreeService } from "./service.js";
import {
  materializeManagedWorktreeFixture,
  useManagedWorktreeTestRepository,
} from "./service.test-support.js";

const execFileAsync = promisify(execFile);
const git = async (cwd: string, ...args: string[]) =>
  (await execFileAsync("git", ["-C", cwd, ...args])).stdout.trim();
const dirs = useStateDatabaseTempDirs();
const initialize = useManagedWorktreeTestRepository();

// Included in the native Windows CI inventory; also exercises the POSIX path
// locally. No simulated platform or filesystem mode stands in for Windows.
it.each(
  [false, true].flatMap((missing) =>
    [false, true].map((keepGitLink) => ({ missing, keepGitLink })),
  ),
)(
  "recovers an ordinary native Git executable, missing=$missing, keepGitLink=$keepGitLink",
  async ({ missing, keepGitLink }) => {
    const root = await fs.realpath(dirs.make("openclaw-recovery-executable-"));
    const repo = await initialize(root);
    await git(repo, "config", "core.filemode", "false");
    await fs.writeFile(path.join(repo, "tool.sh"), "#!/bin/sh\nexit 0\n");
    await git(repo, "add", "tool.sh");
    await git(repo, "update-index", "--chmod=+x", "tool.sh");
    await git(repo, "commit", "-m", "tracked executable");
    await git(repo, "push", "origin", "main");
    const env = { ...process.env, OPENCLAW_STATE_DIR: path.join(root, "state") };
    const service = new ManagedWorktreeService({ env });
    const record = await materializeManagedWorktreeFixture({
      env,
      repoRoot: repo,
      stateDir: env.OPENCLAW_STATE_DIR,
      name: "native-executable",
      now: Date.now(),
    });
    const repository = await resolveRepository(repo);
    updateRegistryWorktree(env, record.id, {
      repositoryIdentity: { repoRoot: repo, repoFingerprint: repository.fingerprint },
    });
    const script = path.join(record.path, "tool.sh");
    expect(await git(record.path, "ls-tree", "HEAD", "tool.sh")).toMatch(/^100755 /);
    expect(await git(record.path, "status", "--porcelain")).toBe("");
    const executable = (await fs.stat(script)).mode & 0o111;
    if (process.platform === "win32") {
      expect(executable).toBe(0);
    } else {
      expect(executable).not.toBe(0);
    }
    const run = commandExec.runCommandWithTimeout;
    const fault = vi
      .spyOn(commandExec, "runCommandWithTimeout")
      .mockImplementation(async (argv, options) => {
        if (argv.includes("worktree") && argv.includes("remove")) {
          if (!keepGitLink) {
            await fs.unlink(path.join(record.path, ".git"));
          }
          await fs.unlink(path.join(record.path, "README.md"));
          if (missing) {
            await fs.unlink(script);
          }
          throw new Error("fixture interrupted native removal");
        }
        return await run(argv, options);
      });
    await expect(service.removeIfLossless(record.id)).rejects.toThrow(
      "fixture interrupted native removal",
    );
    fault.mockRestore();
    const snapshot = await git(repo, "rev-parse", `refs/openclaw/removals/${record.id}`);
    expect(await git(repo, "ls-tree", snapshot, "tool.sh")).toMatch(/^100755 /);
    await expect(service.recoverRemoval({ id: record.id, snapshot })).resolves.toMatchObject({
      removed: true,
    });
    await expect(fs.stat(record.path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await git(repo, "branch", "--list", record.branch)).toBe("");
    expect(
      await git(repo, "for-each-ref", "--format=%(refname)", `refs/openclaw/removals/${record.id}`),
    ).toBe("");
    expect(await git(repo, "show", `${snapshot}:tool.sh`)).toBe("#!/bin/sh\nexit 0");
    expect(getRegistryWorktree(env, record.id)?.removedAt).toEqual(expect.any(Number));
  },
);
