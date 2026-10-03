import {
  execFileSync,
  spawn,
  spawnSync,
  type ChildProcess,
  type SpawnOptions,
} from "node:child_process";
import { once } from "node:events";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createVitestResourceOwner } from "../../scripts/lib/vitest-resource-ownership.mts";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import { createFixtureLifetime } from "../helpers/fixture-lifetime.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { assertFixtureProcessGroupStopped } from "./exited-descendant-reaper.test-support.js";
import { createMainRefreshFixture } from "./pr-main-refresh.test-support.js";
import { createProcessGroupTimingPreload } from "./pr-operation-lock.test-support.js";
import {
  copyPrWrapperSources,
  createIndependentPrFixtureEnv,
  linkPrWrapperDependencies,
} from "./pr-wrapper.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const escapedPipeHolderPidFiles = new Set<string>();
afterEach(async () => {
  const failures: unknown[] = [];
  for (const pidFile of escapedPipeHolderPidFiles) {
    try {
      await cleanupRecordedProcessGroup(pidFile);
    } catch (error) {
      failures.push(error);
    }
  }
  escapedPipeHolderPidFiles.clear();
  if (failures.length > 0) {
    throw new AggregateError(failures, "failed to clean up escaped notification-pipe holders");
  }
});
const repoRoot = process.cwd();
const commonScript = join(repoRoot, "scripts/pr-lib/common.sh");
const lockScript = join(repoRoot, "scripts/pr-lib/operation-lock.sh");
const processGroupRunner = join(repoRoot, "scripts/pr-lib/process-group-runner.mjs");
const managedChildUrl = pathToFileURL(join(repoRoot, "scripts/lib/managed-child-process.mts")).href;
const worktreeScript = join(repoRoot, "scripts/pr-lib/worktree.sh");
const lockRef = "refs/openclaw/pr-operation-locks/42";
const detachedChildren = new WeakSet<ChildProcess>();
const goneProcessGroups = new Set<number>();
let templateRepo = "";

function realpathSpecialFixtureWithNode(filePath: string): string {
  return execFileSync(
    resolveTestNodeExecPath(),
    ["--eval", 'process.stdout.write(require("node:fs").realpathSync(process.argv[1]))', filePath],
    { encoding: "utf8" },
  );
}

function spawnDetached(command: string, args: readonly string[], options: SpawnOptions = {}) {
  const child = spawn(command, args, {
    env: createIndependentPrFixtureEnv(),
    ...options,
    detached: true,
  });
  detachedChildren.add(child);
  if (child.pid) {
    goneProcessGroups.delete(child.pid);
  }
  return child;
}

function createPrFixtureEnv(homeDir: string, path: string): NodeJS.ProcessEnv {
  return {
    HOME: homeDir,
    XDG_CONFIG_HOME: join(homeDir, "config"),
    TMPDIR: homeDir,
    PATH: path,
    LC_ALL: "C",
    TZ: "UTC0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_ALLOW_PROTOCOL: "file",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "4",
    GIT_CONFIG_KEY_0: "core.hooksPath",
    GIT_CONFIG_VALUE_0: "/dev/null",
    GIT_CONFIG_KEY_1: "commit.gpgSign",
    GIT_CONFIG_VALUE_1: "false",
    GIT_CONFIG_KEY_2: "gc.auto",
    GIT_CONFIG_VALUE_2: "0",
    GIT_CONFIG_KEY_3: "maintenance.auto",
    GIT_CONFIG_VALUE_3: "false",
  };
}

function createTemplateRepo() {
  const dir = mkdtempSync(join(tmpdir(), "openclaw-pr-operation-lock-template-"));
  // This shared template must not inherit the operator's Git hooks or identity.
  const options = { cwd: dir, env: createPrFixtureEnv(dir, process.env.PATH ?? "") };
  execFileSync("git", ["init", "-q", "-b", "main"], options);
  writeFileSync(join(dir, ".git/info/exclude"), ".local/\n");
  execFileSync("git", ["config", "user.name", "OpenClaw Test"], options);
  execFileSync("git", ["config", "user.email", "test@openclaw.invalid"], options);
  // Copies retain these settings for later commands, not just template creation.
  for (const [key, value] of [
    ["core.hooksPath", "/dev/null"],
    ["commit.gpgSign", "false"],
    ["gc.auto", "0"],
    ["maintenance.auto", "false"],
  ]) {
    execFileSync("git", ["config", key!, value!], options);
  }
  writeFileSync(join(dir, "base.txt"), "base\n");
  execFileSync("git", ["add", "base.txt"], options);
  execFileSync("git", ["commit", "-qm", "base"], options);
  return dir;
}

beforeAll(() => {
  templateRepo = createTemplateRepo();
});

afterAll(() => {
  rmSync(templateRepo, { force: true, recursive: true });
});

function createRepo(nestedName?: string, tempRoot = tempDirs.make("openclaw-pr-operation-lock-")) {
  const dir = nestedName ? join(tempRoot, nestedName) : tempRoot;
  if (nestedName) {
    mkdirSync(dir);
  }
  // Preserve per-test Git isolation without paying five setup processes per fixture.
  cpSync(templateRepo, dir, { recursive: true });
  return dir;
}

function addTrackedUiConfig(repoDir: string) {
  const configDir = join(repoDir, "ui", "config");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "control-ui-chunking.ts"), "export const chunking = true;\n");
  execFileSync("git", ["add", "ui/config/control-ui-chunking.ts"], { cwd: repoDir });
  execFileSync("git", ["commit", "-qm", "add ui config"], { cwd: repoDir });
}

function setSparseCheckout(repoDir: string) {
  execFileSync("git", ["sparse-checkout", "init", "--no-cone"], { cwd: repoDir });
  execFileSync("git", ["sparse-checkout", "set", "--no-cone", "--stdin"], {
    cwd: repoDir,
    input: "/*\n!/*/\n/base.txt\n",
  });
}

function enterPrWorktree(repoDir: string, pr: number) {
  const result = runLockShell(repoDir, [
    "ensure_gh_api_auth() { return 0; }",
    // The provisioner suite owns allocation/config/template proof. Keep these
    // shell registration, branch-reset, and sparse checks on a real Git checkout.
    "provision_pr_worktree() {",
    '  command git -C "$1" worktree add -- "$1/.worktrees/pr-$2" "temp/pr-$2"',
    "}",
    // Entry and cleanup still run under the real per-PR lock.
    `acquire_pr_operation_lock ${pr}`,
    "trap release_pr_operation_lock EXIT",
    `enter_worktree ${pr}`,
  ]);
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  return { result, worktreeDir: join(repoDir, ".worktrees", `pr-${pr}`) };
}

function expectWorktreeBranch(worktreeDir: string, branch: string) {
  expect(gitOutput(worktreeDir, ["branch", "--show-current"]).trim()).toBe(branch);
  const tips = gitOutput(worktreeDir, ["rev-parse", "HEAD", "main"]).trim().split("\n");
  expect(tips[0]).toBe(tips[1]);
}

function expectMaterializedWorktree(worktreeDir: string) {
  expect(existsSync(join(worktreeDir, "ui", "config", "control-ui-chunking.ts"))).toBe(true);
  expect(gitOutput(worktreeDir, ["config", "--bool", "core.sparseCheckout"]).trim()).toBe("false");
}

function bashSource(repoDir: string) {
  return [
    "set -euo pipefail",
    `source '${worktreeScript}'`,
    `source '${lockScript}'`,
    `source '${commonScript}'`,
    `repo_root() { printf '%s\\n' '${repoDir}'; }`,
  ];
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/gu, `'\\''`)}'`;
}

function writeFixtureFile(repoDir: string, name: string, contents: string | readonly string[]) {
  const fixture = join(repoDir, name);
  writeFileSync(fixture, typeof contents === "string" ? contents : contents.join("\n"));
  return fixture;
}

function writeOperationFixture(repoDir: string, name: string, commands: string[]) {
  const fixture = writeFixtureFile(
    repoDir,
    name,
    ["#!/usr/bin/env bash", ...bashSource(repoDir), ...commands].join("\n"),
  );
  chmodSync(fixture, 0o755);
  return fixture;
}

function writeEscapedPipeHolderLauncher(repoDir: string, pidFile: string) {
  const holderScript = writeFixtureFile(
    repoDir,
    "escaped-pipe-holder.mjs",
    "setInterval(() => {}, 1000);\n",
  );
  return writeFixtureFile(repoDir, "escaped-pipe-holder-launcher.mjs", [
    'import { spawn } from "node:child_process";',
    'import fs from "node:fs";',
    `const child = spawn(process.execPath, [${JSON.stringify(holderScript)}], {`,
    "  detached: true,",
    '  stdio: ["ignore", "ignore", "ignore", 3],',
    "});",
    `fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));`,
    "child.unref();",
  ]);
}

function installPrCliFixture(repoDir: string, env?: NodeJS.ProcessEnv) {
  const wrapperSources = copyPrWrapperSources(repoDir);
  const cli = join(repoDir, "scripts/pr");
  chmodSync(cli, 0o755);
  const binDir = join(repoDir, "isolated-bin");
  mkdirSync(binDir);
  for (const command of ["bash", "basename", "dirname", "git"]) {
    const resolved = execFileSync("which", [command], { encoding: "utf8", env }).trim();
    symlinkSync(resolved, join(binDir, command));
  }
  return { binDir, cli, wrapperSources };
}

function installRequiredPrCommandStubs(binDir: string) {
  for (const command of ["gh", "jq", "pnpm", "rg"]) {
    const stub = join(binDir, command);
    writeFileSync(stub, "#!/bin/sh\nexit 0\n");
    chmodSync(stub, 0o755);
  }
}

interface SupervisedFixtureOptions {
  accelerateTimeouts?: boolean;
  env?: NodeJS.ProcessEnv;
}

async function runSupervisedFixture(
  repoDir: string,
  fixture: string,
  options: SupervisedFixtureOptions = {},
) {
  // Entry bookkeeping is fixture-owned, not an untracked checkout transition input.
  const entryDir = tempDirs.make("openclaw-pr-supervised-entry-");
  const groupFile = writeFixtureFile(entryDir, "supervised-fixture.pgid", "");
  const entry = writeFixtureFile(entryDir, "supervised-fixture-entry.sh", [
    "#!/usr/bin/env bash",
    `printf '%s\\n' "$$" > ${shellQuote(groupFile)}`,
    `exec ${shellQuote(fixture)}`,
  ]);
  chmodSync(entry, 0o755);
  const controller = spawn(
    process.execPath,
    [
      ...(options.accelerateTimeouts
        ? [
            "--require",
            createProcessGroupTimingPreload(tempDirs.make("openclaw-pr-operation-lock-timing-")),
          ]
        : []),
      processGroupRunner,
      repoDir,
      entry,
    ],
    {
      cwd: repoDir,
      env: { ...createIndependentPrFixtureEnv(), ...options.env },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  controller.stdout!.setEncoding("utf8");
  controller.stderr!.setEncoding("utf8");
  controller.stdout!.on("data", (chunk) => (stdout += chunk));
  controller.stderr!.on("data", (chunk) => (stderr += chunk));
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        controller.off("close", onClose);
        reject(new Error(`controller did not close within 15000ms (${childStatus(controller)})`));
      }, 15_000);
      const onClose = () => {
        clearTimeout(timeout);
        resolve();
      };
      controller.once("close", onClose);
    });
  } catch (error) {
    const failures: unknown[] = [error];
    // The runner forwards termination even when its child has not acquired a lock.
    controller.kill("SIGTERM");
    try {
      const pgid = readProcessIdFile(groupFile);
      if (pgid) {
        await cleanupProcessGroup(pgid);
      }
    } catch (cleanupError) {
      failures.push(cleanupError);
    }
    try {
      await waitForExit(controller, 2000);
    } catch (cleanupError) {
      failures.push(cleanupError);
    } finally {
      if (controller.exitCode === null && controller.signalCode === null) {
        controller.kill("SIGKILL");
      }
      try {
        await waitForExit(controller, 2000);
        await cleanupRecordedProcessGroup(groupFile);
      } catch (cleanupError) {
        failures.push(cleanupError);
      }
    }
    throw new AggregateError(failures, "supervised fixture did not settle", { cause: error });
  }
  return { status: controller.exitCode, signal: controller.signalCode, stdout, stderr };
}

