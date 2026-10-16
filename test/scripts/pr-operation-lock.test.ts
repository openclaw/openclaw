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
import type { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it as baseIt } from "vitest";
import { createVitestResourceOwner } from "../../scripts/lib/vitest-resource-ownership.mts";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import { createFixtureLifetime } from "../helpers/fixture-lifetime.js";
import {
  fixtureReceiptClientSource,
  openFixtureReceiptChannel,
  type FixtureReceiptChannel,
} from "../helpers/fixture-receipts.js";
import { awaitGateBeforeSettlement, withinTest } from "../helpers/promise.js";
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
  await cleanupAll(
    [...escapedPipeHolderPidFiles].map((file) => () => cleanupRecordedProcessGroup(file)),
    "failed to clean up escaped notification-pipe holders",
  ).finally(() => escapedPipeHolderPidFiles.clear());
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
let receipts: FixtureReceiptChannel;
const childCompletions = new WeakMap<ChildProcess, { exit: Promise<void>; close: Promise<void> }>();
let holderSequence = 0;
const gitConfig = [
  ["core.hooksPath", "/dev/null"],
  ["commit.gpgSign", "false"],
  ["gc.auto", "0"],
  ["maintenance.auto", "false"],
] as const;

function observeChild<T extends ChildProcess>(child: T): T {
  const exit = once(child, "exit").then(() => undefined);
  const close = once(child, "close").then(() => undefined);
  void exit.catch(() => {});
  void close.catch(() => {});
  childCompletions.set(child, { exit, close });
  return child;
}

function childCompletion(child: ChildProcess, event: "exit" | "close" = "exit") {
  const completion = childCompletions.get(child);
  if (!completion) {
    throw new Error("fixture child completion was not registered at spawn");
  }
  return completion[event];
}

function outputBeforeExit(child: ChildProcess, stream: Readable, text: string, error: string) {
  const ready = new Promise<void>((resolve) => {
    let output = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      output += chunk;
      if (output.includes(text)) {
        resolve();
      }
    });
  });
  return awaitGateBeforeSettlement(ready, childCompletion(child, "close"), error);
}

function fixtureReceiptCommand(repoDir: string, record: string) {
  const script = writeFixtureFile(repoDir, "fixture-receipt.mjs", [
    fixtureReceiptClientSource(receipts.endpoint),
    'sendReceipt(process.argv[2], "ready");',
  ]);
  return `${shellQuote(process.execPath)} ${shellQuote(script)} ${shellQuote(record)}`;
}

// Receipts and process completion travel independently. The fixture writes its
// record before reporting, so a late receipt must not make a completed event fail.
function fixtureEventBeforeSettlement(record: string, operation: PromiseLike<unknown>) {
  const settled = Promise.resolve(operation).then(
    () => {
      if (!existsSync(record)) {
        throw new Error(`fixture did not publish ${record} before completion`);
      }
    },
    (error: unknown) => {
      if (!existsSync(record)) {
        throw error;
      }
    },
  );
  return Promise.race([receipts.waitFor(record, "ready"), settled]);
}

// Foreign groups have no ChildProcess owner after the launcher exits. Keep this
// one observation loop under the test signal, never a competing wall-clock budget.
async function waitForProcessGroupExit(pgid: number, signal: AbortSignal) {
  try {
    while (processGroupExists(pgid)) {
      await delay(5, undefined, { signal });
    }
  } catch (cause) {
    throw new Error(`process group ${pgid} did not exit before the test ended`, { cause });
  }
}

function realpathSpecialFixtureWithNode(filePath: string): string {
  return execFileSync(
    resolveTestNodeExecPath(),
    ["--eval", 'process.stdout.write(require("node:fs").realpathSync(process.argv[1]))', filePath],
    { encoding: "utf8" },
  );
}

function spawnDetached(command: string, args: readonly string[], options: SpawnOptions = {}) {
  const child = observeChild(
    spawn(command, args, {
      env: createIndependentPrFixtureEnv(),
      ...options,
      detached: true,
    }),
  );
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
    GIT_CONFIG_COUNT: String(gitConfig.length),
    ...Object.fromEntries(
      gitConfig.flatMap(([key, value], i) => [
        [`GIT_CONFIG_KEY_${i}`, key],
        [`GIT_CONFIG_VALUE_${i}`, value],
      ]),
    ),
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
  for (const [key, value] of gitConfig) {
    execFileSync("git", ["config", key, value], options);
  }
  writeFileSync(join(dir, "base.txt"), "base\n");
  execFileSync("git", ["add", "base.txt"], options);
  execFileSync("git", ["commit", "-qm", "base"], options);
  return dir;
}

beforeAll(async () => {
  receipts = await openFixtureReceiptChannel();
  templateRepo = createTemplateRepo();
});

