// Owner of the runtime slot layout: <state>/runtime/{launcher.mjs, slots.json, a/, b/}.
// An update stages the inactive slot, proves it starts, and flips slots.json. The
// launcher (scripts/openclaw-runtime-launcher.mjs) owns trial starts and flip-back.
import { randomUUID } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  readRuntimePointer,
  runtimeEntry,
  writeRuntimePointer,
  type RuntimePointer,
} from "../../scripts/openclaw-runtime-launcher.mjs";
import { resolveStateDir } from "../config/state-dir.js";
import { hasNodeErrorCode, isPathInside } from "./path-guards.js";
import { applyPathPrepend } from "./path-prepend.js";

export { readRuntimePointer, type RuntimePointer };

/** Gateway starts a new slot gets before the launcher returns to the previous one. */
export const RUNTIME_SLOT_TRIAL_STARTS = 2;
const SLOT_NAMES = ["a", "b"] as const;
const RUNTIME_LAUNCHER_FILE = "launcher.mjs";
const LOCK_STALE_MS = 60_000;

export type RuntimeSlotSource =
  | { kind: "npm"; spec: string }
  | { kind: "git"; repo: string; sha: string };

export function resolveRuntimeSlotsDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveStateDir(env), "runtime");
}

/** The frozen launcher a slot layout's Gateway service runs, once the layout exists. */
export function resolveRuntimeLauncher(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const launcher = path.join(resolveRuntimeSlotsDir(env), RUNTIME_LAUNCHER_FILE);
  return fsSync.existsSync(launcher) ? launcher : undefined;
}

/** The package root a launcher entry serves: the slot its pointer selects. */
export function resolveLauncherRuntimeRoot(entrypoint: string): string | undefined {
  if (path.basename(entrypoint) !== RUNTIME_LAUNCHER_FILE) {
    return undefined;
  }
  try {
    return readRuntimePointer(path.dirname(entrypoint))?.current;
  } catch {
    return undefined;
  }
}

const realpath = (file: string) => {
  try {
    return fsSync.realpathSync(file);
  } catch {
    return path.resolve(file);
  }
};

export const sameRuntimeRoot = (left: string, right: string) => realpath(left) === realpath(right);

async function writeFileWithMode(file: string, contents: string | Buffer, mode: number) {
  const temporary = `${file}.${process.pid}.tmp`;
  const handle = await fs.open(temporary, "w", mode);
  try {
    // The open mode passes through the umask; set the bits explicitly.
    await handle.chmod(mode);
    await handle.writeFile(contents);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(temporary, file);
}

/**
 * Creates the layout once. The existing install becomes the origin slot, so a
 * migrated install needs no copy and no service rewrite.
 */
export async function ensureRuntimeSlots(params: {
  dir: string;
  origin: string;
  packageRoot: string;
}): Promise<RuntimePointer> {
  await fs.mkdir(params.dir, { recursive: true, mode: 0o700 });
  await fs.chmod(params.dir, 0o700);
  const launcher = path.join(params.dir, RUNTIME_LAUNCHER_FILE);
  if (!fsSync.existsSync(launcher)) {
    const source = await fs.readFile(
      path.join(params.packageRoot, "scripts", "openclaw-runtime-launcher.mjs"),
    );
    await writeFileWithMode(launcher, source, 0o644);
  }
  const pointer = readRuntimePointer(params.dir);
  if (pointer) {
    return pointer;
  }
  const origin = realpath(params.origin);
  const created = { current: origin, origin };
  writeRuntimePointer(params.dir, created);
  return created;
}

/**
 * Service definitions name the origin install, never a slot: a slot is deleted
 * when the next update stages into it. The origin entry hands off to the launcher.
 */
export function mapRuntimeSlotPathToOrigin(
  file: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const dir = realpath(resolveRuntimeSlotsDir(env));
  const target = realpath(file);
  if (!isPathInside(dir, target)) {
    return file;
  }
  const pointer = readRuntimePointer(dir);
  const root = SLOT_NAMES.flatMap((slot) => [
    path.join(dir, slot, "node_modules", "openclaw"),
    path.join(dir, slot),
  ]).find((candidate) => isPathInside(candidate, target));
  const mapped =
    pointer && root ? path.join(pointer.origin, path.relative(root, target)) : undefined;
  return mapped && fsSync.existsSync(mapped) ? mapped : file;
}

/** A selected slot that no Gateway has started yet; the running Gateway uses previous. */
const neverStarted = (pointer: RuntimePointer) => pointer.trial === RUNTIME_SLOT_TRIAL_STARTS;

/**
 * The slot to stage: never one a Gateway may be running. A selected slot that has
 * not started yet is replaced; otherwise the slot that does not hold current.
 */
export function selectInactiveSlot(dir: string, pointer: RuntimePointer): string {
  const keep = realpath(
    neverStarted(pointer) ? (pointer.previous ?? pointer.origin) : pointer.current,
  );
  const name = SLOT_NAMES.find((slot) => !isPathInside(realpath(path.join(dir, slot)), keep));
  return path.join(dir, name ?? "a");
}

/** One updater per layout. The holder refreshes the lock; a killed holder's lock goes stale. */
export async function acquireRuntimeSlotsLock(dir: string): Promise<() => Promise<void>> {
  const file = path.join(dir, "update.lock");
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await (await fs.open(file, "wx", 0o600)).close();
      const heartbeat = setInterval(() => {
        const now = new Date();
        void fs.utimes(file, now, now).catch(() => {});
      }, LOCK_STALE_MS / 4);
      heartbeat.unref();
      return async () => {
        clearInterval(heartbeat);
        await fs.rm(file, { force: true });
      };
    } catch (error) {
      const stat = await fs.stat(file).catch(() => null);
      if (!hasNodeErrorCode(error, "EEXIST") || !stat) {
        throw error;
      }
      if (Date.now() - stat.mtimeMs < LOCK_STALE_MS) {
        throw new Error(`Another OpenClaw update is running (${file}).`, { cause: error });
      }
      await fs.rm(file, { force: true });
    }
  }
  throw new Error(`Cannot acquire ${file}.`);
}

