import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  fixtureReceiptClientSource,
  openFixtureReceiptChannel,
  type FixtureReceiptChannel,
} from "../helpers/fixture-receipts.js";
import { withinTest } from "../helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const runner = join(process.cwd(), "scripts/pr-lib/process-group-runner.mjs");
const lockScript = join(process.cwd(), "scripts/pr-lib/operation-lock.sh");
const lockRef = "refs/openclaw/pr-operation-locks/42";
const describePosix = process.platform === "win32" ? describe.skip : describe;
let receipts: FixtureReceiptChannel;

function shellQuote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function createMaintenanceFixture(command: string, exitCode: number) {
  const root = realpathSync(tempDirs.make("openclaw-pr-git-maintenance-"));
  const home = join(root, "home");
  const repo = join(root, "repo");
  mkdirSync(home);
  mkdirSync(repo);
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "OpenClaw Test",
    GIT_AUTHOR_EMAIL: "test@example.invalid",
    GIT_COMMITTER_NAME: "OpenClaw Test",
    GIT_COMMITTER_EMAIL: "test@example.invalid",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "test.fromCount",
    GIT_CONFIG_VALUE_0: "preserved count value",
    GIT_CONFIG_PARAMETERS:
      "'maintenance.auto=true' 'gc.auto=1' 'maintenance.autoDetach=true' 'gc.autoDetach=true' 'test.fromParameters=value with spaces=kept'",
  };
  const git = (args: string[], input?: string) =>
    execFileSync("git", args, { cwd: repo, env, input, encoding: "utf8" }).trim();
  git(["init", "-q", "-b", "main"]);
  writeFileSync(join(repo, "base.txt"), "synthetic maintenance fixture\n");
  git(["add", "base.txt"]);
  git(["-c", "commit.gpgSign=false", "commit", "-qm", "base"]);
  git(["remote", "add", "origin", repo]);
  git(["fetch", "-q", "origin", "main"]);

  // Two tiny packs make auto-GC eligible; old unreachable objects exercise
  // the documented recentObjectsHook after maintenance's daemonization point.
  for (let index = 0; index < 2; index++) {
    const oid = git(["hash-object", "-w", "--stdin"], `unreachable fixture ${index}\n`);
    const packed = git(["pack-objects", join(repo, ".git/objects/pack/pack")], `${oid}\n`);
    for (const extension of ["pack", "idx"]) {
      utimesSync(join(repo, `.git/objects/pack/pack-${packed}.${extension}`), 1, 1);
    }
    utimesSync(join(repo, ".git/objects", oid.slice(0, 2), oid.slice(2)), 1, 1);
  }
  git(["config", "maintenance.strategy", "gc"]);
  git(["config", "gc.auto", "1"]);
  git(["config", "gc.autoPackLimit", "1"]);

  const ready = join(root, "maintenance-ready.json");
  const completed = join(root, "maintenance-completed");
  const hook = join(root, "recent-objects.mjs");
  writeFileSync(
    hook,
    [
      fixtureReceiptClientSource(receipts.endpoint),
      'import { execFileSync } from "node:child_process";',
      'import { existsSync, fstatSync, renameSync, writeFileSync } from "node:fs";',
      `const ready = ${JSON.stringify(ready)};`,
      "if (!existsSync(ready)) {",
      '  const pgid = Number(execFileSync("ps", ["-o", "pgid=", "-p", String(process.pid)], { encoding: "utf8" }).trim());',
      "  const notifierOpen = fstatSync(3).isSocket() || fstatSync(3).isFIFO();",
      '  writeFileSync(ready + ".pending", JSON.stringify({ pgid, notifierOpen }));',
      '  renameSync(ready + ".pending", ready);',
      '  sendReceipt(ready, "ready");',
      '  await awaitRelease(ready, "release");',
      `  writeFileSync(${JSON.stringify(completed)}, "complete\\n");`,
      "}",
    ].join("\n"),
  );
  git(["config", "gc.recentObjectsHook", `${shellQuote(process.execPath)} ${shellQuote(hook)}`]);

  const script = join(root, "operation.sh");
  writeFileSync(
    script,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      `source ${shellQuote(lockScript)}`,
      `repo_root() { printf '%s\\n' ${shellQuote(repo)}; }`,
      "acquire_pr_operation_lock 42",
      "begin_pr_operation_validation_phase",
      "mark_pr_operation_side_effects_started",
      'test "$(git config --get test.fromCount)" = "preserved count value"',
      'test "$(git config --get test.fromParameters)" = "value with spaces=kept"',
      command,
      `exit ${exitCode}`,
    ].join("\n"),
  );
  chmodSync(script, 0o755);
  return { repo, env, git, script, ready, completed };
}