afterAll(async () => {
  await receipts.close();
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

const it = baseIt.extend<{ repoDir: string }>({
  repoDir: async ({ task: _task }, use) => {
    await use(createRepo());
  },
});

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

function writeExecutable(repoDir: string, name: string, contents: string | readonly string[]) {
  const fixture = writeFixtureFile(repoDir, name, contents);
  chmodSync(fixture, 0o755);
  return fixture;
}

function writeOperationFixture(repoDir: string, name: string, commands: string[]) {
  return writeExecutable(repoDir, name, [
    "#!/usr/bin/env bash",
    ...bashSource(repoDir),
    ...commands,
  ]);
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
    writeExecutable(binDir, command, "#!/bin/sh\nexit 0\n");
  }
}

interface SupervisedFixtureOptions {
  signal: AbortSignal;
  accelerateTimeouts?: boolean;
  env?: NodeJS.ProcessEnv;
  materializedAnchor?: boolean;
}

async function runSupervisedFixture(
  repoDir: string,
  fixture: string,
  options: SupervisedFixtureOptions,
) {
  // Entry bookkeeping is fixture-owned, not an untracked checkout transition input.
  const entryDir = tempDirs.make("openclaw-pr-supervised-entry-");
  const anchorDir = options.materializedAnchor
    ? realpathSync(tempDirs.make("openclaw-pr-anchor."))
    : undefined;
  if (anchorDir) {
    copyPrWrapperSources(anchorDir);
  }
  const groupFile = writeFixtureFile(entryDir, "supervised-fixture.pgid", "");
  const entry = writeExecutable(
    anchorDir ?? entryDir,
    anchorDir ? "scripts/pr" : "supervised-fixture-entry.sh",
    [
      "#!/usr/bin/env bash",
      `printf '%s\\n' "$$" > ${shellQuote(groupFile)}`,
      `exec ${shellQuote(fixture)}`,
    ],
  );
  const nodeArgs = [
    ...(options.accelerateTimeouts
      ? [
          "--require",
          createProcessGroupTimingPreload(tempDirs.make("openclaw-pr-operation-lock-timing-")),
        ]
      : []),
    anchorDir ? join(anchorDir, "scripts/pr-lib/process-group-runner.mjs") : processGroupRunner,
    repoDir,
    entry,
  ];
  const controller = observeChild(
    spawn(
      anchorDir ? "/bin/bash" : process.execPath,
      anchorDir
        ? [
            "-c",
            'exec 9< "$1"; export OPENCLAW_PR_ANCHOR_CREATOR_PID=$$ OPENCLAW_PR_ANCHOR_FD=9; shift; exec "$@"',
            "anchor-fixture",
            anchorDir,
            process.execPath,
            ...nodeArgs,
          ]
        : nodeArgs,
      {
        cwd: repoDir,
        env: { ...createIndependentPrFixtureEnv(), ...options.env },
        stdio: ["ignore", "pipe", "pipe"],
      },
    ),
  );
  let stdout = "";
  let stderr = "";
  controller.stdout!.setEncoding("utf8");
  controller.stderr!.setEncoding("utf8");
  controller.stdout!.on("data", (chunk) => (stdout += chunk));
  controller.stderr!.on("data", (chunk) => (stderr += chunk));
  try {
    await withinTest(childCompletion(controller, "close"), options.signal);
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
    if (controller.exitCode === null && controller.signalCode === null) {
      controller.kill("SIGKILL");
    }
    try {
      await childCompletion(controller, "close");
      await cleanupRecordedProcessGroup(groupFile);
    } catch (cleanupError) {
      failures.push(cleanupError);
    }
    throw new AggregateError(failures, "supervised fixture did not settle", { cause: error });
  }
  return { status: controller.exitCode, signal: controller.signalCode, stdout, stderr, anchorDir };
}

function runSupervisedOperation(
  repoDir: string,
  commands: string[],
  options: SupervisedFixtureOptions,
  name = "operation.sh",
) {
  return runSupervisedFixture(repoDir, writeOperationFixture(repoDir, name, commands), options);
}

function startOperation(
  repoDir: string,
  commands: string[],
  options: { stdio?: SpawnOptions["stdio"]; env?: NodeJS.ProcessEnv; preload?: string } = {},
) {
  return observeChild(
    spawn(
      process.execPath,
      [
        ...(options.preload ? ["--require", options.preload] : []),
        processGroupRunner,
        repoDir,
        writeOperationFixture(repoDir, "operation.sh", commands),
      ],
      {
        cwd: repoDir,
        env: options.env ?? createIndependentPrFixtureEnv(),
        stdio: options.stdio ?? "ignore",
      },
    ),
  );
}

function runLockShell(repoDir: string, commands: string[]) {
  return spawnSync("bash", ["-c", [...bashSource(repoDir), ...commands].join("\n")], {
    cwd: repoDir,
    env: createIndependentPrFixtureEnv(),
    detached: true,
    encoding: "utf8",
    timeout: 10_000,
  });
}

function expectResult(result: ReturnType<typeof runLockShell>, status: number, stdout: string) {
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(status);
  expect(result.stdout.trim()).toBe(stdout);
}

function gitOverride(commands: string[]) {
  return ["pr_git() {", ...commands, '  command git "$@"', "}"];
}

function expectRecovery(stderr: string, ownerOid: string) {
  expect(stderr).toContain(`scripts/pr lock-recover 42 ${ownerOid} --confirmed-no-running-tools`);
}

function addWorktree(repoDir: string, branch = "pr-42", name = branch) {
  const path = join(repoDir, ".worktrees", name);
  gitOutput(repoDir, ["worktree", "add", "-q", "-b", branch, path]);
  return path;
}

function captureStatus(command: string, output = 'printf "%s\\n" "$lock_status"') {
  return ["set +e", command, "lock_status=$?", "set -e", output];
}

function runStatus(repoDir: string, command: string, output?: string) {
  return runLockShell(repoDir, captureStatus(command, output));
}

function probeOperationLock(repoDir: string, command: "blocking" | "try" = "try") {
  return runStatus(
    repoDir,
    command === "try" ? "try_acquire_pr_operation_lock 42" : "acquire_pr_operation_lock 42",
  );
}

function recoverOperationLock(repoDir: string, ownerOid: string, commands: string[] = []) {
  const result = runLockShell(repoDir, [
    `recover_pr_operation_lock 42 '${ownerOid}' --confirmed-no-running-tools`,
    ...commands,
  ]);
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  expect(refExists(repoDir)).toBe(false);
}

async function withHeldLock(
  repoDir: string,
  signal: AbortSignal,
  check: (holder: ChildProcess) => void | Promise<void>,
  pr = 42,
  trapTerm = true,
) {
  const statusFile = join(repoDir, `held-${holderSequence++}`);
  const traps = trapTerm
    ? [
        "trap release_pr_operation_lock EXIT",
        "trap 'exit 129' HUP",
        "trap 'exit 130' INT",
        "trap 'exit 143' TERM",
      ]
    : [];
  const child = spawnDetached(
    "bash",
    [
      "-c",
      [
        ...bashSource(repoDir),
        ...traps,
        `acquire_pr_operation_lock ${pr}`,
        `printf 'held\\n' >'${statusFile}'`,
        "printf 'held\\n'",
        "while :; do sleep 1; done",
      ].join("\n"),
    ],
    { cwd: repoDir, stdio: ["ignore", "pipe", "ignore"] },
  );
  try {
    await withinTest(
      outputBeforeExit(child, child.stdout!, "held\n", `holder did not publish ${statusFile}`),
      signal,
    );
    expect(existsSync(statusFile)).toBe(true);
    await check(child);
  } finally {
    await cleanupChildren(child);
  }
}

// Cleanup may run after test abort; these orphan groups have no retained reaper.
// Keep the existing bound until an independent owner can join their exact exits.
async function waitForCleanup(predicate: () => boolean, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return true;
    }
    await delay(5);
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

function requireProcessId(path: string) {
  const pid = readProcessIdFile(path);
  if (pid === undefined) {
    throw new Error(`process id was not written to ${path}`);
  }
  goneProcessGroups.delete(pid);
  return pid;
}

async function stopChild(child: ChildProcess, signal: NodeJS.Signals) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  signalTestChild(child, signal);
  await childCompletion(child);
}