export type RuntimeSlotCommand = (
  argv: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number },
) => Promise<{ code: number | null; stdout: string; stderr: string }>;

// Startup paths import this module for the pointer; staging loads its tools on use.
const runSlotCommand: RuntimeSlotCommand = async (argv, options) => {
  const { runCommandWithTimeout } = await import("../process/exec-runner.js");
  return await runCommandWithTimeout(argv, { ...options, baseEnv: {} });
};

const tail = (text: string) => text.trim().split("\n").slice(-12).join("\n");

async function runChecked(
  command: RuntimeSlotCommand,
  argv: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number },
): Promise<string> {
  const result = await command(argv, options);
  if (result.code !== 0) {
    throw new Error(
      `${argv.join(" ")} failed (exit ${result.code}):\n${tail(result.stderr || result.stdout)}`,
    );
  }
  return result.stdout.trim();
}

/** Commands run under the service's Node without assuming it is on PATH. */
export function runtimeSlotEnv(node: string, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = { ...env };
  applyPathPrepend(next, [path.dirname(node)]);
  return next;
}

const STAGE_PREFIX = ".stage-";

/**
 * Each attempt stages into its own directory and renames it onto the slot when it
 * is complete. A killed updater's orphaned npm/pnpm child keeps writing only into
 * its abandoned directory, which a later update removes when it can.
 */
async function removeAbandonedStages(dir: string, repo: string | undefined, git: Git) {
  for (const name of await fs.readdir(dir).catch(() => [])) {
    if (name.startsWith(STAGE_PREFIX)) {
      await fs.rm(path.join(dir, name), { recursive: true, force: true }).catch(() => {});
    }
  }
  if (repo) {
    await git("worktree", "prune").catch(() => {});
  }
}

type Git = (...args: string[]) => Promise<string>;

