import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import "../test-utils/prepare-compiled-subprocesses.js";
import type { CommandRunner } from "./update-runner-types.js";

const mocks = vi.hoisted(() => ({
  command: vi.fn<CommandRunner>(),
  preflight: vi.fn<typeof import("./update-runner-git-preflight.js").runGitCandidatePreflight>(),
}));
vi.mock("../process/exec.js", async (original) => ({
  ...(await original<typeof import("../process/exec.js")>()),
  runCommandWithTimeout: mocks.command,
}));
// Acquisition and the independent generation use real Git; the build is another owner's boundary.
vi.mock("./update-runner-git-preflight.js", async (original) => ({
  ...(await original<typeof import("./update-runner-git-preflight.js")>()),
  runGitCandidatePreflight: mocks.preflight,
}));

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

it("reuses release objects for consecutive preparations and keeps independent generations", async () => {
  const { runCommandWithTimeout: run } =
    await vi.importActual<typeof import("../process/exec.js")>("../process/exec.js");
  const root = dirs.make("immutable-source-");
  const remote = path.join(root, "remote");
  const current = path.join(root, "current");
  await fs.mkdir(remote);
  const env = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: "Fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.test",
    GIT_COMMITTER_NAME: "Fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.test",
  };
  const git = async (cwd: string, ...args: string[]) => {
    const result = await run(["git", "-C", cwd, ...args], { env, timeoutMs: 10_000 });
    expect(result.code, result.stderr).toBe(0);
    return result.stdout.trim();
  };
  await git(remote, "init", "-b", "main");
  await fs.writeFile(path.join(remote, "old-download"), randomBytes(1024 * 1024));
  await git(remote, "add", ".");
  await git(remote, "commit", "-m", "history");
  await fs.rm(path.join(remote, "old-download"));
  await fs.writeFile(path.join(remote, "source"), "installed");
  await git(remote, "add", "-A");
  await git(remote, "commit", "-m", "installed release");
  const installed = await git(remote, "rev-parse", "HEAD");
  await git(remote, "checkout", "--orphan", "unrelated");
  await git(remote, "commit", "-am", "unrelated history");
  const unrelated = await git(remote, "rev-parse", "HEAD");
  await git(remote, "checkout", "main");
  await git(root, "clone", "--no-hardlinks", remote, current);
  await fs.writeFile(path.join(remote, "source"), "next release");
  await fs.writeFile(path.join(remote, "new-download"), randomBytes(64 * 1024));
  await git(remote, "add", ".");
  await git(remote, "commit", "-m", "next release");
  const target = await git(remote, "rev-parse", "HEAD");
  const drop = path.join(root, "drop-once");
  const uploadPack = path.join(root, "upload-pack");
  await fs.writeFile(
    uploadPack,
    `#!${process.execPath}
import { spawn } from 'node:child_process';
import { existsSync, unlinkSync } from 'node:fs';
const drop = ${JSON.stringify(drop)};
const interrupt = existsSync(drop);
if (interrupt) unlinkSync(drop);
const child = spawn('git', ['upload-pack', ...process.argv.slice(2)]);
process.stdin.pipe(child.stdin);
child.stderr.pipe(process.stderr);
let bytes = 0;
child.stdout.on('data', chunk => {
  bytes += chunk.length;
  if (interrupt && bytes > 4096) {
    process.stdout.write(chunk.subarray(0, 1024));
    child.kill();
    process.exitCode = 1;
  } else process.stdout.write(chunk);
});
child.on('close', code => { process.exitCode = interrupt ? 1 : code; });
`,
    { mode: 0o755 },
  );

  const prepare = async (seed: string, sha: string, index: number) => {
    const stage = path.join(root, `stage-${index}`);
    await fs.mkdir(stage);
    const trace = path.join(root, `transfer-${index}`);
    const completed = Promise.withResolvers<void>();
    const fetches: { code: number | null; timeoutMs: number | undefined }[] = [];
    mocks.command.mockImplementation(async (argv, options) => {
      const args = argv.slice(1);
      const fetchIndex = args.indexOf("fetch");
      if (fetchIndex !== -1) {
        args.splice(fetchIndex + 1, 0, `--upload-pack=${uploadPack}`);
      }
      const result = await run(
        [
          "git",
          "-c",
          `url.file://${remote}.insteadOf=https://github.com/openclaw/openclaw.git`,
          ...args,
        ],
        { ...options, env: { ...env, GIT_TRACE_PACKFILE: trace } },
      );
      if (fetchIndex !== -1) {
        fetches.push({ code: result.code, timeoutMs: options.timeoutMs });
      }
      return result;
    });
    mocks.preflight.mockImplementation(async (options) => {
      try {
        const built = path.join(stage, "built");
        await expect(
          fs.access(path.join(stage, "source", ".git", "objects", "info", "alternates")),
        ).rejects.toThrow();
        await git(options.gitRoot, "worktree", "add", "--detach", built, sha);
        await fs.writeFile(path.join(built, "artifact"), "built output");
        await options.beforeCandidate?.(sha);
        await options.prepareCandidate?.(built, stage);
        completed.resolve();
        return {
          status: "ok",
          candidateSha: sha,
          selectedDevUpstream: null,
          localDevBranchExists: false,
        };
      } catch (error) {
        completed.reject(error);
        throw error;
      }
    });
    vi.spyOn(process, "geteuid").mockReturnValue(1000);
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      if (!String(chunk).includes("retrying with retained local objects")) {
        completed.reject(new Error(String(chunk)));
      }
      return true;
    });
    const argv = process.argv;
    const exitCode = process.exitCode;
    process.argv = [
      process.execPath,
      "worker",
      stage,
      sha,
      "10000",
      "0",
      seed,
      await git(seed, "rev-parse", "HEAD"),
    ];
    try {
      vi.resetModules();
      await import("./update-immutable-build.worker.js");
      await completed.promise;
    } finally {
      process.argv = argv;
      process.exitCode = exitCode;
      vi.restoreAllMocks();
    }
    const bytes = (await fs.stat(trace).catch(() => ({ size: 0 }))).size;
    expect(
      bytes,
      "only objects missing from the installed release should cross the transport",
    ).toBeLessThan(128 * 1024);
    if (index === 1) {
      expect(fetches).toEqual([
        { code: 128, timeoutMs: 300_000 },
        { code: 0, timeoutMs: 300_000 },
      ]);
    }
    const generation = path.join(stage, "generation");
    expect(await git(generation, "rev-parse", "HEAD")).toBe(sha);
    await fs.rm(path.join(stage, "source"), { recursive: true });
    expect(await git(generation, "fsck", "--full")).not.toContain("missing");
    console.log(`preparation ${index}: ${bytes} transferred bytes`);
    return generation;
  };

  await fs.writeFile(drop, "drop first fetch");
  const generation = await prepare(current, target, 1);
  await fs.writeFile(path.join(remote, "source"), "new main after target");
  await git(remote, "commit", "-am", "advance main");
  // Older official targets remain valid; the previous generation supplies the objects.
  const second = await prepare(generation, installed, 2);
  await expect(prepare(current, unrelated, 3)).rejects.toThrow(
    "immutable-official-ancestry failed",
  );
  await fs.rm(current, { recursive: true });
  await fs.rm(generation, { recursive: true });
  expect(await git(second, "fsck", "--full")).not.toContain("missing");
});

it("refuses root before acquiring source or running candidate scripts", async () => {
  mocks.command.mockClear();
  mocks.preflight.mockClear();
  vi.spyOn(process, "geteuid").mockReturnValue(0);
  const reported = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  const argv = process.argv;
  const exitCode = process.exitCode;
  process.argv = [
    process.execPath,
    "worker",
    "/private-stage",
    "b".repeat(40),
    "1000",
    "0",
    "/current",
    "a".repeat(40),
  ];
  try {
    vi.resetModules();
    await import("./update-immutable-build.worker.js");
    expect(reported).toHaveBeenCalledWith(expect.stringContaining("non-root"));
    expect(mocks.command).not.toHaveBeenCalled();
    expect(mocks.preflight).not.toHaveBeenCalled();
  } finally {
    process.argv = argv;
    process.exitCode = exitCode;
  }
});