describePosix("scripts/pr Git maintenance ownership", () => {
  beforeAll(async () => {
    receipts = await openFixtureReceiptChannel();
  });
  afterAll(async () => {
    await receipts.close();
  });
  it.for(["git fetch origin main", "git gc --auto"])(
    "suppresses automatic maintenance during %s",
    async (command, { signal }) => {
      const fixture = createMaintenanceFixture(command, 0);
      const config = readFileSync(join(fixture.repo, ".git/config"), "utf8");
      receipts.release(fixture.ready, "release");
      const child = spawn(process.execPath, [runner, fixture.repo, fixture.script], {
        cwd: fixture.repo,
        env: fixture.env,
        stdio: ["ignore", "ignore", "pipe"],
      });
      let stderr = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => (stderr += chunk));
      const closed = new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      });
      try {
        expect(await withinTest(closed, signal), stderr).toBe(0);
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
        }
        await closed;
      }
      expect(existsSync(fixture.ready)).toBe(false);
      expect(existsSync(fixture.completed)).toBe(false);
      expect(
        spawnSync("git", ["show-ref", "--verify", "--quiet", lockRef], {
          cwd: fixture.repo,
          env: fixture.env,
        }).status,
      ).toBe(1);
      expect(readFileSync(join(fixture.repo, ".git/config"), "utf8")).toBe(config);
      expect(fixture.git(["config", "--bool", "maintenance.auto"])).toBe("true");
      expect(fixture.git(["config", "--int", "gc.auto"])).toBe("1");
    },
  );

  it.for([
    { command: "git gc", exitCode: 0 },
    { command: "git gc", exitCode: 7 },
  ])(
    "joins $command before operation completion (exit $exitCode)",
    async ({ command, exitCode }, { signal }) => {
      const fixture = createMaintenanceFixture(command, exitCode);
      const child = spawn(process.execPath, [runner, fixture.repo, fixture.script], {
        cwd: fixture.repo,
        env: fixture.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stderr = "";
      child.stdout.resume();
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
      const closed = new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      });
      let ownerOid = "";
      try {
        await withinTest(
          Promise.race([
            receipts.waitFor(fixture.ready, "ready"),
            closed.then(() => {
              // The hook publishes this record before its receipt; separate pipes may reorder.
              expect(existsSync(fixture.ready), stderr).toBe(true);
            }),
          ]),
          signal,
        );
        ownerOid = fixture.git(["rev-parse", lockRef]);
        const owner = fixture.git(["cat-file", "blob", ownerOid]);
        const pgid = Number(/^pgid=(\d+)$/m.exec(owner)?.[1]);
        const hookState = JSON.parse(readFileSync(fixture.ready, "utf8")) as {
          pgid: number;
          notifierOpen: boolean;
        };
        expect(hookState.notifierOpen).toBe(true);
        expect(hookState.pgid).toBe(pgid);
        expect(child.exitCode).toBeNull();
        expect(existsSync(fixture.completed)).toBe(false);
        // A second operation cannot acquire the exact PR while maintenance is held.
        const probe = spawn(
          "bash",
          [
            "-c",
            `source ${shellQuote(lockScript)}; repo_root() { printf '%s\\n' ${shellQuote(fixture.repo)}; }; try_acquire_pr_operation_lock 42`,
          ],
          { cwd: fixture.repo, env: fixture.env, detached: true, stdio: "ignore" },
        );
        const probeClosed = new Promise<number | null>((resolve, reject) => {
          probe.once("error", reject);
          probe.once("close", resolve);
        });
        try {
          expect(await withinTest(probeClosed, signal)).toBe(1);
        } finally {
          if (probe.exitCode === null && probe.signalCode === null) {
            probe.kill("SIGKILL");
          }
          await probeClosed;
        }
        expect(fixture.git(["rev-parse", lockRef])).toBe(ownerOid);
      } finally {
        // The gate belongs to this fixture. Let Git finish and join it; no PID-based cleanup.
        receipts.release(fixture.ready, "release");
        await closed;
      }
      expect(child.exitCode, stderr).toBe(exitCode);
      expect(existsSync(fixture.completed)).toBe(true);
      expect(stderr).not.toContain("drain deadline");
      expect(stderr).not.toContain("process group remained active");
      // A joined maintenance failure drains like a clean exit, so both release the lock.
      expect(
        spawnSync("git", ["show-ref", "--verify", "--quiet", lockRef], {
          cwd: fixture.repo,
          env: fixture.env,
        }).status,
      ).toBe(1);
      if (exitCode !== 0) {
        expect(stderr).toContain(
          `Released the operation lock for PR #42 after exit code ${exitCode}`,
        );
      }
      expect(fixture.git(["config", "--bool", "maintenance.autoDetach"])).toBe("true");
      expect(fixture.git(["config", "--bool", "gc.autoDetach"])).toBe("true");
    },
  );
});
