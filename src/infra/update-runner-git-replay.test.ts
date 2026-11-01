import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { runCommandWithTimeout } from "../process/exec.js";
import {
  createGitUpdateFixture,
  expectRuntime,
  runFixtureGit as git,
  type GitUpdateFixture,
} from "./update-runner-git-candidate.test-support.js";
import type { CommandRunner, UpdateRunnerOptions } from "./update-runner-types.js";

describe("Git update local replay", () => {
  const directories = useAutoCleanupTempDirTracker(afterEach);
  let fixture: GitUpdateFixture;
  let directory: string;
  let root: string;
  let remote: string;
  let beforeSha: string;
  let events: string[];
  let runCommand: CommandRunner;
  beforeEach(async () => {
    directory = await fs.realpath(directories.make("openclaw-git-replay-"));
    fixture = await createGitUpdateFixture(directory);
    ({ root, remote, beforeSha, events, runCommand } = fixture);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });
  const advanceRemote = () => fixture.advanceRemote();
  const head = () => git(root, "rev-parse", "HEAD");
  const expectInstalled = (sha: string) => expectRuntime(root, sha);
  function update(opts: Partial<Omit<UpdateRunnerOptions, "prepareGitExposure">> = {}) {
    fixture.runCommand = runCommand;
    return fixture.update({
      runGitDoctor: async (cwd) => ({
        name: "openclaw doctor",
        command: "fixture Doctor",
        cwd,
        durationMs: 0,
        exitCode: 0,
      }),
      ...opts,
    });
  }
  it("trusted-main reproduction: updates detached shallow partial clones without replaying disconnected main", async () => {
    await fs.writeFile(path.join(remote, "retired.txt"), "removed before deployment\n");
    await git(remote, "add", ".");
    await git(remote, "commit", "-m", "old upstream file");
    const staleMain = await git(remote, "rev-parse", "HEAD");
    await git(remote, "rm", "retired.txt");
    const deployed = await advanceRemote();
    await fs.writeFile(path.join(remote, "new-upstream.txt"), "next upstream\n");
    await git(remote, "add", ".");
    await git(remote, "commit", "-m", "next upstream");
    const target = await git(remote, "rev-parse", "HEAD");
    await git(remote, "config", "uploadpack.allowFilter", "true");
    // Replace only this test's disposable checkout with a real shallow blob:none clone.
    await fs.rm(root, { recursive: true, force: true });
    await git(
      directory,
      "clone",
      "--filter=blob:none",
      "--depth=1",
      pathToFileURL(remote).href,
      root,
    );
    await git(root, "fetch", "--depth=1", "origin", deployed, staleMain);
    await git(root, "checkout", "--detach", deployed);
    await git(root, "update-ref", "refs/heads/main", staleMain);
    await git(root, "config", "user.name", "OpenClaw Test");
    await git(root, "config", "user.email", "openclaw@example.com");
    expect(await git(root, "rev-parse", "--is-shallow-repository")).toBe("true");
    expect(await git(root, "config", "remote.origin.partialclonefilter")).toBe("blob:none");
    const relation = await runCommandWithTimeout(
      ["git", "-C", root, "merge-base", staleMain, target],
      { timeoutMs: 5000 },
    );
    expect(relation.code).toBe(1);
    fixture.beforeSha = deployed;
    beforeSha = deployed;
    await fixture.writeRuntime();
    const replays: { source: string; timeoutMs: number | null; code: number | null }[] = [];
    const execute = runCommand;
    runCommand = async (argv, options) => {
      const result = await execute(argv, options);
      if (argv.includes("rebase") && !argv.includes("--abort")) {
        replays.push({
          source: await git(options.cwd!, "rev-parse", "ORIG_HEAD"),
          timeoutMs: options.timeoutMs ?? null,
          code: result.code,
        });
      }
      return result;
    };
    const result = await update();
    expect(result).toMatchObject({ status: "ok", after: { sha: target } });
    expect(replays).toEqual([]);
    await expect(fs.stat(path.join(root, "retired.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await git(root, "rev-parse", `refs/openclaw/update-preserved/main-${staleMain}`)).toBe(
      staleMain,
    );
    expect(
      result.steps.some((step) => step.advisory?.message.includes("no visible shared history")),
    ).toBe(true);
    await expectInstalled(target);
  }, 20_000);

  it.for([
    "connected",
    "merge",
    "timeout",
    "early-timeout",
    "abort-failure",
    "short-timeout",
    "conflict",
    "interrupted",
    "ref-failure",
    "ref-interrupted",
    "probe-interrupted",
    "rollback",
    "detached-rollback",
  ] as const)(
    "keeps local work and cancellation semantics during dev replay: %s",
    { timeout: 20_000 },
    async (mode, { skip }) => {
      const timedReplay =
        mode === "timeout" ||
        mode === "short-timeout" ||
        mode === "early-timeout" ||
        mode === "abort-failure";
      if (timedReplay && process.platform === "win32") {
        skip();
      }
      await fs.writeFile(path.join(root, "patch.txt"), "local patch\n");
      await git(root, "add", ".");
      await git(root, "commit", "-m", "local patch");
      if (mode === "merge") {
        await git(root, "checkout", "-b", "side", beforeSha);
        await fs.writeFile(path.join(root, "side.txt"), "side\n");
        await git(root, "add", ".");
        await git(root, "commit", "-m", "side patch");
        await git(root, "checkout", "main");
        await git(root, "merge", "--no-ff", "--no-commit", "side");
        await fs.writeFile(path.join(root, "merge-only.txt"), "merge resolution\n");
        await git(root, "add", ".");
        await git(root, "commit", "-m", "merge with resolution");
      }
      const local = await git(root, "rev-parse", "HEAD");
      await git(root, "checkout", "--detach", beforeSha);
      if (mode === "conflict") {
        await fs.writeFile(path.join(remote, "patch.txt"), "upstream patch\n");
      }
      const target = await advanceRemote();
      const hooks = path.join(directory, "hooks");
      const detached = mode === "ref-failure" || mode === "detached-rollback";
      if (detached) {
        // Git cannot create children below an existing ref, a real preservation failure.
        await git(root, "update-ref", "refs/openclaw/update-preserved", local);
      }
      if (timedReplay) {
        const signer = path.join(directory, "blocked-signer.sh");
        await fs.writeFile(
          signer,
          `#!/bin/sh\nexec "${process.execPath}" -e 'setInterval(() => {}, 1000)'\n`,
          { mode: 0o700 },
        );
        if (mode === "early-timeout") {
          await fs.mkdir(hooks);
          await fs.copyFile(signer, path.join(hooks, "pre-rebase"));
        } else {
          await git(root, "config", "gpg.program", signer);
          await git(root, "config", "commit.gpgSign", "true");
        }
      }
      const replayDeadlines: (number | undefined)[] = [];
      const execute = runCommand;
      runCommand = async (argv, options) => {
        const replay = argv.includes("rebase") && !argv.includes("--abort");
        if (replay) {
          replayDeadlines.push(options.timeoutMs);
          if (timedReplay) {
            // Exercise the real process deadline without waiting ten minutes in CI.
            const command =
              mode === "early-timeout"
                ? [argv[0]!, "-c", `core.hooksPath=${hooks}`, ...argv.slice(1)]
                : argv;
            return execute(command, { ...options, timeoutMs: 1000 });
          }
        }
        if (
          (replay && mode === "interrupted") ||
          (mode === "ref-interrupted" &&
            argv.includes("update-ref") &&
            argv.some((arg) => arg.startsWith("refs/openclaw/update-preserved/main-"))) ||
          (mode === "probe-interrupted" &&
            options.cwd === root &&
            argv.includes("--no-lazy-fetch") &&
            argv.includes("rev-parse"))
        ) {
          // A real child exit with the standard interruption code, through the native runner.
          return runCommandWithTimeout([process.execPath, "-e", "process.exit(130)"], options);
        }
        if (mode === "abort-failure" && argv.includes("rebase") && argv.includes("--abort")) {
          return runCommandWithTimeout([process.execPath, "-e", "process.exit(1)"], options);
        }
        return execute(argv, options);
      };
      const rollback = mode === "rollback" || mode === "detached-rollback";
      const result = await update({
        ...(mode === "short-timeout" ? { timeoutMs: 30_000 } : {}),
        ...(rollback ? { runGitDoctor: async () => null } : {}),
      });
      if (
        mode === "interrupted" ||
        mode === "ref-interrupted" ||
        mode === "probe-interrupted" ||
        mode === "abort-failure"
      ) {
        expect(result.status).toBe("error");
        expect(await head()).toBe(beforeSha);
        expect(await git(root, "rev-parse", "main")).toBe(local);
        if (mode === "interrupted" || mode === "abort-failure") {
          expect(events).not.toContain("build");
        }
        return;
      }
      if (mode === "conflict") {
        expect(result).toMatchObject({ status: "skipped", reason: "already-current" });
        expect(fixture.stopped).toBe(false);
        expect(await head()).toBe(beforeSha);
        expect(replayDeadlines).toHaveLength(1);
        return;
      }
      if (rollback) {
        expect(result).toMatchObject({ status: "error", reason: "doctor-entry-missing" });
        expect(await head()).toBe(beforeSha);
        await expectRuntime(root, beforeSha);
      } else {
        expect(result.status, JSON.stringify(result.steps)).toBe("ok");
        if (timedReplay) {
          expect(await head()).toBe(target);
          expect(replayDeadlines).toEqual([mode === "short-timeout" ? 30_000 : 10 * 60_000]);
          expect(
            result.steps.some((step) => step.advisory?.message.includes("exceeded its deadline")),
          ).toBe(true);
        } else {
          expect(await fs.readFile(path.join(root, "patch.txt"), "utf8")).toBe("local patch\n");
          expect(await git(root, "merge-base", "--is-ancestor", target, "HEAD")).toBe("");
        }
      }
      if (detached) {
        expect(await git(root, "rev-parse", "--abbrev-ref", "HEAD")).toBe("HEAD");
        expect(await git(root, "rev-parse", "main")).toBe(local);
        expect(result.steps.some((step) => step.advisory?.message.includes("detached HEAD"))).toBe(
          true,
        );
      } else {
        const ref = `refs/openclaw/update-preserved/main-${local}`;
        expect(await git(root, "rev-parse", ref)).toBe(local);
        if (mode === "merge") {
          expect(await git(root, "show", `${ref}:merge-only.txt`)).toBe("merge resolution");
        }
        expect(
          await git(root, "for-each-ref", "--format=%(refname)", "refs/openclaw/update-preserved/"),
        ).toBe(ref);
      }
    },
  );
});