/** Installs or builds the target into the slot and returns its package root. */
export async function stageRuntimeSlot(params: {
  slot: string;
  source: RuntimeSlotSource;
  node: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  onStep?: (name: string) => void;
  command?: RuntimeSlotCommand;
}): Promise<string> {
  const { slot, source, timeoutMs } = params;
  const command = params.command ?? runSlotCommand;
  const env = runtimeSlotEnv(params.node, params.env);
  const dir = path.dirname(slot);
  const repo = source.kind === "git" ? source.repo : undefined;
  const git: Git = (...args) =>
    runChecked(command, ["git", "-C", repo ?? dir, ...args], {
      cwd: repo ?? dir,
      env,
      timeoutMs,
    });
  await removeAbandonedStages(dir, repo, git);
  const stage = path.join(dir, `${STAGE_PREFIX}${path.basename(slot)}-${randomUUID()}`);
  if (source.kind === "npm") {
    await fs.mkdir(stage, { recursive: true, mode: 0o755 });
    await writeFileWithMode(path.join(stage, "package.json"), '{ "private": true }\n', 0o644);
    params.onStep?.(`npm install ${source.spec}`);
    await runChecked(
      command,
      ["npm", "install", "--prefix", stage, "--no-audit", "--no-fund", "--omit=dev", source.spec],
      { cwd: stage, env, timeoutMs },
    );
    await fs.rm(slot, { recursive: true, force: true });
    await fs.rename(stage, slot);
    return path.join(slot, "node_modules", "openclaw");
  }
  // The worktree shares the checkout's object store and pnpm's content store.
  params.onStep?.(`git worktree add ${source.sha}`);
  await git("worktree", "add", "--detach", stage, source.sha);
  await buildGitSlot({ root: stage, command, env, timeoutMs, onStep: params.onStep });
  await fs.rm(slot, { recursive: true, force: true });
  await git("worktree", "prune");
  await git("worktree", "move", stage, slot);
  return slot;
}

async function buildGitSlot(params: {
  root: string;
  command: RuntimeSlotCommand;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  onStep?: (name: string) => void;
}) {
  const { root, command, env, timeoutMs } = params;
  const [{ resolveUpdateBuildManager }, { resolveControlUiAssetHealth }] = await Promise.all([
    import("./update-package-manager.js"),
    import("./control-ui-assets.js"),
  ]);
  const manager = await resolveUpdateBuildManager(
    (argv, options) =>
      command(argv, { cwd: options.cwd ?? root, env: options.env ?? env, timeoutMs }),
    root,
    timeoutMs,
    env,
  );
  if (manager.kind !== "resolved") {
    throw new Error(`No ${manager.preferred} for the build (${manager.reason}).`);
  }
  try {
    const buildEnv = manager.env ?? env;
    const script = (name: string) =>
      manager.manager === "pnpm" ? ["pnpm", name] : [manager.manager, "run", name];
    params.onStep?.(`${manager.manager} install`);
    // A slot's node_modules is never edited, so it may share the store's files:
    // copy-on-write clones where the filesystem has them, hardlinks otherwise.
    const pnpmArgs = ["--frozen-lockfile", "--package-import-method=auto"];
    await runChecked(
      command,
      [manager.manager, "install", ...(manager.manager === "pnpm" ? pnpmArgs : [])],
      { cwd: root, env: buildEnv, timeoutMs },
    );
    params.onStep?.(`${manager.manager} build`);
    await runChecked(command, script("build"), { cwd: root, env: buildEnv, timeoutMs });
    if ((await resolveControlUiAssetHealth({ root })).kind !== "ready") {
      params.onStep?.(`${manager.manager} ui:build`);
      await runChecked(command, script("ui:build"), { cwd: root, env: buildEnv, timeoutMs });
    }
  } finally {
    await manager.cleanup?.();
  }
}

/**
 * Fetches the target into the shared object store and returns its commit. A
 * private ref, not FETCH_HEAD: the running Gateway's update check also fetches.
 */
export async function fetchRuntimeSlotGitTarget(params: {
  repo: string;
  remote: string;
  ref: string;
  /** A commit the fetched ref must contain, such as a pinned dev target. */
  sha?: string;
  node: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  command?: RuntimeSlotCommand;
}): Promise<string> {
  const command = params.command ?? runSlotCommand;
  const options = {
    cwd: params.repo,
    env: runtimeSlotEnv(params.node, params.env),
    timeoutMs: params.timeoutMs,
  };
  const target = "refs/openclaw/runtime-slot-target";
  const git = (...args: string[]) =>
    runChecked(command, ["git", "-C", params.repo, ...args], options);
  await git("fetch", "--no-tags", params.remote, `+${params.ref}:${target}`);
  if (params.sha) {
    await git("merge-base", "--is-ancestor", params.sha, target);
  }
  return await git("rev-parse", "--verify", `${params.sha ?? target}^{commit}`);
}

