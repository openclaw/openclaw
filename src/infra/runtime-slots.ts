// Owner of the runtime slot layout: <state>/runtime/{launcher.mjs, slots.json, a/, b/}.
// An update stages the inactive slot, proves it starts, and flips slots.json. The
// launcher (scripts/openclaw-runtime-launcher.mjs) owns trial starts and flip-back.
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  readRuntimePointer,
  runtimeEntry,
  RUNTIME_SLOT_ENV,
  writeRuntimePointer,
  type RuntimePointer,
} from "../../scripts/openclaw-runtime-launcher.mjs";
import { resolveStateDir } from "../config/state-dir.js";
import { runCommandWithTimeout } from "../process/exec-runner.js";
import { resolveControlUiAssetHealth } from "./control-ui-assets.js";
import { isPathInside } from "./path-guards.js";
import { applyPathPrepend } from "./path-prepend.js";
import { resolveUpdateBuildManager } from "./update-package-manager.js";

export { readRuntimePointer, RUNTIME_SLOT_ENV, type RuntimePointer };

/** Gateway starts a new slot gets before the launcher returns to the previous one. */
export const RUNTIME_SLOT_TRIAL_STARTS = 2;
const SLOT_NAMES = ["a", "b"] as const;
const LOCK_STALE_MS = 60_000;

export type RuntimeSlotSource =
  | { kind: "npm"; spec: string }
  | { kind: "git"; repo: string; sha: string };

export function resolveRuntimeSlotsDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveStateDir(env), "runtime");
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
  const launcher = path.join(params.dir, "launcher.mjs");
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
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || !stat) {
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

const runSlotCommand: RuntimeSlotCommand = (argv, options) =>
  runCommandWithTimeout(argv, { ...options, baseEnv: {} });

const tail = (text: string) => text.trim().split("\n").slice(-12).join("\n");

async function run(
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
  delete next[RUNTIME_SLOT_ENV];
  applyPathPrepend(next, [path.dirname(node)]);
  return next;
}

async function clearSlot(
  slot: string,
  source: RuntimeSlotSource,
  command: RuntimeSlotCommand,
  env: NodeJS.ProcessEnv,
) {
  await fs.rm(slot, { recursive: true, force: true });
  if (source.kind === "git") {
    await command(["git", "-C", source.repo, "worktree", "prune"], {
      cwd: source.repo,
      env,
      timeoutMs: 60_000,
    });
  }
}

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
  await clearSlot(slot, source, command, env);
  if (source.kind === "npm") {
    await fs.mkdir(slot, { recursive: true, mode: 0o755 });
    await writeFileWithMode(path.join(slot, "package.json"), '{ "private": true }\n', 0o644);
    params.onStep?.(`npm install ${source.spec}`);
    await run(
      command,
      ["npm", "install", "--prefix", slot, "--no-audit", "--no-fund", "--omit=dev", source.spec],
      { cwd: slot, env, timeoutMs },
    );
    return path.join(slot, "node_modules", "openclaw");
  }
  // The worktree shares the checkout's object store; nothing is packed or copied.
  params.onStep?.(`git worktree add ${source.sha}`);
  await run(
    command,
    ["git", "-C", source.repo, "worktree", "add", "--detach", "--force", slot, source.sha],
    {
      cwd: source.repo,
      env,
      timeoutMs,
    },
  );
  const manager = await resolveUpdateBuildManager(
    (argv, options) =>
      command(argv, { cwd: options.cwd ?? slot, env: options.env ?? env, timeoutMs }),
    slot,
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
    await run(
      command,
      [manager.manager, "install", ...(manager.manager === "pnpm" ? ["--frozen-lockfile"] : [])],
      { cwd: slot, env: buildEnv, timeoutMs },
    );
    params.onStep?.(`${manager.manager} build`);
    await run(command, script("build"), { cwd: slot, env: buildEnv, timeoutMs });
    if ((await resolveControlUiAssetHealth({ root: slot })).kind !== "ready") {
      params.onStep?.(`${manager.manager} ui:build`);
      await run(command, script("ui:build"), { cwd: slot, env: buildEnv, timeoutMs });
    }
  } finally {
    await manager.cleanup?.();
  }
  return slot;
}

/**
 * Fetches the target into the shared object store and returns its commit. A
 * private ref, not FETCH_HEAD: the running Gateway's update check also fetches.
 */
export async function fetchRuntimeSlotGitTarget(params: {
  repo: string;
  remote: string;
  ref: string;
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
  const git = (...args: string[]) => run(command, ["git", "-C", params.repo, ...args], options);
  await git("fetch", "--no-tags", params.remote, `+${params.ref}:${target}`);
  return await git("rev-parse", "--verify", `${target}^{commit}`);
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
  const output = await run(
    params.command ?? runSlotCommand,
    [params.node, runtimeEntry(params.root), "--version"],
    {
      cwd: params.root,
      env: { ...runtimeSlotEnv(params.node, params.env), [RUNTIME_SLOT_ENV]: params.root },
      // The first run completes a package lifecycle that npm skipped.
      timeoutMs: 5 * 60_000,
    },
  );
  if (params.expectedVersion && !output.includes(params.expectedVersion)) {
    throw new Error(`Staged runtime reports ${output}, expected ${params.expectedVersion}.`);
  }
  return output;
}

/** rename(2) makes the flip atomic; the next Gateway start begins the trial. */
export function activateRuntimeSlot(dir: string, root: string): RuntimePointer {
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
  };
  writeRuntimePointer(dir, next);
  return next;
}

/** The Gateway confirms its slot once it listens and its channels have started. */
export function confirmRuntimeSlot(env: NodeJS.ProcessEnv = process.env): boolean {
  const own = env[RUNTIME_SLOT_ENV];
  if (!own) {
    return false;
  }
  const dir = resolveRuntimeSlotsDir(env);
  const pointer = readRuntimePointer(dir);
  if (pointer?.trial === undefined || !sameRuntimeRoot(pointer.current, own)) {
    return false;
  }
  const { trial: _trial, ...confirmed } = pointer;
  writeRuntimePointer(dir, confirmed);
  return true;
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