function runSupervisedOperation(
  repoDir: string,
  name: string,
  commands: string[],
  options?: SupervisedFixtureOptions,
) {
  return runSupervisedFixture(repoDir, writeOperationFixture(repoDir, name, commands), options);
}

function runLockShell(
  repoDir: string,
  commands: string[],
  parentEnv: NodeJS.ProcessEnv = process.env,
) {
  return spawnSync("bash", ["-c", [...bashSource(repoDir), ...commands].join("\n")], {
    cwd: repoDir,
    env: createIndependentPrFixtureEnv(parentEnv),
    detached: true,
    encoding: "utf8",
    timeout: 10_000,
  } as { cwd: string; encoding: "utf8"; timeout: number });
}

function probeOperationLock(repoDir: string, command: "blocking" | "try" = "try") {
  return runLockShell(repoDir, [
    "set +e",
    command === "try" ? "try_acquire_pr_operation_lock 42" : "acquire_pr_operation_lock 42",
    "lock_status=$?",
    "set -e",
    'printf "%s\\n" "$lock_status"',
  ]);
}

function recoverOperationLock(repoDir: string, ownerOid: string, commands: string[] = []) {
  const result = runLockShell(repoDir, [
    `recover_pr_operation_lock 42 '${ownerOid}' --confirmed-no-running-tools`,
    ...commands,
  ]);
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  expect(refExists(repoDir)).toBe(false);
}

function spawnHolder(repoDir: string, statusFile: string, pr = 42, trapTerm = true) {
  const traps = trapTerm
    ? [
        "trap release_pr_operation_lock EXIT",
        "trap 'exit 129' HUP",
        "trap 'exit 130' INT",
        "trap 'exit 143' TERM",
      ]
    : [];
  return spawnDetached(
    "bash",
    [
      "-c",
      [
        ...bashSource(repoDir),
        ...traps,
        `acquire_pr_operation_lock ${pr}`,
        `printf 'held\\n' >'${statusFile}'`,
        "while :; do sleep 1; done",
      ].join("\n"),
    ],
    { cwd: repoDir, stdio: "ignore" },
  );
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return true;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 5);
    });
  }
  return false;
}

function validProcessId(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 1 && Number(value) <= 0x7fffffff;
}

function readProcessIdFile(path: string) {
  if (!existsSync(path)) {
    return undefined;
  }
  const value = Number(readFileSync(path, "utf8").trim());
  return validProcessId(value) ? value : undefined;
}

async function waitForProcessId(path: string) {
  let pid: number | undefined;
  const ready = await waitFor(() => {
    pid = readProcessIdFile(path);
    return pid !== undefined;
  });
  if (!ready || pid === undefined) {
    throw new Error(`process id was not written to ${path}`);
  }
  goneProcessGroups.delete(pid);
  return pid;
}

function childStatus(child: ChildProcess) {
  return `pid=${child.pid ?? "unknown"} exit=${child.exitCode ?? "null"} signal=${child.signalCode ?? "null"}`;
}

async function waitForExit(child: ChildProcess, timeoutMs = 5000) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const onExit = () => {
      clearTimeout(timeout);
      resolve();
    };
    const timeout = setTimeout(() => {
      child.off("exit", onExit);
      reject(new Error(`child did not exit within ${timeoutMs}ms (${childStatus(child)})`));
    }, timeoutMs);
    child.once("exit", onExit);
    if (child.exitCode !== null || child.signalCode !== null) {
      child.off("exit", onExit);
      clearTimeout(timeout);
      resolve();
    }
  });
}

async function stopChild(child: ChildProcess, signal: NodeJS.Signals) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  signalTestChild(child, signal);
  await waitForExit(child);
}

async function cleanupChildren(...children: Array<ChildProcess | undefined>) {
  const failures: unknown[] = [];
  for (const child of children) {
    if (!child) {
      continue;
    }
    try {
      if (child.exitCode === null && child.signalCode === null) {
        signalTestChild(child, "SIGKILL");
        await waitForExit(child, 2000);
      }
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "failed to clean up operation-lock test children");
  }
}

function signalTestChild(child: ChildProcess, signal: NodeJS.Signals) {
  if (detachedChildren.has(child) && child.pid) {
    try {
      killProcessGroup(child.pid, signal);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ESRCH" && code !== "EPERM") {
        throw error;
      }
    }
  }
  child.kill(signal);
}

async function cleanupProcessGroup(pgid: number) {
  if (!processGroupExists(pgid)) {
    return;
  }
  try {
    killProcessGroup(pgid, "SIGKILL");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH" || code === "EPERM") {
      return;
    }
    throw error;
  }
  if (!(await waitFor(() => !processGroupExists(pgid), 2000))) {
    throw new Error(`process group ${pgid} did not exit during cleanup`);
  }
}

async function cleanupRecordedProcessGroup(path: string, pgid?: number) {
  const recordedPgid = pgid ?? readProcessIdFile(path);
  if (recordedPgid) {
    await cleanupProcessGroup(recordedPgid);
  }
}

function readOperationProcessGroup(repoDir: string, env?: NodeJS.ProcessEnv) {
  if (!refExists(repoDir, lockRef, env)) {
    return undefined;
  }
  try {
    const payload = execFileSync("git", ["cat-file", "blob", refOid(repoDir, lockRef, env)], {
      cwd: repoDir,
      encoding: "utf8",
      env,
    });
    const pgid = Number(/^version=3\nstate=active\npgid=([1-9][0-9]*)\n/u.exec(payload)?.[1]);
    return validProcessId(pgid) ? pgid : undefined;
  } catch {
    return undefined;
  }
}

async function cleanupController(
  repoDir: string,
  controller: ChildProcess,
  operationPgidFile?: string,
  env?: NodeJS.ProcessEnv,
) {
  let pgid = operationPgidFile ? readProcessIdFile(operationPgidFile) : undefined;
  pgid ??= readOperationProcessGroup(repoDir, env);
  if (pgid) {
    await cleanupProcessGroup(pgid);
  }
  await cleanupChildren(controller);
  pgid = operationPgidFile ? readProcessIdFile(operationPgidFile) : undefined;
  pgid ??= readOperationProcessGroup(repoDir, env);
  if (pgid) {
    await cleanupProcessGroup(pgid);
  }
}

function gitOutput(repoDir: string, args: string[]) {
  return execFileSync("git", args, { cwd: repoDir, encoding: "utf8" });
}

function gitStatus(repoDir: string, args: string[]) {
  return spawnSync("git", args, { cwd: repoDir }).status;
}

function refOid(repoDir: string, ref = lockRef, env?: NodeJS.ProcessEnv) {
  return execFileSync("git", ["rev-parse", ref], { cwd: repoDir, encoding: "utf8", env }).trim();
}

function refExists(repoDir: string, ref = lockRef, env?: NodeJS.ProcessEnv) {
  return (
    spawnSync("git", ["show-ref", "--verify", "--quiet", ref], {
      cwd: repoDir,
      env,
    }).status === 0
  );
}

function processGroupExists(pgid: number) {
  if (!validProcessId(pgid)) {
    throw new Error(`refusing to probe invalid process group ${String(pgid)}`);
  }
  if (goneProcessGroups.has(pgid)) {
    return false;
  }
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // Fixtures never change identity. EPERM therefore means the original
    // group exited and its numeric PGID now belongs to another user.
    if (code === "ESRCH" || code === "EPERM") {
      goneProcessGroups.add(pgid);
      return false;
    }
    throw error;
  }
}

function killProcessGroup(pgid: number, signal: NodeJS.Signals) {
  if (!validProcessId(pgid)) {
    throw new Error(`refusing to signal invalid process group ${String(pgid)}`);
  }
  if (!goneProcessGroups.has(pgid)) {
    process.kill(-pgid, signal);
  }
}