/** A slot that cannot print its version under the service's Node never becomes current. */
export async function smokeRuntimeSlot(params: {
  root: string;
  node: string;
  env: NodeJS.ProcessEnv;
  expectedVersion?: string;
  command?: RuntimeSlotCommand;
}): Promise<string> {
  // A release without the launcher never confirms its trial and would be rolled back later.
  if (!fsSync.existsSync(path.join(params.root, "scripts", "openclaw-runtime-launcher.mjs"))) {
    throw new Error(
      `${params.root} predates runtime slots; install that release with your package manager instead.`,
    );
  }
  const smokeState = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-slot-smoke-"));
  const output = await runChecked(
    params.command ?? runSlotCommand,
    [params.node, runtimeEntry(params.root), "--version"],
    {
      cwd: params.root,
      // An empty state dir has no slot pointer, so the staged entry runs instead of current.
      env: { ...runtimeSlotEnv(params.node, params.env), OPENCLAW_STATE_DIR: smokeState },
      // The first run completes a package lifecycle that npm skipped.
      timeoutMs: 5 * 60_000,
    },
  ).finally(() => fs.rm(smokeState, { recursive: true, force: true }));
  if (params.expectedVersion && !output.includes(params.expectedVersion)) {
    throw new Error(`Staged runtime reports ${output}, expected ${params.expectedVersion}.`);
  }
  return output;
}

/** rename(2) makes the flip atomic; the next Gateway start begins the trial. */
export function activateRuntimeSlot(dir: string, root: string, run?: string): RuntimePointer {
  const pointer = readRuntimePointer(dir);
  if (!pointer) {
    throw new Error(`No runtime pointer in ${dir}.`);
  }
  const next = {
    current: realpath(root),
    // A replaced slot that never started is no rollback target.
    previous: neverStarted(pointer) ? (pointer.previous ?? pointer.origin) : pointer.current,
    origin: pointer.origin,
    trial: RUNTIME_SLOT_TRIAL_STARTS,
    ...(run ? { run } : {}),
  };
  writeRuntimePointer(dir, next);
  return next;
}

type RunningSlot = { env?: NodeJS.ProcessEnv; entry?: string };

/** The pointer when this process runs the slot it selects; the launcher execs `<slot>/openclaw.mjs`. */
function readOwnSlotPointer({ env = process.env, entry = process.argv[1] }: RunningSlot) {
  if (!entry) {
    return null;
  }
  const dir = resolveRuntimeSlotsDir(env);
  const pointer = readRuntimePointer(dir);
  return pointer && isPathInside(realpath(pointer.current), realpath(entry))
    ? { dir, pointer }
    : null;
}

/** A launcher-started slot that has not been confirmed yet. */
export function isRuntimeSlotOnTrial(running: RunningSlot = {}): boolean {
  try {
    return readOwnSlotPointer(running)?.pointer.trial !== undefined;
  } catch {
    return false;
  }
}

/**
 * EX_CONFIG (78) from sysexits.h: systemd (RestartPreventExitStatus=78) stops
 * restarting instead of entering a restart storm on a bad config. A slot on
 * trial exits 1 instead, so the launcher can return to the previous slot.
 */
export function configErrorExitCode(): 1 | 78 {
  return isRuntimeSlotOnTrial() ? 1 : 78;
}

/**
 * Called once the Gateway is ready (listening, channels started). A slot on trial
 * is confirmed; a Gateway the launcher returned to records the rollback. Either
 * way it hands back the update run that the flip carried.
 */
export function settleRuntimeSlot(
  running: RunningSlot = {},
): { outcome: "confirmed" | "rolled-back"; run?: string } | null {
  const own = readOwnSlotPointer(running);
  if (!own) {
    return null;
  }
  const { trial, run, ...settled } = own.pointer;
  if (trial !== undefined) {
    writeRuntimePointer(own.dir, settled);
    return { outcome: "confirmed", ...(run ? { run } : {}) };
  }
  if (run && settled.failed) {
    writeRuntimePointer(own.dir, settled);
    return { outcome: "rolled-back", run };
  }
  return null;
}

export type RuntimeSlotOutcome = "confirmed" | "rolled-back" | "pending";

export async function waitForRuntimeSlotOutcome(
  dir: string,
  root: string,
  timeoutMs: number,
): Promise<RuntimeSlotOutcome> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const pointer = readRuntimePointer(dir);
    if (!pointer || !sameRuntimeRoot(pointer.current, root)) {
      return "rolled-back";
    }
    if (pointer.trial === undefined) {
      return "confirmed";
    }
    if (Date.now() >= deadline) {
      return "pending";
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 1_000);
    });
  }
}