async function cleanupChildren(...children: Array<ChildProcess | undefined>) {
  await cleanupAll(
    children.map((child) => async () => {
      if (child && child.exitCode === null && child.signalCode === null) {
        signalTestChild(child, "SIGKILL");
        await childCompletion(child);
      }
    }),
    "failed to clean up operation-lock test children",
  );
}

async function cleanupAll(actions: Array<() => Promise<void>>, message: string) {
  const failures: unknown[] = [];
  for (const action of actions) {
    try {
      await action();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, message);
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
  if (!(await waitForCleanup(() => !processGroupExists(pgid), 2000))) {
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
  try {
    const payload = execFileSync("git", ["cat-file", "blob", lockRef], {
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

function gitStatus(repoDir: string, args: string[], env?: NodeJS.ProcessEnv) {
  return spawnSync("git", args, { cwd: repoDir, env }).status;
}

function refOid(repoDir: string, ref = lockRef, env?: NodeJS.ProcessEnv) {
  return execFileSync("git", ["rev-parse", ref], { cwd: repoDir, encoding: "utf8", env }).trim();
}

function refExists(repoDir: string, ref = lockRef, env?: NodeJS.ProcessEnv) {
  return gitStatus(repoDir, ["show-ref", "--verify", "--quiet", ref], env) === 0;
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
  it.runIf(process.platform !== "win32")(
    "preserves exit status when completion FD is closed",
    async ({ repoDir, signal }) => {
      const fixture = writeExecutable(repoDir, "closed-completion-fd.sh", [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        `source '${lockScript}'`,
        "exit 7",
      ]);
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
        await withinTest(childCompletion(child), signal);
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

  it.for([
    ["ls-files --others --exclude-standard -z", "require_no_foreign_untracked"],
    ["ls-files --others --ignored --exclude-standard -z", "require_no_ignored_transition_paths"],
    ["ls-tree -r -z", "validate_review_transition_state"],
  ] as const)("rejects failed %s reads in %s", ([query, guard], { repoDir }) => {
    const head = refOid(repoDir, "HEAD");
    writeFileSync(join(repoDir, "base.txt"), "target\n");
    execFileSync("git", ["commit", "-qam", "target fixture"], { cwd: repoDir });
    const target = refOid(repoDir, "HEAD");
    execFileSync("git", ["checkout", "--detach", head], { cwd: repoDir });
    const binDir = tempDirs.make("openclaw-pr-query-failure-");
    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    writeExecutable(binDir, "git", [
      "#!/usr/bin/env bash",
      'args=("$@")',
      'while [ "${1:-}" = -c ]; do shift 2; done',
      `case "$*" in ${JSON.stringify(query)}*) echo 'fixture query failed' >&2; exit 7 ;; esac`,
      `exec '${realGit}' "\${args[@]}"`,
    ]);
    const result = runLockShell(repoDir, [
      `export PATH='${binDir}':"$PATH"`,
      `${guard} 42 ${head} ${target} || exit $?`,
    ]);
    expect(result.stderr).toContain("fixture query failed");
    expect(result.status, result.stdout + result.stderr).not.toBe(0);
  });

  it.for(["review-init", "review-claim"])(
    "releases %s on auth failure without changing artifacts",
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
  it("ignores a late exact-OID release after successor acquisition", async ({
    repoDir,
    signal,
  }) => {
    await withHeldLock(
      repoDir,
      signal,
      async (first) => {
        const oldOid = refOid(repoDir);
        await withinTest(stopChild(first, "SIGKILL"), signal);
        await waitForProcessGroupExit(first.pid!, signal);
        recoverOperationLock(repoDir, oldOid);
        await withHeldLock(repoDir, signal, () => {
          const successorOid = refOid(repoDir);
          const lateRelease = runLockShell(repoDir, [
            `PR_OPERATION_LOCK_REF='${lockRef}'`,
            `PR_OPERATION_LOCK_OWNER_OID='${oldOid}'`,
            "release_pr_operation_lock",
          ]);
          expect(lateRelease.status, `${lateRelease.stdout}\\n${lateRelease.stderr}`).toBe(0);
          expect(refOid(repoDir)).toBe(successorOid);
        });
      },
      42,
      false,
    );
  });
  it("requires confirmation and the current recovery OID", async ({ repoDir, signal }) => {
    await withHeldLock(
      repoDir,
      signal,
      () => {
        const ownerOid = refOid(repoDir);
        const wrongOid = gitOutput(repoDir, ["rev-parse", "HEAD"]).trim();
        const unconfirmed = runStatus(repoDir, `recover_pr_operation_lock 42 '${ownerOid}'`);
        expectResult(unconfirmed, 0, "2");
        expect(unconfirmed.stderr).toContain("Recovery requires --confirmed-no-running-tools");
        expect(refOid(repoDir)).toBe(ownerOid);
        const wrongOwner = runStatus(
          repoDir,
          `recover_pr_operation_lock 42 '${wrongOid}' --confirmed-no-running-tools`,
        );
        expectResult(wrongOwner, 0, "1");
        expect(refOid(repoDir)).toBe(ownerOid);
      },
      42,
      false,
    );
  });
  it("preserves a successor after failed recovery CAS", ({ repoDir }) => {
    const result = runLockShell(repoDir, [
      "owner_oid=$(printf 'owner-lock\\n' | git hash-object -w --stdin)",
      "successor_oid=$(printf 'successor-lock\\n' | git hash-object -w --stdin)",
      `git update-ref '${lockRef}' "$owner_oid"`,
      ...gitOverride([
        `  if [ "$*" = "-C ${repoDir} update-ref --no-deref -d ${lockRef} $owner_oid" ]; then`,
        `    command git -C '${repoDir}' update-ref '${lockRef}' "$successor_oid" "$owner_oid"`,
        "    return 1",
        "  fi",
      ]),
      ...captureStatus(
        'recover_pr_operation_lock 42 "$owner_oid" --confirmed-no-running-tools',
        `printf '%s\\t%s\\n' "$lock_status" "$(command git rev-parse '${lockRef}')"`,
      ),
    ]);
    const successorOid = execFileSync("git", ["hash-object", "--stdin"], {
      cwd: repoDir,
      input: "successor-lock\n",
      encoding: "utf8",
    }).trim();
    expectResult(result, 0, `1\t${successorOid}`);
    expect(result.stderr).toContain("owner changed during recovery");
  });
  it("runs lock recovery without the normal PR toolchain", ({ repoDir }) => {
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
    expectResult(result, 0, "Recovered the stale operation lock for PR #42.");
    expect(refExists(repoDir)).toBe(false);
  });
  it.for([
    ["ambient group marker", "review_init() { :; }", "", "", false],
    [
      "unavailable storage",
      "review_init() { printf 'review ran\\n'; }",
      "mktemp: No space left on device",
      "review ran",
      true,
    ],
    [
      "metadata failure",
      "enter_worktree() { printf 'entered-worktree\\n'; }\npr_meta_json() { echo 'fixture metadata failure' >&2; return 1; }",
      "fixture metadata failure",
      "entered-worktree",
      false,
    ],
  ] as const)(
    "releases validation locks after %s",
    ([name, overrides, error, unexpectedOutput, unavailableStorage], { repoDir }) => {
      const { binDir, cli } = installPrCliFixture(repoDir);
      const reviewScript = join(repoDir, "scripts/pr-lib/review.sh");
      writeFileSync(reviewScript, `${readFileSync(reviewScript, "utf8")}\n${overrides}\n`);
      installRequiredPrCommandStubs(binDir);
      if (unavailableStorage) {
        writeFileSync(
          join(binDir, "mktemp"),
          "#!/bin/sh\necho 'mktemp: No space left on device' >&2\nexit 1\n",
          { mode: 0o755 },
        );
      }
      const result = spawnSync(cli, ["review-init", "42"], {
        cwd: repoDir,
        encoding: "utf8",
        env: {
          ...createIndependentPrFixtureEnv(),
          ...(name === "ambient group marker" ? { OPENCLAW_PR_DEDICATED_PROCESS_GROUP: "1" } : {}),
          PATH: `${binDir}:${process.env.PATH ?? ""}`,
        },
      });
      expect(result.status, result.stderr).toBe(error ? 1 : 0);
      expect(refExists(repoDir), result.stderr).toBe(false);
      if (error) {
        expect(result.stderr).toContain(error);
        expect(result.stderr).not.toContain("Retaining the operation lock");
        expect(result.stderr).not.toContain("scripts/pr lock-recover");
        expect(result.stdout).not.toContain(unexpectedOutput);
      }
      if (unavailableStorage) {
        expect(result.stderr).toContain("temporary-storage preflight failed");
        expect(result.stderr).toContain("Free disk space or set TMPDIR");
      }
    },
  );
  it("retries release between failed create CAS and ref read", ({ repoDir }) => {
    const raceTriggered = join(repoDir, "race-triggered");
    const result = runLockShell(repoDir, [
      "prepare_pr_operation_lock_candidate 99",
      "old_oid=$PR_OPERATION_LOCK_CANDIDATE_OID",
      `git update-ref '${lockRef}' "$old_oid"`,
      ...gitOverride([
        `  if [ ! -e '${raceTriggered}' ] && [[ "$*" == *"rev-parse --verify ${lockRef}"* ]]; then`,
        `    : >'${raceTriggered}'`,
        `    command git -C '${repoDir}' update-ref --no-deref -d '${lockRef}' "$old_oid"`,
        "    return 1",
        "  fi",
      ]),
      "acquire_pr_operation_lock 42",
      "release_pr_operation_lock",
    ]);
    expect(result.status).toBe(0);
    expect(existsSync(raceTriggered)).toBe(true);
  });
  it("retries supervisor release before an orphan verdict", ({ repoDir }) => {
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
  it("rejects noncanonical aliases for the same PR number", ({ repoDir }) => {
    const result = runLockShell(repoDir, [
      "set +e",
      "try_acquire_pr_operation_lock 00042",
      "lock_status=$?",
      "pr_number_from_worktree_dir .worktrees/pr-00042 >/dev/null",
      "parse_status=$?",
      "set -e",
      'printf "%s\t%s\n" "$lock_status" "$parse_status"',
    ]);
    expectResult(result, 0, "2\t1");
  });
  it.for([
    [3, false],
    [137, true],
  ] as const)(
    "handles validation exit %s (retained=%s)",
    async ([status, retained], { repoDir, signal }) => {
      const result = await runSupervisedOperation(
        repoDir,
        ["acquire_pr_operation_lock 42", "begin_pr_operation_validation_phase", `exit ${status}`],
        { signal },
      );
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(status);
      if (retained) {
        const ownerOid = refOid(repoDir);
        expect(result.stderr).toContain(`reason: child exited with code ${status}`);
        recoverOperationLock(repoDir, ownerOid);
      } else {
        expect(refExists(repoDir)).toBe(false);
        expect(result.stderr).not.toContain("Retaining the operation lock");
      }
    },
  );
  it.for([false, true])(
    "cleans linked GC worktrees before exact-owner release (failure=%s)",
    (failure, { repoDir }) => {
      const { binDir, wrapperSources } = installPrCliFixture(repoDir);
      writeExecutable(binDir, "rg", [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        'if [ "$#" -ne 4 ] || [ "$1" != "-n" ] || [ "$2" != "-i" ]; then',
        '  echo "unexpected fixture rg call: $*" >&2',
        "  exit 99",
        "fi",
        'exec grep -n -i -E -- "$3" "$4"',
      ]);
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
      const gh = writeExecutable(binDir, "gh", [
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
      const realGit = realpathSync(join(binDir, "git"));
      unlinkSync(join(binDir, "git"));
      writeExecutable(binDir, "git", [
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
        expectRecovery(result.stderr, ownerOid);
      } else {
        expect(result.stderr).not.toContain("Retaining the operation lock");
      }
    },
  );
  it("reports exact recovery when lock notification fails", ({ repoDir }) => {
    const result = runLockShell(repoDir, [
      "OPENCLAW_PR_LOCK_NOTIFY_FD=9",
      ...captureStatus("acquire_pr_operation_lock 42"),
    ]);
    expectResult(result, 0, "2");
    const ownerOid = refOid(repoDir);
    expectRecovery(result.stderr, ownerOid);
    recoverOperationLock(repoDir, ownerOid);
  });
  it("rejects another group's lock notification", async ({ repoDir, signal }) => {
    const foreignRef = "refs/openclaw/pr-operation-locks/43";
    await withHeldLock(
      repoDir,
      signal,
      async () => {
        const foreignOid = refOid(repoDir, foreignRef);
        const result = await runSupervisedOperation(
          repoDir,
          [
            "acquire_pr_operation_lock 42",
            `printf '%s\\t%s\\n' '${foreignRef}' '${foreignOid}' >&"$OPENCLAW_PR_LOCK_NOTIFY_FD"`,
          ],
          { signal },
        );
        expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(1);
        expect(refOid(repoDir, foreignRef)).toBe(foreignOid);
        expect(refExists(repoDir)).toBe(true);
        expect(result.stderr).toContain("operation lock owned by another process group");
        const ownerOid = refOid(repoDir);
        recoverOperationLock(repoDir, ownerOid);
      },
      43,
    );
  });
  it.for([
    [
      "retains the lock after newline-terminated malformed supervisor metadata",
      "printf 'not-lock-metadata\\n'",
      "malformed operation-lock metadata",
    ],

    [
      "bounds an oversized unterminated supervisor metadata line",
      `node -e 'process.stdout.write("x".repeat(8192))'`,
      "operation-lock metadata line is too large",
    ],
  ] as const)("%s", async ([_title, command, expectedError], { repoDir, signal }) => {
    const result = await runSupervisedOperation(
      repoDir,
      ["acquire_pr_operation_lock 42", `${command} >&"$OPENCLAW_PR_LOCK_NOTIFY_FD"`],
      { signal },
    );
    const ownerOid = refOid(repoDir);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(1);
    expect(result.stderr).toContain(expectedError);
    expectRecovery(result.stderr, ownerOid);
    recoverOperationLock(repoDir, ownerOid);
  });
  it("joins Git read producers before releasing the lock", async ({ repoDir, signal }) => {
    mkdirSync(join(repoDir, ".local"));
    const producerExited = join(repoDir, ".local", "worktree-producer-exited");
    const binDir = tempDirs.make("openclaw-pr-joined-query-");
    const queryExited = join(binDir, "query-exited");
    const validatorStarted = join(binDir, "validator-started");
    const validatorExited = join(binDir, "validator-exited");
    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    writeExecutable(binDir, "git", [
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
    const result = await runSupervisedOperation(
      repoDir,
      [
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
      ],
      { signal },
      ".local/joined-worktree-operation.sh",
    );
    expect(result.status, result.stdout + "\n" + result.stderr).toBe(0);
    expect(existsSync(producerExited)).toBe(true);
    expect(refExists(repoDir)).toBe(false);
    expect(result.stderr).not.toContain("process group remained active after wrapper exit");
  });
  it.for(["clean", "suppressed", "effects"] as const)(
    "settles %s completion while an escaped child holds the notification pipe",
    async (mode, { repoDir, signal }) => {
      const operationPgidFile = join(repoDir, "operation-pgid");
      const holderPidFile = join(repoDir, "holder-pgid");
      escapedPipeHolderPidFiles.add(holderPidFile);
      const launcher = writeEscapedPipeHolderLauncher(repoDir, holderPidFile);
      let holderPgid: number | undefined;
      try {
        const startedAt = Date.now();
        const result = await runSupervisedOperation(
          repoDir,
          [
            `printf '%s\\n' "$$" >'${operationPgidFile}'`,
            "acquire_pr_operation_lock 42",
            ...(mode === "suppressed" ? ["trap - EXIT"] : []),
            ...(mode === "effects"
              ? [
                  "begin_pr_operation_validation_phase",
                  "mark_pr_operation_side_effects_started",
                  // A forged phase cannot reopen the validation release window.
                  "notify_pr_operation_phase validation-started",
                ]
              : []),
            `node '${launcher}'`,
            ...(mode === "effects" ? ["exit 1"] : []),
          ],
          { signal, accelerateTimeouts: true, materializedAnchor: mode === "clean" },
        );
        const elapsed = Date.now() - startedAt;
        holderPgid = requireProcessId(holderPidFile);
        expect(result.status, result.stderr).toBe(mode === "clean" ? 0 : 1);
        expect(processGroupExists(holderPgid)).toBe(true);
        if (mode === "clean") {
          const operationPgid = requireProcessId(operationPgidFile);
          expect(operationPgid).not.toBe(holderPgid);
          expect(processGroupExists(operationPgid)).toBe(false);
          expect(refExists(repoDir)).toBe(false);
          for (const text of ["Warning:", "group=dead, pipe=open", "#124583"]) {
            expect(result.stderr).toContain(text);
          }
          expect(existsSync(join(result.anchorDir!, "scripts/pr"))).toBe(true);
        } else {
          const ownerOid = refOid(repoDir);
          if (mode === "suppressed") {
            expect(result.stderr).toContain(
              "reason: notification pipe still open after drain deadline",
            );
            expect(result.stderr).toContain(
              "scripts/pr operation lifetime did not drain (group=dead, pipe=open)",
            );
            expect(result.stderr).not.toContain("Warning:");
            const blocked = probeOperationLock(repoDir);
            expectResult(blocked, 0, "2");
          } else {
            expect(elapsed).toBeLessThan(12_000);
            expect(result.stderr).toContain("operation lifetime did not drain");
            expect(result.stderr).toContain(
              "reason: child exited with code 1; notification pipe still open after drain deadline",
            );
          }
          killProcessGroup(holderPgid, "SIGKILL");
          await waitForProcessGroupExit(holderPgid, signal);
          recoverOperationLock(repoDir, ownerOid);
        }
      } finally {
        await cleanupRecordedProcessGroup(holderPidFile, holderPgid);
      }
    },
    15_000,
  );
  it("releases failed side effects after group and pipe drain", async ({ repoDir, signal }) => {
    const result = await runSupervisedOperation(
      repoDir,
      [
        "acquire_pr_operation_lock 42",
        "begin_pr_operation_validation_phase",
        "mark_pr_operation_side_effects_started",
        "exit 1",
      ],
      { signal },
    );
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(1);
    expect(result.stderr).toContain(
      "Released the operation lock for PR #42 after exit code 1; its process group and every notification-pipe holder exited.",
    );
    expect(result.stderr).not.toContain("lock-recover");
    expect(refExists(repoDir)).toBe(false);
  });
  it("waits for a live supervisor to finish draining a dead group", async ({ repoDir, signal }) => {
    const operationPgidFile = join(repoDir, "finishing-operation-pgid");
    const holderPidFile = join(repoDir, "finishing-holder-pgid");
    const acquiredFile = join(repoDir, "finishing-waiter-acquired");
    const holderReady = join(repoDir, "finishing-holder-ready");
    const holderScript = writeFixtureFile(repoDir, "finishing-holder.mjs", [
      'import fs from "node:fs";',
      fixtureReceiptClientSource(receipts.endpoint),
      `fs.writeFileSync(${JSON.stringify(holderReady)}, "ready");`,
      `sendReceipt(${JSON.stringify(holderReady)}, "ready");`,
      "setInterval(() => {}, 1000);",
    ]);
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
    const controller = startOperation(repoDir, [
      `printf '%s\\n' "$$" >'${operationPgidFile}'`,
      "acquire_pr_operation_lock 42",
      `node '${launcherScript}'`,
    ]);
    let waiter: ChildProcess | undefined;
    let holderPgid: number | undefined;
    try {
      await withinTest(
        fixtureEventBeforeSettlement(holderReady, childCompletion(controller)),
        signal,
      );
      const operationPgid = requireProcessId(operationPgidFile);
      await waitForProcessGroupExit(operationPgid, signal);
      holderPgid = requireProcessId(holderPidFile);
      expect(refExists(repoDir)).toBe(true);
      const probe = probeOperationLock(repoDir);
      expectResult(probe, 0, "1");
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
      await withinTest(
        outputBeforeExit(
          waiter,
          waiter.stderr!,
          "Waiting for the active scripts/pr operation on PR #42 to finish...",
          "waiter did not report the active operation",
        ),
        signal,
      );
      expect(existsSync(acquiredFile)).toBe(false);
      expect(controller.exitCode).toBeNull();
      expect(processGroupExists(holderPgid)).toBe(true);
      killProcessGroup(holderPgid, "SIGTERM");
      await withinTest(childCompletion(controller), signal);
      await withinTest(childCompletion(waiter), signal);
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
  it("retains the lock when a clean wrapper leaves group work", async ({ repoDir, signal }) => {
    const operationPgidFile = join(repoDir, "clean-background-operation-pgid");
    const backgroundPidFile = join(repoDir, "clean-background-pid");
    const ownerFile = join(repoDir, "clean-background-owner");
    let operationPgid: number | undefined;
    try {
      const result = await runSupervisedOperation(
        repoDir,
        [
          `printf '%s\\n' "$$" >'${operationPgidFile}'`,
          "acquire_pr_operation_lock 42",
          `printf '%s\\n' "$PR_OPERATION_LOCK_OWNER_OID" >'${ownerFile}'`,
          "sleep 30 &",
          `printf '%s\\n' "$!" >'${backgroundPidFile}'`,
          "exit 0",
        ],
        { signal },
      );
      operationPgid = requireProcessId(operationPgidFile);
      const backgroundPid = requireProcessId(backgroundPidFile);
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
      expectRecovery(result.stderr, ownerOid);
      recoverOperationLock(repoDir, ownerOid);
    } finally {
      await cleanupRecordedProcessGroup(operationPgidFile, operationPgid);
    }
  });
  it("keeps supervisor ownership until GC exits", async ({ repoDir, signal }) => {
    addWorktree(repoDir);
    const ghStarted = join(repoDir, "gc-gh-started");
    const outputFile = join(repoDir, "gc-output");
    const controller = startOperation(
      repoDir,
      [
        "pr_gh() {",
        `  : >'${ghStarted}'`,
        `  ${fixtureReceiptCommand(repoDir, ghStarted)}`,
        "  read -r release",
        "  printf 'MERGED\\n'",
        "}",
        `gc_pr_worktrees true >'${outputFile}'`,
      ],
      { stdio: ["pipe", "ignore", "ignore"] },
    );
    try {
      await withinTest(
        fixtureEventBeforeSettlement(ghStarted, childCompletion(controller)),
        signal,
      );
      expect(existsSync(ghStarted) && refExists(repoDir)).toBe(true);
      const probe = probeOperationLock(repoDir);
      expectResult(probe, 0, "1");
      controller.stdin!.end("continue\n");
      await withinTest(childCompletion(controller), signal);
      expect(controller.exitCode).toBe(0);
      expect(readFileSync(outputFile, "utf8")).toContain("would remove .worktrees/pr-42");
      expect(refExists(repoDir)).toBe(false);
    } finally {
      controller.stdin!.end();
      await cleanupController(repoDir, controller);
    }
  });
  it("preserves the exact lock after controller death", async ({ repoDir, signal }) => {
    const pidFile = join(repoDir, "operation-pgid");
    const held = join(repoDir, "held");
    const controller = startOperation(repoDir, [
      `printf '%s\\n' "$$" >'${pidFile}'`,
      "acquire_pr_operation_lock 42",
      `printf 'held\\n' >'${held}'`,
      fixtureReceiptCommand(repoDir, held),
      "while :; do sleep 1; done",
    ]);
    let pgid: number | undefined;
    try {
      await withinTest(fixtureEventBeforeSettlement(held, childCompletion(controller)), signal);
      expect(existsSync(pidFile) && existsSync(held)).toBe(true);
      pgid = requireProcessId(pidFile);
      const ownerOid = refOid(repoDir);
      expect(processGroupExists(pgid!)).toBe(true);
      await withinTest(stopChild(controller, "SIGKILL"), signal);
      expect(processGroupExists(pgid!)).toBe(true);
      expect(refOid(repoDir)).toBe(ownerOid);
      const blockedWhileGroupLives = runStatus(
        repoDir,
        "try_acquire_pr_operation_lock 42",
        'printf "%s\\t%s\\t%s\\n" "$lock_status" "$PR_OPERATION_LOCK_BLOCKED_REASON" "$PR_OPERATION_LOCK_BLOCKED_OID"',
      );
      expectResult(blockedWhileGroupLives, 0, `2\torphaned\t${ownerOid}`);
      expect(processGroupExists(pgid!)).toBe(true);
      expect(refOid(repoDir)).toBe(ownerOid);
      killProcessGroup(pgid!, "SIGTERM");
      await waitForProcessGroupExit(pgid!, signal);
      const blocked = probeOperationLock(repoDir, "blocking");
      expectResult(blocked, 0, "2");
      expect(refOid(repoDir)).toBe(ownerOid);
      recoverOperationLock(repoDir, ownerOid, [
        "acquire_pr_operation_lock 42",
        "release_pr_operation_lock",
      ]);
    } finally {
      await cleanupController(repoDir, controller, pidFile);
    }
  });
  it("escalates signals, drains the group, and retains the lock", async ({ repoDir, signal }) => {
    const pidFile = join(repoDir, "operation-pgid");
    const childReady = join(repoDir, "child-ready");
    const controller = startOperation(
      repoDir,
      [
        `printf '%s\\n' "$$" >'${pidFile}'`,
        "trap 'exit 143' TERM",
        "acquire_pr_operation_lock 42",
        "(",
        "  trap '' HUP INT TERM",
        `  printf 'ready\\n' >'${childReady}'`,
        `  ${fixtureReceiptCommand(repoDir, childReady)}`,
        "  while :; do sleep 1; done",
        ") &",
        'wait "$!"',
      ],
      {
        preload: createProcessGroupTimingPreload(
          tempDirs.make("openclaw-pr-operation-lock-timing-"),
          {
            accelerateClock: false,
          },
        ),
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    let stderr = "";
    let stderrOverflow = false;
    controller.stderr!.setEncoding("utf8");
    controller.stderr!.on("data", (chunk: string) => {
      if (stderrOverflow || Buffer.byteLength(stderr) + Buffer.byteLength(chunk) > 16 * 1024) {
        stderrOverflow = true;
        return;
      }
      stderr += chunk;
    });
    let pgid: number | undefined;
    try {
      await withinTest(
        fixtureEventBeforeSettlement(childReady, childCompletion(controller)),
        signal,
      );
      expect(existsSync(pidFile) && existsSync(childReady)).toBe(true);
      pgid = requireProcessId(pidFile);
      const ownerOid = refOid(repoDir);
      const closed = childCompletion(controller, "close");
      controller.kill("SIGTERM");
      await withinTest(closed, signal);
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
  it("retains the lock when a nested group escapes cancellation", async ({
    onTestFinished,
    signal,
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
        fixtureReceiptClientSource(receipts.endpoint),
        'process.on("SIGTERM", () => { fs.writeFileSync(process.argv[3], "relayed\\n"); sendReceipt(process.argv[3], "ready"); });',
        "fs.writeFileSync(process.argv[2], String(process.pid));",
        'sendReceipt(process.argv[2], "ready");',
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
      const controller = startOperation(
        repoDir,
        ["acquire_pr_operation_lock 42", `node '${relayScript}'`],
        {
          // The test deliberately kills the relay before its managed claim can release.
          // Only this fixture's independent group census may dispose its retained inputs.
          env: { ...createIndependentPrFixtureEnv(), TMPDIR: repoDir, TMP: repoDir, TEMP: repoDir },
        },
      );
      let nestedPgid: number | undefined;
      try {
        await withinTest(
          fixtureEventBeforeSettlement(nestedPidFile, childCompletion(controller)),
          signal,
        );
        expect(existsSync(nestedPidFile) && refExists(repoDir)).toBe(true);
        nestedPgid = requireProcessId(nestedPidFile);
        const ownerOid = refOid(repoDir);
        expect(processGroupExists(nestedPgid!)).toBe(true);
        controller.kill("SIGTERM");
        await withinTest(
          fixtureEventBeforeSettlement(signalRelayedFile, childCompletion(controller)),
          signal,
        );
        expect(existsSync(signalRelayedFile)).toBe(true);
        controller.kill("SIGTERM");
        await withinTest(childCompletion(controller), signal);
        expect(controller.exitCode).toBe(143);
        expect(processGroupExists(nestedPgid!)).toBe(true);
        expect(refOid(repoDir)).toBe(ownerOid);
        const blocked = probeOperationLock(repoDir);
        expectResult(blocked, 0, "2");
        expect(() => resourceOwner.assertReleased()).toThrow("Unreleased Vitest resource claim");
        killProcessGroup(nestedPgid!, "SIGKILL");
        await waitForProcessGroupExit(nestedPgid!, signal);
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
  it("skips active PRs during GC", async ({ repoDir, signal }) => {
    mkdirSync(join(repoDir, ".worktrees", "pr-42"), { recursive: true });
    await withHeldLock(repoDir, signal, () => {
      const result = runLockShell(repoDir, [
        "pr_gh() { if [ \"$1 $2\" = 'repo view' ]; then printf 'openclaw/openclaw\\n'; else printf 'MERGED\\n'; fi; }",
        "gc_pr_worktrees false",
      ]);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("has an active scripts/pr operation");
      expect(existsSync(join(repoDir, ".worktrees", "pr-42"))).toBe(true);
    });
  });
  it("reports recovery for unreadable GC locks", ({ repoDir }) => {
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
    expectRecovery(result.stderr, refOid(repoDir));
    expect(existsSync(worktreeDir)).toBe(true);
  });
  it("removes NUL-framed escaped Unicode worktree paths", () => {
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
    expectResult(located, 0, canonicalWorktreeDir);
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
  it.for([
    { name: "failed", listing: "worktree %s\\0branch refs/heads/pr-42\\0\\0", code: 23 },
    { name: "truncated", listing: "worktree %s\\0branch refs/heads/pr-42", code: 0 },
  ])("rejects $name NUL-framed worktree listings", ({ listing, code }, { repoDir }) => {
    const result = runLockShell(repoDir, [
      ...gitOverride([
        '  if [ "${1:-} ${2:-}" = "worktree list" ]; then',
        `    printf '${listing}' "$PWD"`,
        `    return ${code}`,
        "  fi",
      ]),
      "set +e",
      'worktree_registration_state "$PWD" >/dev/null',
      'registered_status="$?"',
      "worktree_path_for_branch pr-42 >/dev/null",
      'branch_status="$?"',
      'printf "%s %s\\n" "$registered_status" "$branch_status"',
    ]);
    expectResult(result, 0, `${code || 1} ${code || 1}`);
  });
  it.for(["already absent", "deleted natively"])(
    "preserves descendants when the exact branch is %s",
    (state, { repoDir }) => {
      const branch = "temp/pr-42";
      const sibling = join(repoDir, ".worktrees", "pr-99");
      const head = gitOutput(repoDir, ["rev-parse", "HEAD"]);
      const absent = state === "already absent";
      if (absent) {
        addWorktree(repoDir, `${branch}/topic`, "pr-99");
        gitOutput(repoDir, ["branch", "pr-42-prep"]);
      } else {
        gitOutput(repoDir, ["branch", branch]);
      }
      const result = runLockShell(repoDir, [
        ...(absent
          ? ['cleanup_pr_worktree ".worktrees/pr-42" || exit $?']
          : [
              "pr_git() {",
              '  command git "$@" || return $?',
              `  if [ "$*" = "branch -d -- ${branch}" ]; then`,
              `    command git worktree add -q -b ${branch}/topic .worktrees/pr-99 || return $?`,
              "  fi",
              "}",
              `delete_local_branch_if_safe ${branch} || exit $?`,
            ]),
        "echo cleanup-completed",
      ]);
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(result.stdout).toContain("cleanup-completed");
      expect(gitOutput(repoDir, ["rev-parse", `refs/heads/${branch}/topic`])).toBe(head);
      expect(gitOutput(sibling, ["rev-parse", "HEAD"])).toBe(head);
      expectWorktreeBranch(sibling, `${branch}/topic`);
      if (absent) {
        expect(
          gitStatus(repoDir, ["show-ref", "--verify", "--quiet", "refs/heads/pr-42-prep"]),
        ).toBe(1);
      }
    },
  );
  it.for([23, 0])(
    "preserves sibling branches on unavailable listings (%s)",
    (code, { repoDir }) => {
      const sibling = addWorktree(repoDir, "pr-42", "pr-99");
      const head = gitOutput(repoDir, ["rev-parse", "refs/heads/pr-42"]);
      const result = runLockShell(repoDir, [
        ...gitOverride([
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
        ]),
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
  it.for([
    ["branch query", 23, ""],
    ["broken ref", undefined, "broken ref"],
    ["native remove", 73, "fixture remove failure"],
    ["locked", undefined, ""],
    ["retained-admin", undefined, ""],
    ["ENOTDIR", undefined, "ENOTDIR"],
  ] as const)(
    "preserves cleanup state after %s failure",
    ([fault, code, diagnostic], { repoDir }) => {
      const worktree = join(repoDir, ".worktrees", "pr-42");
      const registered = ["native remove", "locked", "retained-admin"].includes(fault);
      if (registered) {
        gitOutput(repoDir, ["worktree", "add", "-q", "-b", "pr-42", worktree]);
      } else {
        gitOutput(repoDir, ["branch", "pr-42"]);
      }
      const admin = registered
        ? gitOutput(worktree, ["rev-parse", "--absolute-git-dir"]).trim()
        : "";
      const ref = join(repoDir, ".git", "refs", "heads", "pr-42");
      if (fault === "broken ref") {
        writeFileSync(ref, "broken\n");
      }
      if (fault === "ENOTDIR") {
        writeFileSync(join(repoDir, ".worktrees"), "not a directory\n");
      }
      if (fault === "locked") {
        gitOutput(repoDir, ["worktree", "lock", worktree]);
        rmSync(worktree, { recursive: true });
      }
      const overrides: string[] = [];
      if (fault === "branch query") {
        overrides.push(
          '  if [ "$1" = for-each-ref ] && [[ "$*" == *" -- refs/heads/pr-42" ]]; then',
          '    command git "$@" || return $?',
          "    return 23",
          "  fi",
        );
      }
      if (fault === "native remove") {
        overrides.push(
          "  if [ \"$1 $2\" = 'worktree remove' ]; then",
          '    command git "$@" || return $?',
          "    echo 'fixture remove failure' >&2",
          "    return 73",
          "  fi",
        );
      }
      if (fault === "locked" || fault === "retained-admin") {
        overrides.push(
          '  if [[ "$*" == *"worktree prune"* ]]; then echo unexpected-prune >&2; return 97; fi',
        );
        if (fault === "retained-admin") {
          overrides.push(
            '  if [ "${1:-} ${2:-}" = "worktree remove" ]; then',
            "    rm -rf -- .worktrees/pr-42",
            "    : > .git/worktrees/pr-42/gitdir",
            "    return 0",
            "  fi",
          );
        }
      }
      const result = runLockShell(repoDir, [
        ...gitOverride(overrides),
        'cleanup_pr_worktree ".worktrees/pr-42" || exit $?',
        "echo unexpected-cleanup-completed",
      ]);
      if (code === undefined) {
        expect(result.status, result.stderr).not.toBe(0);
      } else {
        expect(result.status, result.stderr).toBe(code);
      }
      expect(result.stdout).not.toContain("unexpected-cleanup-completed");
      if (diagnostic) {
        expect(result.stderr).toContain(diagnostic);
      }
      if (fault === "broken ref") {
        expect(readFileSync(ref, "utf8")).toBe("broken\n");
      } else {
        expect(gitStatus(repoDir, ["show-ref", "--verify", "--quiet", "refs/heads/pr-42"])).toBe(0);
      }
      if (fault === "native remove") {
        expect(existsSync(worktree)).toBe(false);
      }
      if (fault === "locked" || fault === "retained-admin") {
        expect(existsSync(admin)).toBe(true);
        expect(result.stderr).not.toContain("unexpected-prune");
      }
      if (fault === "ENOTDIR") {
        expect(readFileSync(join(repoDir, ".worktrees"), "utf8")).toBe("not a directory\n");
      }
    },
  );
  it("parses file lists without temp files or producers", ({ repoDir }) => {
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
    expectResult(result, 0, "1 0 1");
    expect(result.stderr).not.toContain("unexpected producer");
  });
  it("cleans moved worktrees through the original admin ID", ({ repoDir }) => {
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
      ...gitOverride([
        '  printf "%s\\n" "$*" >> git-calls',
        '  if [[ "$*" == *"worktree prune"* ]]; then return 97; fi',
        '  if [ "${1:-} ${2:-}" = "update-ref -d" ]; then return 96; fi',
      ]),
      'cleanup_pr_worktree ".worktrees/pr-42" || exit $?',
      "echo cleanup-completed",
    ]);
    expect(
      [result.error, result.signal, result.status],
      `${result.stdout}\n${result.stderr}`,
    ).toEqual([undefined, null, 0]);
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
  it("removes stale registration and resets its owned branch", ({ repoDir }) => {
    execFileSync("git", ["remote", "add", "origin", repoDir], { cwd: repoDir });
    const physicalWorktreesDir = join(repoDir, "linked-worktrees");
    mkdirSync(physicalWorktreesDir);
    symlinkSync(physicalWorktreesDir, join(repoDir, ".worktrees"), "dir");
    const worktreeDir = addWorktree(repoDir, "temp/pr-42", "pr-42");
    rmSync(worktreeDir, { recursive: true });
    addTrackedUiConfig(repoDir);
    const { result } = enterPrWorktree(repoDir, 42);
    expect(result.stdout).toContain("Removing exact stale PR worktree .worktrees/pr-42");
    expect(existsSync(worktreeDir)).toBe(true);
    expectWorktreeBranch(worktreeDir, "temp/pr-42");
  });
  it("materializes sparse worktrees before reuse", ({ repoDir }) => {
    addTrackedUiConfig(repoDir);
    execFileSync("git", ["remote", "add", "origin", repoDir], { cwd: repoDir });
    const worktreeDir = addWorktree(repoDir, "temp/pr-45", "pr-45");
    setSparseCheckout(worktreeDir);
    expect(existsSync(join(worktreeDir, "ui", "config", "control-ui-chunking.ts"))).toBe(false);
    enterPrWorktree(repoDir, 45);
    expectMaterializedWorktree(worktreeDir);
  });
  it("refuses aliases to another registered worktree", ({ repoDir }) => {
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