describe("scripts/pr process-group platform guard", () => {
  it("keeps native Windows on the explicit WSL-only path", () => {
    const source = readFileSync(processGroupRunner, "utf8");
    expect(source).toContain('process.platform === "win32"');
    expect(source).toContain("use WSL on Windows");
    expect(source).toContain("const SIGNAL_GRACE_MS = 5000;");
    expect(source).toContain("const KILL_DRAIN_MS = 5000;");
    if (process.platform !== "win32") {
      return;
    }
    const result = spawnSync(process.execPath, [processGroupRunner, repoRoot, "unused"], {
      encoding: "utf8",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("use WSL on Windows");
  });
  it.runIf(process.platform !== "win32")(
    "preserves the child status when the completion marker cannot be written",
    async () => {
      const repoDir = createRepo();
      const fixture = writeFixtureFile(repoDir, "closed-completion-fd.sh", [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        `source '${lockScript}'`,
        "exit 7",
      ]);
      chmodSync(fixture, 0o755);
      const child = spawnDetached("bash", [fixture], {
        cwd: repoDir,
        env: {
          ...createIndependentPrFixtureEnv(),
          OPENCLAW_PR_DEDICATED_PROCESS_GROUP: "1",
          OPENCLAW_PR_LOCK_NOTIFY_FD: "3",
          OPENCLAW_PR_LOCK_SUPERVISOR_PID: String(process.pid),
        },
        stdio: "ignore",
      });
      try {
        await waitForExit(child);
        expect(child.exitCode).toBe(7);
      } finally {
        await cleanupChildren(child);
      }
    },
  );
});

const describePosix = process.platform === "win32" ? describe.skip : describe;
describePosix("scripts/pr per-PR operation lock", () => {
  it("isolates independent fixtures from inherited maintainer bindings", () => {
    const repoDir = createRepo();
    const result = runLockShell(
      repoDir,
      [
        'test -z "${OPENCLAW_PR_GIT-}"',
        'test -z "${GIT_EXEC-}"',
        'test -z "${OPENCLAW_PR_GITHUB_SNAPSHOT_ROOT-}"',
        'test -z "${OPENCLAW_PR_LOCK_NOTIFY_FD-}"',
        'test -z "${OPENCLAW_PR_LOCK_SUPERVISOR_PID-}"',
        "acquire_pr_operation_lock 42",
        'git rev-parse --verify "' + lockRef + '"',
        "release_pr_operation_lock",
      ],
      {
        ...process.env,
        OPENCLAW_PR_GIT: "/bin/false",
        GIT_EXEC: "/bin/false",
        OPENCLAW_PR_GITHUB_SNAPSHOT_ROOT: tempDirs.make("unrelated-lock-snapshot-"),
        OPENCLAW_PR_LOCK_NOTIFY_FD: "3",
        OPENCLAW_PR_LOCK_SUPERVISOR_PID: "1",
      },
    );
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout.trim()).toMatch(/^[0-9a-f]{40}$/);
    const after = spawnSync("git", ["show-ref", "--verify", "--quiet", lockRef], {
      cwd: repoDir,
      encoding: "utf8",
    });
    expect(after.status, after.stderr).toBe(1);
  });

  it.each([
    ["ls-files --others --exclude-standard -z", "require_no_foreign_untracked"],
    ["ls-files --others --ignored --exclude-standard -z", "require_no_ignored_transition_paths"],
    ["ls-tree -r -z", "validate_review_transition_state"],
  ])("rejects failed %s reads in %s", (query, guard) => {
    const repoDir = createRepo();
    const head = refOid(repoDir, "HEAD");
    writeFileSync(join(repoDir, "base.txt"), "target\n");
    execFileSync("git", ["commit", "-qam", "target fixture"], { cwd: repoDir });
    const target = refOid(repoDir, "HEAD");
    execFileSync("git", ["checkout", "--detach", head], { cwd: repoDir });
    const binDir = tempDirs.make("openclaw-pr-query-failure-");
    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    const proxy = writeFixtureFile(binDir, "git", [
      "#!/usr/bin/env bash",
      'args=("$@")',
      'while [ "${1:-}" = -c ]; do shift 2; done',
      `case "$*" in ${JSON.stringify(query)}*) echo 'fixture query failed' >&2; exit 7 ;; esac`,
      `exec '${realGit}' "\${args[@]}"`,
    ]);
    chmodSync(proxy, 0o755);
    const result = runLockShell(repoDir, [
      `export PATH='${binDir}':"$PATH"`,
      `${guard} 42 ${head} ${target} || exit $?`,
    ]);
    expect(result.stderr).toContain("fixture query failed");
    expect(result.status, result.stdout + result.stderr).not.toBe(0);
  });

  it.each(["review-init", "review-claim"])(
    "releases %s after authentication fails without changing prior artifacts",
    (command) => {
      const f = createMainRefreshFixture(tempDirs.make("openclaw-pr-auth-failure-"));
      const artifacts = () =>
        readdirSync(f.local)
          .toSorted()
          .map((name) => [name, readFileSync(join(f.local, name), "utf8")]);
      const refs = f.git(f.canonical, "show-ref");
      const priorArtifacts = artifacts();
      f.configure({ failAuth: true });
      const result = f.run(command);
      expect(result.status, result.stdout + result.stderr).toBe(1);
      expect(result.stderr).toContain("GitHub API preflight failed");
      expect(f.events().some((event) => event.kind === "main-fetch")).toBe(false);
      expect(f.git(f.canonical, "show-ref")).toBe(refs);
      expect(f.git(f.canonical, "rev-parse", "HEAD")).toBe(f.main);
      expect(f.git(f.worktree, "rev-parse", "HEAD")).toBe(f.head);
      expect(f.git(f.canonical, "diff", "--exit-code")).toBe("");
      expect(f.git(f.worktree, "diff", "--exit-code")).toBe("");
      expect(artifacts()).toEqual(priorArtifacts);
      expect(f.git(f.canonical, "for-each-ref", "refs/openclaw/pr-operation-locks")).toBe("");
      expect(result.stderr).not.toContain("Retaining the operation lock");
    },
  );
  it("makes an exact-OID late release harmless after a successor acquires", async () => {
    const repoDir = createRepo();
    const firstHeld = join(repoDir, "first-held");
    const first = spawnHolder(repoDir, firstHeld, 42, false);
    let second: ChildProcess | undefined;
    try {
      expect(await waitFor(() => existsSync(firstHeld))).toBe(true);
      const oldOid = refOid(repoDir);
      await stopChild(first, "SIGKILL");
      expect(await waitFor(() => !processGroupExists(first.pid!))).toBe(true);
      recoverOperationLock(repoDir, oldOid);
      const secondHeld = join(repoDir, "second-held");
      second = spawnHolder(repoDir, secondHeld);
      expect(await waitFor(() => existsSync(secondHeld))).toBe(true);
      const successorOid = refOid(repoDir);
      const lateRelease = runLockShell(repoDir, [
        `PR_OPERATION_LOCK_REF='${lockRef}'`,
        `PR_OPERATION_LOCK_OWNER_OID='${oldOid}'`,
        "release_pr_operation_lock",
      ]);
      expect(lateRelease.status, `${lateRelease.stdout}\\n${lateRelease.stderr}`).toBe(0);
      expect(refOid(repoDir)).toBe(successorOid);
    } finally {
      await cleanupChildren(second, first);
    }
  });
  it("requires confirmation and the current exact OID for recovery", async () => {
    const repoDir = createRepo();
    const held = join(repoDir, "held");
    const holder = spawnHolder(repoDir, held, 42, false);
    try {
      expect(await waitFor(() => existsSync(held))).toBe(true);
      const ownerOid = refOid(repoDir);
      const wrongOid = gitOutput(repoDir, ["rev-parse", "HEAD"]).trim();
      const unconfirmed = runLockShell(repoDir, [
        "set +e",
        `recover_pr_operation_lock 42 '${ownerOid}'`,
        "recovery_status=$?",
        "set -e",
        'printf "%s\\n" "$recovery_status"',
      ]);
      expect(unconfirmed.status).toBe(0);
      expect(unconfirmed.stdout.trim()).toBe("2");
      expect(unconfirmed.stderr).toContain("Recovery requires --confirmed-no-running-tools");
      expect(refOid(repoDir)).toBe(ownerOid);
      const wrongOwner = runLockShell(repoDir, [
        "set +e",
        `recover_pr_operation_lock 42 '${wrongOid}' --confirmed-no-running-tools`,
        "recovery_status=$?",
        "set -e",
        'printf "%s\\n" "$recovery_status"',
      ]);
      expect(wrongOwner.status).toBe(0);
      expect(wrongOwner.stdout.trim()).toBe("1");
      expect(refOid(repoDir)).toBe(ownerOid);
    } finally {
      await cleanupChildren(holder);
    }
  });
  it("preserves a successor when recovery loses its exact-OID CAS", () => {
    const repoDir = createRepo();
    const result = runLockShell(repoDir, [
      "owner_oid=$(printf 'owner-lock\\n' | git hash-object -w --stdin)",
      "successor_oid=$(printf 'successor-lock\\n' | git hash-object -w --stdin)",
      `git update-ref '${lockRef}' "$owner_oid"`,
      "pr_git() {",
      `  if [ "$*" = "-C ${repoDir} update-ref --no-deref -d ${lockRef} $owner_oid" ]; then`,
      `    command git -C '${repoDir}' update-ref '${lockRef}' "$successor_oid" "$owner_oid"`,
      "    return 1",
      "  fi",
      '  command git "$@"',
      "}",
      "set +e",
      'recover_pr_operation_lock 42 "$owner_oid" --confirmed-no-running-tools',
      "recovery_status=$?",
      "set -e",
      `printf '%s\\t%s\\n' "$recovery_status" "$(command git rev-parse '${lockRef}')"`,
    ]);
    const successorOid = execFileSync("git", ["hash-object", "--stdin"], {
      cwd: repoDir,
      input: "successor-lock\n",
      encoding: "utf8",
    }).trim();
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout.trim()).toBe(`1\t${successorOid}`);
    expect(result.stderr).toContain("owner changed during recovery");
  });
  it("runs lock recovery without the normal PR toolchain", () => {
    const repoDir = createRepo();
    const inheritedAnchor = createRepo();
    const { binDir, cli } = installPrCliFixture(repoDir);
    const ownerOid = gitOutput(repoDir, ["rev-parse", "HEAD"]).trim();
    execFileSync("git", ["update-ref", lockRef, ownerOid], { cwd: repoDir });
    execFileSync("git", ["update-ref", lockRef, ownerOid], { cwd: inheritedAnchor });
    const anchorRefs = gitOutput(inheritedAnchor, ["show-ref"]);
    const result = spawnSync(
      cli,
      ["lock-recover", "42", ownerOid, "--confirmed-no-running-tools"],
      {
        cwd: repoDir,
        encoding: "utf8",
        env: {
          ...createIndependentPrFixtureEnv({
            ...process.env,
            OPENCLAW_PR_ANCHOR_REPO_ROOT: inheritedAnchor,
            OPENCLAW_PR_TOOLING_ROOT: inheritedAnchor,
          }),
          PATH: binDir,
        },
      },
    );
    expect(gitOutput(inheritedAnchor, ["show-ref"])).toBe(anchorRefs);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout.trim()).toBe("Recovered the stale operation lock for PR #42.");
    expect(refExists(repoDir)).toBe(false);
  });
  it("does not trust an ambient dedicated-process-group marker", () => {
    const repoDir = createRepo();
    const { binDir, cli } = installPrCliFixture(repoDir);
    const reviewScript = join(repoDir, "scripts/pr-lib/review.sh");
    writeFileSync(reviewScript, `${readFileSync(reviewScript, "utf8")}\nreview_init() { :; }\n`);
    installRequiredPrCommandStubs(binDir);
    const env: NodeJS.ProcessEnv = {
      ...createIndependentPrFixtureEnv(),
      OPENCLAW_PR_DEDICATED_PROCESS_GROUP: "1",
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
    };
    const result = spawnSync(cli, ["review-init", "42"], {
      cwd: repoDir,
      encoding: "utf8",
      env,
    });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(refExists(repoDir)).toBe(false);
  });
  it("releases a validation-phase lock when temporary storage is unavailable", () => {
    const repoDir = createRepo();
    const { binDir, cli } = installPrCliFixture(repoDir);
    const reviewScript = join(repoDir, "scripts/pr-lib/review.sh");
    writeFileSync(
      reviewScript,
      `${readFileSync(reviewScript, "utf8")}\nreview_init() { printf 'review ran\\n'; }\n`,
    );
    installRequiredPrCommandStubs(binDir);
    const mktempStub = join(binDir, "mktemp");
    writeFileSync(mktempStub, "#!/bin/sh\necho 'mktemp: No space left on device' >&2\nexit 1\n");
    chmodSync(mktempStub, 0o755);

    const result = spawnSync(cli, ["review-init", "42"], {
      cwd: repoDir,
      encoding: "utf8",
      env: { ...createIndependentPrFixtureEnv(), PATH: `${binDir}:${process.env.PATH ?? ""}` },
    });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(1);
    expect(result.stderr).toContain("mktemp: No space left on device");
    expect(result.stderr).toContain("temporary-storage preflight failed");
    expect(result.stderr).toContain("Free disk space or set TMPDIR");
    expect(result.stderr).not.toContain("Retaining the operation lock");
    expect(result.stderr).not.toContain("scripts/pr lock-recover");
    expect(result.stdout).not.toContain("review ran");
    expect(refExists(repoDir)).toBe(false);
  });
  it("releases a validation-phase lock when review-init metadata fails", () => {
    const repoDir = createRepo();
    const { binDir, cli } = installPrCliFixture(repoDir);
    const reviewScript = join(repoDir, "scripts/pr-lib/review.sh");
    writeFileSync(
      reviewScript,
      `${readFileSync(reviewScript, "utf8")}\nenter_worktree() { printf 'entered-worktree\\n'; }\npr_meta_json() { echo 'fixture metadata failure' >&2; return 1; }\n`,
    );
    installRequiredPrCommandStubs(binDir);

    const result = spawnSync(cli, ["review-init", "42"], {
      cwd: repoDir,
      encoding: "utf8",
      env: { ...createIndependentPrFixtureEnv(), PATH: `${binDir}:${process.env.PATH ?? ""}` },
    });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(1);
    expect(refExists(repoDir), result.stderr).toBe(false);
    expect(result.stderr).toContain("fixture metadata failure");
    expect(result.stderr).not.toContain("Retaining the operation lock");
    expect(result.stderr).not.toContain("scripts/pr lock-recover");
    expect(result.stdout).not.toContain("entered-worktree");
  });
  it("retries when the prior owner releases between failed create CAS and ref read", () => {
    const repoDir = createRepo();
    const raceTriggered = join(repoDir, "race-triggered");
    const result = runLockShell(repoDir, [
      "prepare_pr_operation_lock_candidate 99",
      "old_oid=$PR_OPERATION_LOCK_CANDIDATE_OID",
      `git update-ref '${lockRef}' "$old_oid"`,
      "pr_git() {",
      `  if [ ! -e '${raceTriggered}' ] && [[ "$*" == *"rev-parse --verify ${lockRef}"* ]]; then`,
      `    : >'${raceTriggered}'`,
      `    command git -C '${repoDir}' update-ref --no-deref -d '${lockRef}' "$old_oid"`,
      "    return 1",
      "  fi",
      '  command git "$@"',
      "}",
      "acquire_pr_operation_lock 42",
      "release_pr_operation_lock",
    ]);
    expect(result.status).toBe(0);
    expect(existsSync(raceTriggered)).toBe(true);
  });
  it("retries when the finishing supervisor releases before an orphan verdict", () => {
    const repoDir = createRepo();
    const result = runLockShell(repoDir, [
      "prepare_pr_operation_lock_candidate 42",
      "stale_oid=$(printf 'version=3\\nstate=active\\npgid=2147483647\\nsupervisor_pid=2147483647\\nsupervisor_birth=Mon Jan 1 00:00:00 1900\\ntoken=11111111-1111-1111-1111-111111111111\\n' | git hash-object -w --stdin)",
      `git update-ref '${lockRef}' "$stale_oid"`,
      "pr_operation_lock_process_group_status() {",
      `  command git -C '${repoDir}' update-ref --no-deref -d '${lockRef}' "$stale_oid"`,
      "  printf 'dead\\n'",
      "}",
      "pr_operation_lock_process_identity() { return 1; }",
      "try_acquire_pr_operation_lock 42",
      "release_pr_operation_lock",
    ]);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(refExists(repoDir)).toBe(false);
  });
  it("rejects noncanonical aliases for the same PR number", () => {
    const repoDir = createRepo();
    const result = runLockShell(repoDir, [
      "set +e",
      "try_acquire_pr_operation_lock 00042",
      "lock_status=$?",
      "pr_number_from_worktree_dir .worktrees/pr-00042 >/dev/null",
      "parse_status=$?",
      "set -e",
      'printf "%s\t%s\n" "$lock_status" "$parse_status"',
    ]);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("2\t1");
  });
  it.each([
    {
      title: "releases a failed lock while the child is still in validation phase",
      fixture: "failed-validation.sh",
      commands: ["acquire_pr_operation_lock 42", "begin_pr_operation_validation_phase", "exit 3"],
      status: 3,
      retained: false,
    },

    {
      title: "does not re-enter validation after side effects have started",
      fixture: "failed-after-forged-validation.sh",
      commands: [
        "acquire_pr_operation_lock 42",
        "begin_pr_operation_validation_phase",
        "mark_pr_operation_side_effects_started",
        "notify_pr_operation_phase validation-started",
        "exit 3",
      ],
      status: 3,
      retained: true,
    },

    {
      title: "retains a validation-phase lock for untrapped signal exit statuses",
      fixture: "killed-validation.sh",
      commands: ["acquire_pr_operation_lock 42", "begin_pr_operation_validation_phase", "exit 137"],
      status: 137,
      retained: true,
    },
  ])("$title", async ({ fixture, commands, status, retained }) => {
    const repoDir = createRepo();
    const result = await runSupervisedOperation(repoDir, fixture, commands);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(status);
    if (retained) {
      const ownerOid = refOid(repoDir);
      expect(result.stderr).toContain(`reason: child exited with code ${status}`);
      recoverOperationLock(repoDir, ownerOid);
    } else {
      expect(refExists(repoDir)).toBe(false);
      expect(result.stderr).not.toContain("Retaining the operation lock");
    }
  });
  it.each([false, true])(
    "cleans linked GC worktrees before exact-owner release (failure=%s)",
    (failure) => {
      const repoDir = createRepo();
      const { binDir, wrapperSources } = installPrCliFixture(repoDir);
      const rg = writeFixtureFile(binDir, "rg", [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        'if [ "$#" -ne 4 ] || [ "$1" != "-n" ] || [ "$2" != "-i" ]; then',
        '  echo "unexpected fixture rg call: $*" >&2',
        "  exit 99",
        "fi",
        'exec grep -n -i -E -- "$3" "$4"',
      ]);
      chmodSync(rg, 0o755);
      linkPrWrapperDependencies(repoDir);
      const git = (...args: string[]) => gitOutput(repoDir, args).trim();
      const lifecycle = join(repoDir, "lifecycle.log");
      const ownerFile = join(repoDir, "owner-oid");
      const releaseCwd = join(repoDir, "release-cwd");
      const refLock = join(repoDir, ".git/refs/openclaw/pr-operation-locks/42.lock");
      git("config", "core.filesRefLockTimeout", "0");
      git("add", "--", ...wrapperSources);
      git("commit", "-qm", "test: native cleanup fixture");
      const preparedHead = git("rev-parse", "HEAD");
      const origin = tempDirs.make("openclaw-pr-cleanup-origin-");
      git("init", "--bare", "-q", origin);
      git("remote", "add", "origin", origin);
      git("push", "-q", "origin", preparedHead + ":refs/heads/main");
      git("fetch", "-q", "origin", "refs/heads/main:refs/remotes/origin/main");
      const worktrees = [42, 43].map((pr) => {
        const path = join(repoDir, ".worktrees", "pr-" + pr);
        git("worktree", "add", "-q", "-b", "temp/pr-" + pr, path);
        for (const branch of ["pr-" + pr, "pr-" + pr + "-prep"]) {
          git("branch", branch);
        }
        return { pr, path, admin: git("-C", path, "rev-parse", "--absolute-git-dir") };
      });
      // The linked wrapper must remain selected after its own source directory is removed.
      const fixtureWorktreeScript = join(repoDir, "scripts/pr-lib/worktree.sh");
      writeFileSync(
        fixtureWorktreeScript,
        readFileSync(fixtureWorktreeScript, "utf8") +
          "\ngc_pr_worktrees() { echo 'wrong canonical wrapper' >&2; exit 91; }\n",
      );
      git("add", "scripts/pr-lib/worktree.sh");
      git("commit", "-qm", "test: canonical wrapper drift");
      const canonicalHead = git("rev-parse", "HEAD");
      const gh = writeFixtureFile(binDir, "gh", [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        'case "$*" in',
        '  "auth token") exit 1 ;;',
        '  "browse") printf "https://github.com/fixture/repo\\n" ;;',
        '  "api --hostname github.com repos/fixture/repo/pulls/42 -H Cache-Control: max-age=0" | "api --hostname github.com repos/fixture/repo/pulls/43 -H Cache-Control: max-age=0")',
        `    jq -cn --arg head '${preparedHead}' --argjson number "\${4##*/}" '{number:$number,html_url:("https://github.com/fixture/repo/pull/"+($number|tostring)),state:"closed",draft:false,merged_at:"2026-09-18T00:00:00Z",base:{ref:"main",sha:$head,repo:{id:123,node_id:"fixture-repo",full_name:"fixture/repo",html_url:"https://github.com/fixture/repo"}},head:{ref:"",sha:$head,repo:{id:123,node_id:"fixture-repo",name:"repo",full_name:"fixture/repo",html_url:"https://github.com/fixture/repo",owner:{login:"fixture"}}}}' ;;`,
        '  *) echo "unexpected fixture gh call: $*" >&2; exit 99 ;;',
        "esac",
      ]);
      chmodSync(gh, 0o755);
      const realGit = realpathSync(join(binDir, "git"));
      unlinkSync(join(binDir, "git"));
      const gitShim = writeFixtureFile(binDir, "git", [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        'case "$*" in',
        '  "worktree remove "*)',
        '    if [ ! -e "$OPENCLAW_TEST_OWNER" ]; then "$OPENCLAW_TEST_REAL_GIT" rev-parse refs/openclaw/pr-operation-locks/42 > "$OPENCLAW_TEST_OWNER"; fi',
        '    "$OPENCLAW_TEST_REAL_GIT" "$@"',
        '    printf "removed\\n" >> "$OPENCLAW_TEST_LIFECYCLE"',
        '    if [ "$OPENCLAW_TEST_FAILURE" = true ]; then : > "$OPENCLAW_TEST_REF_LOCK"; fi',
        "    exit 0 ;;",
        '  *"update-ref --no-deref -d refs/openclaw/pr-operation-locks/42 "*)',
        '    pwd -P > "$OPENCLAW_TEST_RELEASE_CWD"',
        '    "$OPENCLAW_TEST_REAL_GIT" "$@"',
        '    printf "released\\n" >> "$OPENCLAW_TEST_LIFECYCLE"',
        "    exit 0 ;;",
        "esac",
        'exec "$OPENCLAW_TEST_REAL_GIT" "$@"',
      ]);
      chmodSync(gitShim, 0o755);
      const linked = join(repoDir, ".worktrees/pr-42");
      const result = spawnSync(join(linked, "scripts/pr"), ["gc"], {
        cwd: linked,
        encoding: "utf8",
        timeout: 120_000,
        env: {
          ...createIndependentPrFixtureEnv(),
          canonical_repo_root: join(repoDir, "untrusted-root"),
          OPENCLAW_GH_BIN: gh,
          GH_REPO: "fixture/repo",
          OPENCLAW_TEST_FAILURE: String(failure),
          OPENCLAW_TEST_LIFECYCLE: lifecycle,
          OPENCLAW_TEST_OWNER: ownerFile,
          OPENCLAW_TEST_REAL_GIT: realGit,
          OPENCLAW_TEST_REF_LOCK: refLock,
          OPENCLAW_TEST_RELEASE_CWD: releaseCwd,
          PATH: binDir + delimiter + (process.env.PATH ?? ""),
          TMPDIR: tempDirs.make("openclaw-pr-cleanup-tmp-"),
        },
      });
      const output = result.stdout + "\n" + result.stderr;
      expect(result.error, output).toBeUndefined();
      expect(result.status, output).toBe(failure ? 1 : 0);
      expect(git("rev-parse", "HEAD")).toBe(canonicalHead);
      for (const { pr, path, admin } of worktrees) {
        expect(existsSync(path), output).toBe(false);
        expect(existsSync(admin), output).toBe(false);
        expect(result.stdout).toContain("removed .worktrees/pr-" + pr);
        for (const branch of ["temp/pr-" + pr, "pr-" + pr, "pr-" + pr + "-prep"]) {
          expect(git("for-each-ref", "--format=%(refname)", "--", "refs/heads/" + branch)).toBe("");
        }
      }
      expect(git("worktree", "list", "--porcelain")).not.toContain(".worktrees/pr-");
      expect(readFileSync(lifecycle, "utf8")).toBe(
        "removed\nremoved\n" + (failure ? "" : "released\n"),
      );
      expect(readFileSync(releaseCwd, "utf8").trim()).toBe(repoDir);
      expect(refExists(repoDir, "refs/openclaw/pr-operation-locks/43")).toBe(false);
      expect(refExists(repoDir)).toBe(failure);
      if (failure) {
        const ownerOid = readFileSync(ownerFile, "utf8").trim();
        expect(refOid(repoDir)).toBe(ownerOid);
        expect(result.stderr).toContain("Unable to release the operation lock for 42");
        expect(result.stderr).toContain(
          "scripts/pr lock-recover 42 " + ownerOid + " --confirmed-no-running-tools",
        );
      } else {
        expect(result.stderr).not.toContain("Retaining the operation lock");
      }
    },
  );
  it("reports exact recovery when lock notification fails", () => {
    const repoDir = createRepo();
    const result = runLockShell(repoDir, [
      "OPENCLAW_PR_LOCK_NOTIFY_FD=9",
      "set +e",
      "acquire_pr_operation_lock 42",
      "lock_status=$?",
      "set -e",
      'printf "%s\\n" "$lock_status"',
    ]);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout.trim()).toBe("2");
    const ownerOid = refOid(repoDir);
    expect(result.stderr).toContain(
      `scripts/pr lock-recover 42 ${ownerOid} --confirmed-no-running-tools`,
    );
    recoverOperationLock(repoDir, ownerOid);
  });
  it("rejects a notification for a lock owned by another process group", async () => {
    const repoDir = createRepo();
    const foreignRef = "refs/openclaw/pr-operation-locks/43";
    const foreignHeld = join(repoDir, "foreign-held");
    const foreignHolder = spawnHolder(repoDir, foreignHeld, 43);
    try {
      expect(await waitFor(() => existsSync(foreignHeld))).toBe(true);
      const foreignOid = refOid(repoDir, foreignRef);
      const result = await runSupervisedOperation(repoDir, "forged-notification.sh", [
        "acquire_pr_operation_lock 42",
        `printf '%s\\t%s\\n' '${foreignRef}' '${foreignOid}' >&"$OPENCLAW_PR_LOCK_NOTIFY_FD"`,
      ]);
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(1);
      expect(refOid(repoDir, foreignRef)).toBe(foreignOid);
      expect(refExists(repoDir)).toBe(true);
      expect(result.stderr).toContain("operation lock owned by another process group");
      const ownerOid = refOid(repoDir);
      recoverOperationLock(repoDir, ownerOid);
    } finally {
      await cleanupChildren(foreignHolder);
    }
  });
  it.each([
    [
      "retains the lock after newline-terminated malformed supervisor metadata",
      "malformed-notification.sh",
      "printf 'not-lock-metadata\\n'",
      "malformed operation-lock metadata",
    ],

    [
      "bounds an oversized unterminated supervisor metadata line",
      "oversized-notification.sh",
      `node -e 'process.stdout.write("x".repeat(8192))'`,
      "operation-lock metadata line is too large",
    ],
  ])("%s", async (_title, fixture, command, expectedError) => {
    const repoDir = createRepo();
    const result = await runSupervisedOperation(repoDir, fixture, [
      "acquire_pr_operation_lock 42",
      `${command} >&"$OPENCLAW_PR_LOCK_NOTIFY_FD"`,
    ]);
    const ownerOid = refOid(repoDir);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(1);
    expect(result.stderr).toContain(expectedError);
    expect(result.stderr).toContain(
      `scripts/pr lock-recover 42 ${ownerOid} --confirmed-no-running-tools`,
    );
    recoverOperationLock(repoDir, ownerOid);
  });
  it("joins Git read producers before releasing a successful operation lock", async () => {
    const repoDir = createRepo();
    mkdirSync(join(repoDir, ".local"));
    const producerExited = join(repoDir, ".local", "worktree-producer-exited");
    const binDir = tempDirs.make("openclaw-pr-joined-query-");
    const queryExited = join(binDir, "query-exited");
    const validatorStarted = join(binDir, "validator-started");
    const validatorExited = join(binDir, "validator-exited");
    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    const proxy = writeFixtureFile(binDir, "git", [
      "#!/usr/bin/env bash",
      'args=("$@")',
      'while [ "${1:-}" = -c ]; do shift 2; done',
      'if [ "$1" = ls-tree ]; then',
      `  printf '%s\\n' "$$" >> '${validatorStarted}'`,
      `  '${realGit}' "\${args[@]}" || exit $?`,
      "  exec 1>&-",
      "  sleep 0.1",
      `  printf '%s\\n' "$$" >> '${validatorExited}'`,
      "  exit 0",
      "fi",
      'if [ "$1" = ls-files ] && [ "${3:-}" = --ignored ]; then',
      "  exec 1>&-",
      "  sleep 0.1",
      `  : > '${queryExited}'`,
      "  exit 0",
      "fi",
      `exec '${realGit}' "\${args[@]}"`,
    ]);
    chmodSync(proxy, 0o755);
    const result = await runSupervisedOperation(repoDir, ".local/joined-worktree-operation.sh", [
      `export PATH='${binDir}':"$PATH"`,
      "acquire_pr_operation_lock 42",
      "pr_git() {",
      '  case "$*" in',
      '    "worktree list"*) printf \'worktree %s\\0branch refs/heads/pr-42\\0\\0\' "$PWD" ;;',
      "    \"diff --name-only --no-renames -z \"*) printf 'base.txt\\0' ;;",
      '    "ls-files --others --exclude-standard -z") ;;',
      '    *) command git "$@"; return $? ;;',
      "  esac",
      "  exec 1>&-",
      "  sleep 0.1",
      "  : >.local/worktree-producer-exited",
      "}",
      'test "$(worktree_registration_state "$PWD")" = registered',
      "test -f .local/worktree-producer-exited",
      "rm .local/worktree-producer-exited",
      'resolved="$(worktree_path_for_branch pr-42)"',
      'test "$resolved" = "$PWD"',
      "test -f .local/worktree-producer-exited",
      'head="$(git rev-parse HEAD)"',
      "for guard in require_no_foreign_untracked require_no_ignored_transition_paths validate_review_transition_state; do",
      "  rm .local/worktree-producer-exited",
      '  "$guard" 42 "$head" "$head" || exit $?',
      "  test -f .local/worktree-producer-exited",
      '  if [ "$guard" != require_no_foreign_untracked ]; then',
      `    test -f '${queryExited}'`,
      `    rm '${queryExited}'`,
      "  fi",
      '  if [ "$guard" = validate_review_transition_state ]; then',
      `    test -s '${validatorStarted}'`,
      `    test "$(sort '${validatorStarted}')" = "$(sort '${validatorExited}')"`,
      "  fi",
      "done",
    ]);
    expect(result.status, result.stdout + "\n" + result.stderr).toBe(0);
    expect(existsSync(producerExited)).toBe(true);
    expect(refExists(repoDir)).toBe(false);
    expect(result.stderr).not.toContain("process group remained active after wrapper exit");
  });
  it("warns and releases after leader completion when an escaped child keeps the notification pipe open", async () => {
    const repoDir = createRepo();
    const operationPgidFile = join(repoDir, "clean-pipe-holder-operation-pgid");
    const holderPidFile = join(repoDir, "clean-pipe-holder-pgid");
    escapedPipeHolderPidFiles.add(holderPidFile);
    const launcherScript = writeEscapedPipeHolderLauncher(repoDir, holderPidFile);

    const result = await runSupervisedOperation(
      repoDir,
      "clean-pipe-holder-operation.sh",
      [
        `printf '%s\\n' "$$" >'${operationPgidFile}'`,
        "acquire_pr_operation_lock 42",
        `node '${launcherScript}'`,
      ],
      { accelerateTimeouts: true },
    );

    const operationPgid = await waitForProcessId(operationPgidFile);
    const holderPgid = await waitForProcessId(holderPidFile);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(operationPgid).not.toBe(holderPgid);
    expect(processGroupExists(operationPgid)).toBe(false);
    expect(processGroupExists(holderPgid)).toBe(true);
    expect(refExists(repoDir)).toBe(false);
    expect(result.stderr).toContain("Warning:");
    expect(result.stderr).toContain("group=dead, pipe=open");
    expect(result.stderr).toContain("#124583");
  }, 15_000);
  it("retains a clean-exit lock when the leader completion marker is suppressed", async () => {
    const repoDir = createRepo();
    const holderPidFile = join(repoDir, "suppressed-completion-holder-pgid");
    escapedPipeHolderPidFiles.add(holderPidFile);
    const launcherScript = writeEscapedPipeHolderLauncher(repoDir, holderPidFile);
    let holderPgid: number | undefined;
    try {
      const result = await runSupervisedOperation(
        repoDir,
        "suppressed-completion-operation.sh",
        ["acquire_pr_operation_lock 42", "trap - EXIT", `node '${launcherScript}'`],
        { accelerateTimeouts: true },
      );
      holderPgid = await waitForProcessId(holderPidFile);
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(1);
      expect(processGroupExists(holderPgid)).toBe(true);
      const ownerOid = refOid(repoDir);
      expect(result.stderr).toContain("reason: notification pipe still open after drain deadline");
      expect(result.stderr).toContain(
        "scripts/pr operation lifetime did not drain (group=dead, pipe=open)",
      );
      expect(result.stderr).not.toContain("Warning:");
      const blocked = probeOperationLock(repoDir);
      expect(blocked.status, `${blocked.stdout}\n${blocked.stderr}`).toBe(0);
      expect(blocked.stdout.trim()).toBe("2");
      killProcessGroup(holderPgid, "SIGKILL");
      expect(await waitFor(() => !processGroupExists(holderPgid!))).toBe(true);
      recoverOperationLock(repoDir, ownerOid);
    } finally {
      await cleanupRecordedProcessGroup(holderPidFile, holderPgid);
    }
  }, 15_000);
  it("retains a failed side-effects lock when an escaped child keeps the notification pipe open", async () => {
    const repoDir = createRepo();
    const nestedPidFile = join(repoDir, "pipe-holder-pgid");
    escapedPipeHolderPidFiles.add(nestedPidFile);
    const launcherScript = writeEscapedPipeHolderLauncher(repoDir, nestedPidFile);
    let nestedPgid: number | undefined;
    try {
      const startedAt = Date.now();
      const result = await runSupervisedOperation(
        repoDir,
        "pipe-holder-operation.sh",
        [
          "acquire_pr_operation_lock 42",
          "begin_pr_operation_validation_phase",
          "mark_pr_operation_side_effects_started",
          `node '${launcherScript}'`,
          "exit 1",
        ],
        { accelerateTimeouts: true },
      );
      const elapsed = Date.now() - startedAt;
      nestedPgid = await waitForProcessId(nestedPidFile);
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(1);
      expect(elapsed).toBeLessThan(12_000);
      expect(processGroupExists(nestedPgid)).toBe(true);
      expect(result.stderr).toContain("operation lifetime did not drain");
      const ownerOid = refOid(repoDir);
      expect(result.stderr).toContain(
        "reason: child exited with code 1; notification pipe still open after drain deadline",
      );
      killProcessGroup(nestedPgid, "SIGKILL");
      expect(await waitFor(() => !processGroupExists(nestedPgid!))).toBe(true);
      recoverOperationLock(repoDir, ownerOid);
    } finally {
      await cleanupRecordedProcessGroup(nestedPidFile, nestedPgid);
    }
  }, 15_000);
  it("waits while a live supervisor finishes draining a dead operation group", async () => {
    const repoDir = createRepo();
    const operationPgidFile = join(repoDir, "finishing-operation-pgid");
    const holderPidFile = join(repoDir, "finishing-holder-pgid");
    const acquiredFile = join(repoDir, "finishing-waiter-acquired");
    const holderScript = writeFixtureFile(
      repoDir,
      "finishing-holder.mjs",
      "setInterval(() => {}, 1000);\n",
    );
    const launcherScript = writeFixtureFile(repoDir, "finishing-launcher.mjs", [
      'import { spawn } from "node:child_process";',
      'import fs from "node:fs";',
      `const child = spawn(process.execPath, [${JSON.stringify(holderScript)}], {`,
      "  detached: true,",
      '  stdio: ["ignore", "ignore", "ignore", 3],',
      "});",
      `fs.writeFileSync(${JSON.stringify(holderPidFile)}, String(child.pid));`,
      "process.exit(0);",
    ]);
    const fixture = writeOperationFixture(repoDir, "finishing-operation.sh", [
      `printf '%s\\n' "$$" >'${operationPgidFile}'`,
      "acquire_pr_operation_lock 42",
      `node '${launcherScript}'`,
    ]);
    const controller = spawn(process.execPath, [processGroupRunner, repoDir, fixture], {
      cwd: repoDir,
      env: createIndependentPrFixtureEnv(),
      stdio: "ignore",
    });
    let waiter: ChildProcess | undefined;
    let holderPgid: number | undefined;
    try {
      const operationPgid = await waitForProcessId(operationPgidFile);
      holderPgid = await waitForProcessId(holderPidFile);
      expect(await waitFor(() => !processGroupExists(operationPgid))).toBe(true);
      expect(refExists(repoDir)).toBe(true);
      const probe = probeOperationLock(repoDir);
      expect(probe.status, `${probe.stdout}\n${probe.stderr}`).toBe(0);
      expect(probe.stdout.trim()).toBe("1");
      waiter = spawnDetached(
        "bash",
        [
          "-c",
          [
            ...bashSource(repoDir),
            "acquire_pr_operation_lock 42",
            `printf 'acquired\\n' >'${acquiredFile}'`,
            "release_pr_operation_lock",
          ].join("\n"),
        ],
        { cwd: repoDir, stdio: ["ignore", "ignore", "pipe"] },
      );
      let waiterStderr = "";
      waiter.stderr?.setEncoding("utf8");
      waiter.stderr?.on("data", (chunk) => (waiterStderr += chunk));
      expect(
        await waitFor(() =>
          waiterStderr.includes(
            "Waiting for the active scripts/pr operation on PR #42 to finish...",
          ),
        ),
      ).toBe(true);
      expect(existsSync(acquiredFile)).toBe(false);
      expect(controller.exitCode).toBeNull();
      expect(processGroupExists(holderPgid)).toBe(true);
      killProcessGroup(holderPgid, "SIGTERM");
      await waitForExit(controller, 5000);
      await waitForExit(waiter, 5000);
      expect(controller.exitCode).toBe(0);
      expect(waiter.exitCode).toBe(0);
      expect(existsSync(acquiredFile)).toBe(true);
      expect(refExists(repoDir)).toBe(false);
    } finally {
      await cleanupRecordedProcessGroup(holderPidFile, holderPgid);
      await cleanupChildren(waiter);
      await cleanupController(repoDir, controller, operationPgidFile);
    }
  }, 12_000);
  it("fails and retains the lock when a clean wrapper leaves same-group work", async () => {
    const repoDir = createRepo();
    const operationPgidFile = join(repoDir, "clean-background-operation-pgid");
    const backgroundPidFile = join(repoDir, "clean-background-pid");
    const ownerFile = join(repoDir, "clean-background-owner");
    let operationPgid: number | undefined;
    try {
      const result = await runSupervisedOperation(repoDir, "clean-background-operation.sh", [
        `printf '%s\\n' "$$" >'${operationPgidFile}'`,
        "acquire_pr_operation_lock 42",
        `printf '%s\\n' "$PR_OPERATION_LOCK_OWNER_OID" >'${ownerFile}'`,
        "sleep 30 &",
        `printf '%s\\n' "$!" >'${backgroundPidFile}'`,
        "exit 0",
      ]);
      operationPgid = await waitForProcessId(operationPgidFile);
      const backgroundPid = await waitForProcessId(backgroundPidFile);
      const ownerOid = readFileSync(ownerFile, "utf8").trim();
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(1);
      assertFixtureProcessGroupStopped(operationPgid);
      goneProcessGroups.add(operationPgid);
      expect(result.stderr).toContain("process group remained active after wrapper exit");
      expect(result.stderr).toMatch(
        new RegExp(`^\\s+${backgroundPid} ${operationPgid} \\S+$`, "mu"),
      );
      const currentHeader = `surviving processes in group ${operationPgid}:`;
      const historicalHeader = `surviving processes in group ${operationPgid} when wrapper exited:`;
      const headers = result.stderr
        .split("\n")
        .filter((line) => line === currentHeader || line === historicalHeader);
      expect(headers).toHaveLength(1);
      // Drain completion does not promise that the OS has reaped its zombie row.
      expect(result.stderr.includes("process group appears empty at report time")).toBe(
        headers[0] === historicalHeader,
      );
      expect(refOid(repoDir)).toBe(ownerOid);
      expect(result.stderr).toContain(
        `scripts/pr lock-recover 42 ${ownerOid} --confirmed-no-running-tools`,
      );
      recoverOperationLock(repoDir, ownerOid);
    } finally {
      await cleanupRecordedProcessGroup(operationPgidFile, operationPgid);
    }
  });
  it("keeps gc lock ownership with the supervisor until gc exits", async () => {
    const repoDir = createRepo();
    gitOutput(repoDir, [
      "worktree",
      "add",
      "-q",
      "-b",
      "pr-42",
      join(repoDir, ".worktrees", "pr-42"),
    ]);
    const ghStarted = join(repoDir, "gc-gh-started");
    const ghContinue = join(repoDir, "gc-gh-continue");
    const outputFile = join(repoDir, "gc-output");
    const fixture = writeOperationFixture(repoDir, "gc.sh", [
      "pr_gh() {",
      `  : >'${ghStarted}'`,
      `  while [ ! -e '${ghContinue}' ]; do sleep 0.05; done`,
      "  printf 'MERGED\\n'",
      "}",
      `gc_pr_worktrees true >'${outputFile}'`,
    ]);
    const controller = spawn(process.execPath, [processGroupRunner, repoDir, fixture], {
      cwd: repoDir,
      env: createIndependentPrFixtureEnv(),
      stdio: "ignore",
    });
    try {
      expect(await waitFor(() => existsSync(ghStarted) && refExists(repoDir))).toBe(true);
      const probe = probeOperationLock(repoDir);
      expect(probe.status, `${probe.stdout}\n${probe.stderr}`).toBe(0);
      expect(probe.stdout.trim()).toBe("1");
      writeFileSync(ghContinue, "continue\n");
      await waitForExit(controller, 5000);
      expect(controller.exitCode).toBe(0);
      expect(readFileSync(outputFile, "utf8")).toContain("would remove .worktrees/pr-42");
      expect(refExists(repoDir)).toBe(false);
    } finally {
      writeFileSync(ghContinue, "continue\n");
      await cleanupController(repoDir, controller);
    }
  });
  it("preserves the exact lock if its controller is killed", async () => {
    const repoDir = createRepo();
    const pidFile = join(repoDir, "operation-pgid");
    const held = join(repoDir, "held");
    const fixture = writeOperationFixture(repoDir, "operation.sh", [
      `printf '%s\\n' "$$" >'${pidFile}'`,
      "acquire_pr_operation_lock 42",
      `printf 'held\\n' >'${held}'`,
      "while :; do sleep 1; done",
    ]);
    const controller = spawn(process.execPath, [processGroupRunner, repoDir, fixture], {
      cwd: repoDir,
      env: createIndependentPrFixtureEnv(),
      stdio: "ignore",
    });
    let pgid: number | undefined;
    try {
      expect(await waitFor(() => existsSync(pidFile) && existsSync(held))).toBe(true);
      pgid = await waitForProcessId(pidFile);
      const ownerOid = refOid(repoDir);
      expect(processGroupExists(pgid!)).toBe(true);
      await stopChild(controller, "SIGKILL");
      expect(processGroupExists(pgid!)).toBe(true);
      expect(refOid(repoDir)).toBe(ownerOid);
      const blockedWhileGroupLives = runLockShell(repoDir, [
        "set +e",
        "try_acquire_pr_operation_lock 42",
        "lock_status=$?",
        "set -e",
        'printf "%s\\t%s\\t%s\\n" "$lock_status" "$PR_OPERATION_LOCK_BLOCKED_REASON" "$PR_OPERATION_LOCK_BLOCKED_OID"',
      ]);
      expect(blockedWhileGroupLives.status).toBe(0);
      expect(blockedWhileGroupLives.stdout.trim()).toBe(`2\torphaned\t${ownerOid}`);
      expect(processGroupExists(pgid!)).toBe(true);
      expect(refOid(repoDir)).toBe(ownerOid);
      killProcessGroup(pgid!, "SIGTERM");
      expect(await waitFor(() => !processGroupExists(pgid!))).toBe(true);
      const blocked = probeOperationLock(repoDir, "blocking");
      expect(blocked.status).toBe(0);
      expect(blocked.stdout.trim()).toBe("2");
      expect(refOid(repoDir)).toBe(ownerOid);
      recoverOperationLock(repoDir, ownerOid, [
        "acquire_pr_operation_lock 42",
        "release_pr_operation_lock",
      ]);
    } finally {
      await cleanupController(repoDir, controller, pidFile);
    }
  });
  it("escalates a signal, drains its group, and retains the interrupted lock", async () => {
    const repoDir = createRepo();
    const pidFile = join(repoDir, "operation-pgid");
    const childReady = join(repoDir, "child-ready");
    const fixture = writeOperationFixture(repoDir, "stubborn-operation.sh", [
      `printf '%s\\n' "$$" >'${pidFile}'`,
      "trap 'exit 143' TERM",
      "acquire_pr_operation_lock 42",
      "(",
      "  trap '' HUP INT TERM",
      `  printf 'ready\\n' >'${childReady}'`,
      "  while :; do sleep 1; done",
      ") &",
      'wait "$!"',
    ]);
    const controller = spawn(
      process.execPath,
      [
        "--require",
        createProcessGroupTimingPreload(tempDirs.make("openclaw-pr-operation-lock-timing-"), {
          accelerateClock: false,
        }),
        processGroupRunner,
        repoDir,
        fixture,
      ],
      { cwd: repoDir, env: createIndependentPrFixtureEnv(), stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    let stderrOverflow = false;
    controller.stderr.setEncoding("utf8");
    controller.stderr.on("data", (chunk: string) => {
      if (stderrOverflow || Buffer.byteLength(stderr) + Buffer.byteLength(chunk) > 16 * 1024) {
        stderrOverflow = true;
        return;
      }
      stderr += chunk;
    });
    let pgid: number | undefined;
    try {
      expect(await waitFor(() => existsSync(pidFile) && existsSync(childReady))).toBe(true);
      pgid = await waitForProcessId(pidFile);
      const ownerOid = refOid(repoDir);
      const closed = once(controller, "close", { signal: AbortSignal.timeout(12_000) });
      controller.kill("SIGTERM");
      await closed;
      expect(stderrOverflow, "supervisor stderr exceeded 16 KiB").toBe(false);
      expect(controller.exitCode, stderr).toBe(143);
      expect(stderr).toContain("child exited with code 143; wrapper received SIGTERM");
      expect(stderr).not.toMatch(
        /operation lifetime did not drain|after drain deadline|process-group state became indeterminate|Unable to signal scripts\/pr process group/u,
      );
      assertFixtureProcessGroupStopped(pgid!);
      // The joined fixture is stopped; retire its PGID before cleanup can signal a reused ID.
      goneProcessGroups.add(pgid!);
      expect(refOid(repoDir)).toBe(ownerOid);
      recoverOperationLock(repoDir, ownerOid);
    } finally {
      await cleanupController(repoDir, controller, pidFile);
    }
  }, 15_000);
  it("retains the lock when a nested managed process group escapes cancellation", async ({
    onTestFinished,
  }) => {
    const lifetime = createFixtureLifetime();
    onTestFinished(() => lifetime.cleanup());
    await lifetime.run(async () => {
      const repoDir = createRepo(undefined, lifetime.createTempDir("pr-escaped-cancellation-"));
      const resourceOwner = createVitestResourceOwner(repoDir);
      const nestedPidFile = join(repoDir, "nested-pgid");
      const signalRelayedFile = join(repoDir, "nested-signal-relayed");
      const nestedScript = writeFixtureFile(repoDir, "nested.mjs", [
        'import fs from "node:fs";',
        "fs.writeFileSync(process.argv[2], String(process.pid));",
        'process.on("SIGTERM", () => fs.writeFileSync(process.argv[3], "relayed\\n"));',
        "setInterval(() => {}, 1000);",
      ]);
      const relayScript = writeFixtureFile(repoDir, "relay.mjs", [
        `import { runManagedCommand } from ${JSON.stringify(managedChildUrl)};`,
        "process.exitCode = await runManagedCommand({",
        "  bin: process.execPath,",
        `  args: [${JSON.stringify(nestedScript)}, ${JSON.stringify(nestedPidFile)}, ${JSON.stringify(signalRelayedFile)}],`,
        '  stdio: "ignore",',
        "});",
      ]);
      const fixture = writeOperationFixture(repoDir, "nested-operation.sh", [
        "acquire_pr_operation_lock 42",
        `node '${relayScript}'`,
      ]);
      const controller = spawn(process.execPath, [processGroupRunner, repoDir, fixture], {
        cwd: repoDir,
        // The test deliberately kills the relay before its managed claim can release.
        // Only this fixture's independent group census may dispose its retained inputs.
        env: { ...createIndependentPrFixtureEnv(), TMPDIR: repoDir, TMP: repoDir, TEMP: repoDir },
        stdio: "ignore",
      });
      let nestedPgid: number | undefined;
      try {
        expect(await waitFor(() => existsSync(nestedPidFile) && refExists(repoDir))).toBe(true);
        nestedPgid = await waitForProcessId(nestedPidFile);
        const ownerOid = refOid(repoDir);
        expect(processGroupExists(nestedPgid!)).toBe(true);
        controller.kill("SIGTERM");
        expect(await waitFor(() => existsSync(signalRelayedFile))).toBe(true);
        controller.kill("SIGTERM");
        await waitForExit(controller, 8000);
        expect(controller.exitCode).toBe(143);
        expect(processGroupExists(nestedPgid!)).toBe(true);
        expect(refOid(repoDir)).toBe(ownerOid);
        const blocked = probeOperationLock(repoDir);
        expect(blocked.status).toBe(0);
        expect(blocked.stdout.trim()).toBe("2");
        expect(() => resourceOwner.assertReleased()).toThrow("Unreleased Vitest resource claim");
        killProcessGroup(nestedPgid!, "SIGKILL");
        expect(await waitFor(() => !processGroupExists(nestedPgid!))).toBe(true);
        recoverOperationLock(repoDir, ownerOid);
      } finally {
        await lifetime.verifyCleanup(async () => {
          try {
            await cleanupController(repoDir, controller);
          } finally {
            // Fence the PID producer before rereading after a failed observation.
            // A pending claim without a recorded child remains unverified.
            const recordedPgid = nestedPgid ?? readProcessIdFile(nestedPidFile);
            if (recordedPgid) {
              await cleanupProcessGroup(recordedPgid);
            } else {
              resourceOwner.assertReleased();
            }
          }
        });
      }
    });
  });
  it("makes gc skip a PR while its operation lock is held", async () => {
    const repoDir = createRepo();
    mkdirSync(join(repoDir, ".worktrees", "pr-42"), { recursive: true });
    const held = join(repoDir, "held");
    const holder = spawnHolder(repoDir, held);
    try {
      expect(await waitFor(() => existsSync(held))).toBe(true);
      const result = runLockShell(repoDir, [
        "pr_gh() { if [ \"$1 $2\" = 'repo view' ]; then printf 'openclaw/openclaw\\n'; else printf 'MERGED\\n'; fi; }",
        "gc_pr_worktrees false",
      ]);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("has an active scripts/pr operation");
      expect(existsSync(join(repoDir, ".worktrees", "pr-42"))).toBe(true);
    } finally {
      await cleanupChildren(holder);
    }
  });
  it("makes gc skip an unreadable lock and report exact recovery", () => {
    const repoDir = createRepo();
    const worktreeDir = join(repoDir, ".worktrees", "pr-42");
    mkdirSync(worktreeDir, { recursive: true });
    const result = runLockShell(repoDir, [
      "bad_oid=$(printf 'not-a-lock\\n' | git hash-object -w --stdin)",
      `git update-ref '${lockRef}' "$bad_oid"`,
      "pr_gh() { printf 'MERGED\\n'; }",
      "gc_pr_worktrees false",
    ]);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("operation lock is unreadable");
    expect(result.stderr).toContain(
      `scripts/pr lock-recover 42 ${refOid(repoDir)} --confirmed-no-running-tools`,
    );
    expect(existsSync(worktreeDir)).toBe(true);
  });
  it("does not report removal when gc cleanup leaves the worktree", () => {
    const repoDir = createRepo();
    const worktreeDir = join(repoDir, ".worktrees", "pr-42");
    mkdirSync(worktreeDir, { recursive: true });
    const result = runLockShell(repoDir, [
      "pr_gh() { printf 'MERGED\\n'; }",
      "remove_worktree_if_present() { return 0; }",
      "delete_local_branch_if_safe() { return 0; }",
      "gc_pr_worktrees false",
    ]);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("cleanup incomplete");
    expect(result.stdout).not.toContain("removed .worktrees/pr-42");
    expect(existsSync(worktreeDir)).toBe(true);
  });
  it("removes a registered relative worktree under a NUL-framed escaped Unicode path", () => {
    const repoDir = createRepo("repo with space \\ backslash\n雪");
    const worktreeDir = join(repoDir, ".worktrees", "pr-42");
    mkdirSync(dirname(worktreeDir), { recursive: true });
    gitOutput(repoDir, ["worktree", "add", "-q", "-b", "pr-42", worktreeDir]);
    // oxlint-disable-next-line no-warning-comments -- remove after the upstream Bun newline-path fix ships.
    // TODO(bun): realpathSync reports ENOENT for an existing path containing a newline.
    const canonicalWorktreeDir = process.versions.bun
      ? realpathSpecialFixtureWithNode(worktreeDir)
      : realpathSync(worktreeDir);
    const located = runLockShell(repoDir, ["worktree_path_for_branch pr-42"]);
    expect(located.status, `${located.stdout}\n${located.stderr}`).toBe(0);
    expect(located.stdout.trim()).toBe(canonicalWorktreeDir);
    const result = runLockShell(repoDir, [
      "pr_gh() { printf 'MERGED\\n'; }",
      "gc_pr_worktrees false",
    ]);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("removed .worktrees/pr-42");
    // oxlint-disable-next-line no-warning-comments -- remove after the upstream Bun newline-path fix ships.
    // TODO(bun): existsSync can throw ENOENT for a missing path containing a newline.
    let worktreeExists = false;
    try {
      worktreeExists = existsSync(worktreeDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
    expect(worktreeExists).toBe(false);
    expect(gitOutput(repoDir, ["worktree", "list", "--porcelain"])).not.toContain(
      canonicalWorktreeDir,
    );
    expect(gitStatus(repoDir, ["show-ref", "--verify", "--quiet", "refs/heads/pr-42"])).toBe(1);
  });
  it.each([23])("propagates status %s from NUL-framed worktree listings", (code) => {
    const repoDir = createRepo();
    const result = runLockShell(repoDir, [
      "pr_git() {",
      '  if [ "$1" = worktree ] && [ "$2" = list ]; then',
      "    printf 'worktree %s\\0branch refs/heads/pr-42\\0\\0' \"$PWD\"",
      `    return ${code}`,
      "  fi",
      '  command git "$@"',
      "}",
      "set +e",
      'worktree_registration_state "$PWD" >/dev/null',
      'registered_status="$?"',
      "worktree_path_for_branch pr-42 >/dev/null",
      'branch_status="$?"',
      'printf "%s %s\\n" "$registered_status" "$branch_status"',
    ]);
    expect(result.status, result.stdout + "\n" + result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe(`${code} ${code}`);
  });
  it.each(["temp/pr-42"])(
    "does not confuse absent branch %s with a checked-out descendant",
    (branch) => {
      const repoDir = createRepo();
      const sibling = join(repoDir, ".worktrees", "pr-99");
      gitOutput(repoDir, ["worktree", "add", "-q", "-b", `${branch}/topic`, sibling]);
      const otherBranch = branch === "pr-42-prep" ? "pr-42" : "pr-42-prep";
      execFileSync("git", ["branch", otherBranch], { cwd: repoDir });
      const head = gitOutput(repoDir, ["rev-parse", `refs/heads/${branch}/topic`]);
      const result = runLockShell(repoDir, [
        'cleanup_pr_worktree ".worktrees/pr-42" || exit $?',
        "echo cleanup-completed",
      ]);
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(result.stdout).toContain("cleanup-completed");
      expect(gitOutput(repoDir, ["rev-parse", `refs/heads/${branch}/topic`])).toBe(head);
      expect(gitOutput(sibling, ["rev-parse", "HEAD"])).toBe(head);
      expectWorktreeBranch(sibling, `${branch}/topic`);
      expect(
        gitStatus(repoDir, ["show-ref", "--verify", "--quiet", `refs/heads/${otherBranch}`]),
      ).toBe(1);
    },
  );
  it.each(["temp/pr-42"])("verifies only the exact branch %s after native deletion", (branch) => {
    const repoDir = createRepo();
    const sibling = join(repoDir, ".worktrees", "pr-99");
    execFileSync("git", ["branch", branch], { cwd: repoDir });
    const head = gitOutput(repoDir, ["rev-parse", `refs/heads/${branch}`]);
    const result = runLockShell(repoDir, [
      "pr_git() {",
      '  command git "$@" || return $?',
      `  if [ "$*" = "branch -d -- ${branch}" ]; then`,
      `    command git worktree add -q -b ${branch}/topic .worktrees/pr-99 || return $?`,
      "  fi",
      "}",
      `delete_local_branch_if_safe ${branch} || exit $?`,
      "echo cleanup-completed",
    ]);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("cleanup-completed");
    expect(gitOutput(repoDir, ["rev-parse", `refs/heads/${branch}/topic`])).toBe(head);
    expect(gitOutput(sibling, ["rev-parse", "HEAD"])).toBe(head);
    expectWorktreeBranch(sibling, `${branch}/topic`);
  });
  it.each([0])("rejects truncated listings without masking Git status %s", (code) => {
    const repoDir = createRepo();
    const result = runLockShell(repoDir, [
      "pr_git() {",
      '  if [ "${1:-} ${2:-}" = "worktree list" ]; then',
      "    printf 'worktree %s\\0branch refs/heads/pr-42' \"$PWD\"",
      `    return ${code}`,
      "  fi",
      '  command git "$@"',
      "}",
      "set +e",
      'worktree_registration_state "$PWD" >/dev/null',
      'registered_status="$?"',
      "worktree_path_for_branch pr-42 >/dev/null",
      'branch_status="$?"',
      'printf "%s %s\\n" "$registered_status" "$branch_status"',
    ]);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout.trim()).toBe(`${code || 1} ${code || 1}`);
  });
  it.each([23, 0])(
    "preserves a sibling's branch when its listing is unavailable (status %s)",
    (code) => {
      const repoDir = createRepo();
      const sibling = join(repoDir, ".worktrees", "pr-99");
      gitOutput(repoDir, ["worktree", "add", "-q", "-b", "pr-42", sibling]);
      const head = gitOutput(repoDir, ["rev-parse", "refs/heads/pr-42"]);
      const result = runLockShell(repoDir, [
        "pr_git() {",
        '  printf "%s\\n" "$*" >> git-calls',
        '  if [ "${1:-} ${2:-}" = "worktree list" ]; then',
        '    case " ${FUNCNAME[*]} " in',
        '      *" worktree_path_for_branch "*)',
        // A successful but stale listing must still face Git's checked-out guard.
        ...(code === 0
          ? ["        printf 'worktree %s\\0branch refs/heads/main\\0\\0' \"$PWD\""]
          : []),
        `        return ${code} ;;`,
        "    esac",
        "  fi",
        '  if [ "${1:-} ${2:-}" = "update-ref -d" ]; then echo unexpected-raw-delete >&2; return 97; fi',
        '  command git "$@"',
        "}",
        'cleanup_pr_worktree ".worktrees/pr-42" || exit $?',
        "echo unexpected-cleanup-completed",
      ]);
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(code || 1);
      expect(result.stdout).not.toContain("unexpected-cleanup-completed");
      expect(result.stderr).not.toContain("unexpected-raw-delete");
      expect(readFileSync(join(repoDir, "git-calls"), "utf8")).not.toContain("update-ref -d");
      expect(gitOutput(repoDir, ["rev-parse", "refs/heads/pr-42"])).toBe(head);
      expect(gitOutput(sibling, ["rev-parse", "HEAD"])).toBe(head);
      expectWorktreeBranch(sibling, "pr-42");
    },
  );
  it.each([23])("preserves a failed branch-ref query with status %s", (code) => {
    const repoDir = createRepo();
    execFileSync("git", ["branch", "pr-42"], { cwd: repoDir });
    const result = runLockShell(repoDir, [
      "pr_git() {",
      '  if [ "$1" = for-each-ref ] && [[ "$*" == *" -- refs/heads/pr-42" ]]; then',
      '    command git "$@" || return $?',
      `    return ${code}`,
      "  fi",
      '  command git "$@"',
      "}",
      'cleanup_pr_worktree ".worktrees/pr-42" || exit $?',
      "echo unexpected-cleanup-completed",
    ]);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(code);
    expect(result.stdout).not.toContain("unexpected-cleanup-completed");
    expect(gitStatus(repoDir, ["show-ref", "--verify", "--quiet", "refs/heads/pr-42"])).toBe(0);
  });
  it("does not report a broken ref as absent when Git only warns", () => {
    const repoDir = createRepo();
    const ref = join(repoDir, ".git", "refs", "heads", "pr-42");
    writeFileSync(ref, "broken\n");
    const result = runLockShell(repoDir, [
      'cleanup_pr_worktree ".worktrees/pr-42" || exit $?',
      "echo unexpected-cleanup-completed",
    ]);
    expect(result.status, `${result.stdout}\n${result.stderr}`).not.toBe(0);
    expect(result.stderr).toContain("broken ref");
    expect(result.stdout).not.toContain("unexpected-cleanup-completed");
    expect(readFileSync(ref, "utf8")).toBe("broken\n");
  });
  it("parses docs and mixed file lists without temp files or producer processes", () => {
    const repoDir = createRepo();
    const unusableTmpDir = join(repoDir, "missing-tmp");
    const result = runLockShell(repoDir, [
      `TMPDIR='${unusableTmpDir}'`,
      "printf() { echo 'unexpected producer' >&2; return 99; }",
      "set +e",
      "file_list_is_docsish_only ''",
      'empty_status="$?"',
      "file_list_is_docsish_only $'docs/guide.md\\nREADME.md'",
      'docs_status="$?"',
      "file_list_is_docsish_only $'docs/guide.md\\nsrc/index.ts'",
      'mixed_status="$?"',
      'command printf "%s %s %s\\n" "$empty_status" "$docs_status" "$mixed_status"',
    ]);
    expect(result.status, result.stdout + "\n" + result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("1 0 1");
    expect(result.stderr).not.toContain("unexpected producer");
  });
  it.each([true])("removes only the missing target registration (suffixed admin=%s)", (suffix) => {
    const repoDir = createRepo();
    const worktreeDir = join(repoDir, ".worktrees", "pr-42");
    const unrelatedDir = join(repoDir, ".worktrees", "pr-99");
    mkdirSync(dirname(worktreeDir), { recursive: true });
    if (suffix) {
      gitOutput(repoDir, ["worktree", "add", "-q", "-b", "other", join(repoDir, "other", "pr-42")]);
    }
    gitOutput(repoDir, ["worktree", "add", "-q", "-b", "pr-42", worktreeDir]);
    gitOutput(repoDir, ["worktree", "add", "-q", "-b", "pr-99", unrelatedDir]);
    const admin = gitOutput(worktreeDir, ["rev-parse", "--absolute-git-dir"]).trim();
    const unrelatedAdmin = gitOutput(unrelatedDir, ["rev-parse", "--absolute-git-dir"]).trim();
    const unrelatedBacklink = readFileSync(join(unrelatedAdmin, "gitdir"));
    const canonicalWorktreeDir = realpathSync(worktreeDir);
    rmSync(worktreeDir, { recursive: true });
    rmSync(unrelatedDir, { recursive: true });
    const result = runLockShell(repoDir, [
      "pr_git() {",
      '  if [[ "$*" == *"worktree prune"* ]]; then echo unexpected-prune >&2; return 97; fi',
      '  command git "$@"',
      "}",
      'remove_worktree_if_present ".worktrees/pr-42"',
    ]);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stderr).not.toContain("unexpected-prune");
    expect(existsSync(admin)).toBe(false);
    expect(readFileSync(join(unrelatedAdmin, "gitdir"))).toEqual(unrelatedBacklink);
    expect(gitOutput(repoDir, ["worktree", "list", "--porcelain", "-z"])).not.toContain(
      `worktree ${canonicalWorktreeDir}\0`,
    );
  });
  it("binds missing moved worktree cleanup through the original admin ID", () => {
    const repoDir = createRepo();
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: repoDir, encoding: "utf8" }).trim();
    const staging = join(repoDir, "staging");
    const worktree = join(repoDir, ".worktrees", "pr-42");
    const sibling = join(repoDir, ".worktrees", "pr-99");
    mkdirSync(dirname(worktree), { recursive: true });
    git("worktree", "add", "-q", "-b", "pr-42", staging);
    const admin = git("-C", staging, "rev-parse", "--absolute-git-dir");
    git("worktree", "move", staging, worktree);
    expect(admin).toBe(join(realpathSync(repoDir), ".git", "worktrees", "staging"));
    expect(git("-C", worktree, "rev-parse", "--absolute-git-dir")).toBe(admin);
    const head = git("rev-parse", "refs/heads/pr-42");
    git("worktree", "add", "-q", "-b", "pr-99", sibling);
    const siblingAdmin = git("-C", sibling, "rev-parse", "--absolute-git-dir");
    const siblingBacklink = readFileSync(join(siblingAdmin, "gitdir"));
    writeFileSync(join(sibling, "marker"), "preserve sibling\n");
    rmSync(worktree, { recursive: true });
    const result = runLockShell(repoDir, [
      "pr_git() {",
      '  printf "%s\\n" "$*" >> git-calls',
      '  if [[ "$*" == *"worktree prune"* ]]; then return 97; fi',
      '  if [ "${1:-} ${2:-}" = "update-ref -d" ]; then return 96; fi',
      '  command git "$@"',
      "}",
      'cleanup_pr_worktree ".worktrees/pr-42" || exit $?',
      "echo cleanup-completed",
    ]);
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout.includes("cleanup-completed")).toBe(true);
    const calls = readFileSync(join(repoDir, "git-calls"), "utf8");
    expect(calls).not.toMatch(/worktree prune|update-ref -d/u);
    expect(calls.split("\n").filter((line) => line.startsWith("worktree remove "))).toHaveLength(1);
    expect(existsSync(worktree)).toBe(false);
    expect(existsSync(admin)).toBe(false);
    expect(gitStatus(repoDir, ["show-ref", "--verify", "--quiet", "refs/heads/pr-42"])).toBe(1);
    expect(git("-C", sibling, "rev-parse", "HEAD")).toBe(head);
    expectWorktreeBranch(sibling, "pr-99");
    expect(readFileSync(join(sibling, "marker"), "utf8")).toBe("preserve sibling\n");
    expect(readFileSync(join(siblingAdmin, "gitdir"))).toEqual(siblingBacklink);
  });
  it.each([true])("preserves native remove failure after partial deletion=%s", (partial) => {
    const repoDir = createRepo();
    const worktreeDir = join(repoDir, ".worktrees", "pr-42");
    mkdirSync(dirname(worktreeDir), { recursive: true });
    gitOutput(repoDir, ["worktree", "add", "-q", "-b", "pr-42", worktreeDir]);
    const result = runLockShell(repoDir, [
      "pr_git() {",
      "  if [ \"$1 $2\" = 'worktree remove' ]; then",
      ...(partial ? ['    command git "$@" || return $?'] : []),
      "    echo 'fixture remove failure' >&2",
      "    return 73",
      "  fi",
      '  command git "$@"',
      "}",
      'cleanup_pr_worktree ".worktrees/pr-42" || exit $?',
      "echo unexpected-cleanup-completed",
    ]);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(73);
    expect(result.stderr).toContain("fixture remove failure");
    expect(result.stdout).not.toContain("unexpected-cleanup-completed");
    expect(existsSync(worktreeDir)).toBe(!partial);
    expect(gitStatus(repoDir, ["show-ref", "--verify", "--quiet", "refs/heads/pr-42"])).toBe(0);
  });
  it.each(["locked", "retained-admin"])(
    "retains cleanup state and branches for %s metadata",
    (fault) => {
      const repoDir = createRepo();
      const worktree = join(repoDir, ".worktrees", "pr-42");
      execFileSync("git", ["worktree", "add", "-q", "-b", "pr-42", worktree], { cwd: repoDir });
      const admin = gitOutput(worktree, ["rev-parse", "--absolute-git-dir"]).trim();
      if (fault === "locked") {
        execFileSync("git", ["worktree", "lock", worktree], { cwd: repoDir });
      }
      if (fault !== "retained-admin") {
        rmSync(worktree, { recursive: true });
      }
      const result = runLockShell(repoDir, [
        "pr_git() {",
        '  if [[ "$*" == *"worktree prune"* ]]; then echo unexpected-prune >&2; return 97; fi',
        ...(fault === "retained-admin"
          ? [
              '  if [ "${1:-} ${2:-}" = "worktree remove" ]; then',
              "    rm -rf -- .worktrees/pr-42",
              "    : > .git/worktrees/pr-42/gitdir",
              "    return 0",
              "  fi",
            ]
          : []),
        '  command git "$@"',
        "}",
        'cleanup_pr_worktree ".worktrees/pr-42" || exit $?',
        "echo unexpected-cleanup-completed",
      ]);
      expect(result.status, `${result.stdout}\n${result.stderr}`).not.toBe(0);
      expect(result.stdout).not.toContain("unexpected-cleanup-completed");
      expect(result.stderr).not.toContain("unexpected-prune");
      expect(existsSync(admin)).toBe(true);
      expect(gitStatus(repoDir, ["show-ref", "--verify", "--quiet", "refs/heads/pr-42"])).toBe(0);
    },
  );
  it("does not treat ENOTDIR as confirmed worktree absence", () => {
    const repoDir = createRepo();
    writeFileSync(join(repoDir, ".worktrees"), "not a directory\n");
    execFileSync("git", ["branch", "pr-42"], { cwd: repoDir });
    const result = runLockShell(repoDir, [
      'cleanup_pr_worktree ".worktrees/pr-42" || exit $?',
      "echo unexpected-cleanup-completed",
    ]);
    expect(result.status, `${result.stdout}\n${result.stderr}`).not.toBe(0);
    expect(result.stderr).toContain("ENOTDIR");
    expect(result.stdout).not.toContain("unexpected-cleanup-completed");
    expect(readFileSync(join(repoDir, ".worktrees"), "utf8")).toBe("not a directory\n");
    expect(gitStatus(repoDir, ["show-ref", "--verify", "--quiet", "refs/heads/pr-42"])).toBe(0);
  });
  it("removes the missing registration and resets its owned branch on worktree add", () => {
    const repoDir = createRepo();
    execFileSync("git", ["remote", "add", "origin", repoDir], { cwd: repoDir });
    const physicalWorktreesDir = join(repoDir, "linked-worktrees");
    mkdirSync(physicalWorktreesDir);
    symlinkSync(physicalWorktreesDir, join(repoDir, ".worktrees"), "dir");
    const worktreeDir = join(repoDir, ".worktrees", "pr-42");
    gitOutput(repoDir, ["worktree", "add", "-q", "-b", "temp/pr-42", worktreeDir]);
    rmSync(worktreeDir, { recursive: true });
    addTrackedUiConfig(repoDir);
    const { result } = enterPrWorktree(repoDir, 42);
    expect(result.stdout).toContain("Removing exact stale PR worktree .worktrees/pr-42");
    expect(existsSync(worktreeDir)).toBe(true);
    expectWorktreeBranch(worktreeDir, "temp/pr-42");
  });
  it("materializes an existing sparse PR worktree before reuse", () => {
    const repoDir = createRepo();
    addTrackedUiConfig(repoDir);
    execFileSync("git", ["remote", "add", "origin", repoDir], { cwd: repoDir });
    const worktreeDir = join(repoDir, ".worktrees", "pr-45");
    gitOutput(repoDir, ["worktree", "add", "-q", "-b", "temp/pr-45", worktreeDir]);
    setSparseCheckout(worktreeDir);
    expect(existsSync(join(worktreeDir, "ui", "config", "control-ui-chunking.ts"))).toBe(false);
    enterPrWorktree(repoDir, 45);
    expectMaterializedWorktree(worktreeDir);
  });
  it("refuses a symlink alias to another registered worktree", () => {
    const repoDir = createRepo();
    const worktreesDir = join(repoDir, ".worktrees");
    const targetDir = join(worktreesDir, "pr-99");
    const aliasDir = join(worktreesDir, "pr-42");
    mkdirSync(worktreesDir, { recursive: true });
    gitOutput(repoDir, ["worktree", "add", "-q", "-b", "pr-99", targetDir]);
    const canonicalTargetDir = realpathSync(targetDir);
    symlinkSync("pr-99", aliasDir, "dir");
    const result = runLockShell(repoDir, ['remove_worktree_if_present ".worktrees/pr-42"']);
    expect(result.status, `${result.stdout}\n${result.stderr}`).not.toBe(0);
    expect(result.stderr).toContain("non-canonical PR-worktree path");
    expect(existsSync(aliasDir)).toBe(true);
    expect(existsSync(targetDir)).toBe(true);
    expect(gitOutput(repoDir, ["worktree", "list", "--porcelain"])).toContain(canonicalTargetDir);
  });
});
