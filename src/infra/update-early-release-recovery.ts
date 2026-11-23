import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { resolveStateDir } from "../config/paths.js";
import { resolveGatewayProfileSuffix } from "../daemon/constants.js";
import { resolveServiceEntrypointIndex } from "../daemon/service-layout.js";
import { resolveManagedGatewayServiceCommand } from "../daemon/service-types.js";
import { resolveGatewayService } from "../daemon/service.js";
import { VERSION } from "../version.js";
import { isPathInside } from "./path-guards.js";
import { runtimeProcessEntrypoints } from "./runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";
import {
  readPendingSchemaChange,
  type EarlyGitReleaseRecoveryStart,
  type EarlyGitReleaseSchemaChange,
} from "./update-candidate-check-early-release.js";

/**
 * Automatic recovery for Git checkouts whose installed updater has the early release layout
 * (see `update-candidate-check-early-release.ts`). That updater stops at this release's `--check`;
 * the check then keeps the release it built and starts this runner as a transient systemd user
 * service, which outlives the updater and the Gateway restarts. The runner moves the checkout to
 * the target commit, serves the Gateway from that release (it migrates state at boot) while the
 * checkout rebuilds, then serves the rebuilt checkout: the arrangement a by-hand rebuild leaves,
 * which current updates continue from.
 *
 * Linux with a systemd user service only; other platforms keep the printed rebuild.
 * Remove with `update-candidate-check-early-release.ts`.
 */

export const EARLY_RELEASE_RECOVERY_FLAG = "--early-release-recovery";
/** Measured: a rebuild under a migrating Gateway peaked near 2.3 GiB across checkout and state. */
const MIN_FREE_BYTES = 4 * 1024 ** 3;
const DRIVER_EXIT_TIMEOUT_MS = 30 * 60_000;
const COMMAND_TIMEOUT_MS = 60 * 60_000;
const MAX_RESTARTS = 2;
const PASSED_ENV = [
  "HOME",
  "PATH",
  "USER",
  "LANG",
  "TMPDIR",
  "PNPM_HOME",
  "XDG_CONFIG_HOME",
  "XDG_RUNTIME_DIR",
  "DBUS_SESSION_BUS_ADDRESS",
  "OPENCLAW_STATE_DIR",
  "OPENCLAW_CONFIG_PATH",
  "OPENCLAW_PROFILE",
  "OPENCLAW_AGENT_DIR",
];

export type RecoveryPlan = {
  unit: string;
  checkout: string;
  branch: string;
  target: string;
  /** The release the updater built, kept here for the rebuild window. */
  release: string;
  prefix: string;
  serviceFile: string;
  fromVersion: string;
  driver: { pid: number; start: string };
};

export type CommandResult = { code: number | null; output: string };
export type RunCommand = (
  argv: string[],
  options?: { cwd?: string; stream?: boolean; timeoutMs?: number },
) => Promise<CommandResult>;

/** Runs a command; `stream` copies its output to this process's (the journal's) output. */
export const runCommand: RunCommand = (argv, options = {}) =>
  new Promise((resolve) => {
    const child = spawn(argv[0]!, argv.slice(1), {
      cwd: options.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const take = (target: NodeJS.WriteStream) => (chunk: Buffer) => {
      output = (output + chunk.toString("utf8")).slice(-16_384);
      if (options.stream) {
        target.write(chunk);
      }
    };
    child.stdout.on("data", take(process.stdout));
    child.stderr.on("data", take(process.stderr));
    const timer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs ?? 120_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      resolve({ code: null, output: String(error) });
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code, output });
    });
  });

const ok = (result: CommandResult) => result.code === 0;
const tail = (result: CommandResult) =>
  result.output.trim().split("\n").slice(-6).join(" ").slice(-600);

async function git(run: RunCommand, cwd: string, ...args: string[]) {
  return run(["git", "-C", cwd, ...args]);
}

function processStart(pid: number): string | null {
  try {
    // Field 22 (start time) follows the parenthesized command, which can contain spaces.
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] ?? null;
  } catch {
    return null;
  }
}

/** The nearest ancestor running `openclaw update`: the updater this check reports to. */
function findDriver(): RecoveryPlan["driver"] | undefined {
  let pid = process.ppid;
  for (let depth = 0; depth < 8 && pid > 1; depth++) {
    try {
      const argv = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
      const start = processStart(pid);
      if (start && argv.includes("update")) {
        return { pid, start };
      }
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      pid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function buildCommit(root: string): string | null {
  try {
    const info = JSON.parse(
      fs.readFileSync(path.join(root, "dist", "build-info.json"), "utf8"),
    ) as {
      commit?: unknown;
    };
    return typeof info.commit === "string" ? info.commit : null;
  } catch {
    return null;
  }
}

function findOnPath(command: string, env: NodeJS.ProcessEnv): string | null {
  for (const dir of (env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(dir, command);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {}
  }
  return null;
}

function realpath(file: string): string {
  try {
    return fs.realpathSync(file);
  } catch {
    return path.resolve(file);
  }
}

export type StartDeps = {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  run: RunCommand;
  freeBytes: (dir: string) => number;
  findDriver: () => RecoveryPlan["driver"] | undefined;
  readService: (env: NodeJS.ProcessEnv) => Promise<{
    sourcePath?: string;
    entry?: string;
    environment?: Record<string, string>;
  } | null>;
};

async function readGatewayService(env: NodeJS.ProcessEnv) {
  const command = await resolveGatewayService().readCommand(env, { requireEffective: true });
  const managed = resolveManagedGatewayServiceCommand(command);
  if (!command || !managed) {
    return null;
  }
  const index = resolveServiceEntrypointIndex(managed.programArguments);
  return {
    sourcePath: command.sourcePath,
    entry: index === undefined ? undefined : managed.programArguments[index],
    environment: managed.environment,
  };
}

const defaultStartDeps = (): StartDeps => ({
  platform: process.platform,
  env: process.env,
  run: runCommand,
  freeBytes: (dir) => {
    const stats = fs.statfsSync(dir);
    return stats.bavail * stats.bsize;
  },
  findDriver,
  readService: readGatewayService,
});

/** Every reason the runner cannot finish this update unattended, checked before any change. */
async function planRecovery(
  change: EarlyGitReleaseSchemaChange,
  deps: StartDeps,
): Promise<{ plan: RecoveryPlan } | { reason: string } | { running: string }> {
  const { env, run } = deps;
  if (deps.platform !== "linux") {
    return { reason: "it runs only with a Linux systemd user service" };
  }
  const common = await git(
    run,
    change.root,
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  );
  const commonDir = common.output.trim();
  const target = (await git(run, change.root, "rev-parse", "HEAD")).output.trim();
  if (!ok(common) || path.basename(commonDir) !== ".git" || !/^[0-9a-f]{40}$/u.test(target)) {
    return { reason: "the release is not a worktree of a Git checkout" };
  }
  const checkout = path.dirname(commonDir);
  const branch = await git(run, checkout, "symbolic-ref", "-q", "--short", "HEAD");
  if (!ok(branch)) {
    return { reason: "the checkout is not on a branch" };
  }
  const dirty = await git(run, checkout, "status", "--porcelain", "--untracked-files=no");
  if (!ok(dirty) || dirty.output.trim()) {
    return { reason: "the checkout has uncommitted changes to tracked files" };
  }
  if (!ok(await git(run, checkout, "merge-base", "--is-ancestor", "HEAD", target))) {
    return { reason: `the checkout's branch cannot fast-forward to ${target.slice(0, 11)}` };
  }
  const ahead = await git(run, checkout, "rev-list", "--count", "@{upstream}..HEAD");
  if (!ok(ahead)) {
    return { reason: "the checkout's branch has no upstream" };
  }
  if (Number(ahead.output.trim()) > 0) {
    return { reason: "the checkout's branch has local commits that are not upstream" };
  }
  if (Math.min(deps.freeBytes(checkout), deps.freeBytes(change.prefix)) < MIN_FREE_BYTES) {
    return { reason: "less than 4 GiB is free for the rebuild" };
  }
  if (!ok(await run(["pnpm", "--version"], { cwd: checkout }))) {
    return { reason: "pnpm is not on PATH" };
  }
  if (!ok(await run(["systemctl", "--user", "show", "--property=Version"]))) {
    return { reason: "no systemd user manager is reachable" };
  }
  const unit = `openclaw-update-recovery${resolveGatewayProfileSuffix(env.OPENCLAW_PROFILE)}`;
  const state = (await run(["systemctl", "--user", "is-active", unit])).output.trim();
  if (["active", "activating", "deactivating", "reloading"].includes(state)) {
    return { running: unit };
  }
  const service = await deps.readService(env).catch(() => null);
  const userUnits = path.join(
    env.XDG_CONFIG_HOME || path.join(env.HOME || os.homedir(), ".config"),
    "systemd",
    "user",
  );
  if (!service?.sourcePath || !isPathInside(userUnits, service.sourcePath)) {
    return { reason: "the Gateway is not a managed systemd user service" };
  }
  const serviceStateDir = resolveStateDir({ HOME: env.HOME, ...service.environment });
  if (realpath(serviceStateDir) !== realpath(change.stateDir)) {
    return { reason: "the Gateway service uses another state directory" };
  }
  const launcher = path.join(change.prefix, "openclaw-launcher.mjs");
  const legacy = realpath(path.join(change.prefix, "lib", "node_modules", "openclaw"));
  const entry = service.entry ? realpath(service.entry) : "";
  if (!isPathInside(checkout, entry) && entry !== launcher) {
    return { reason: "the Gateway service runs another installation" };
  }
  const driver = deps.findDriver();
  if (!driver) {
    return { reason: "the updater process could not be identified" };
  }
  const cli = findOnPath("openclaw", env);
  if (cli) {
    const version = await run([cli, "--version"]);
    const commit = /\(([0-9a-f]{7,40})\)/u.exec(version.output)?.[1];
    const serving = [buildCommit(checkout), buildCommit(legacy)].filter(Boolean) as string[];
    if (!commit || !serving.some((sha) => sha.startsWith(commit))) {
      return { reason: "the `openclaw` command on PATH runs another installation" };
    }
  }
  return {
    plan: {
      unit,
      checkout,
      branch: branch.output.trim(),
      target,
      release: path.join(change.prefix, "recovery", "openclaw"),
      prefix: change.prefix,
      serviceFile: service.sourcePath,
      fromVersion: version(checkout) ?? "unknown",
      driver,
    },
  };
}

function version(root: string): string | null {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as {
      version?: unknown;
    };
    return typeof pkg.version === "string" ? pkg.version : null;
  } catch {
    return null;
  }
}

function removeTree(dir: string) {
  // Rename first, so an interrupted removal never leaves a half-removed release in place.
  const doomed = path.join(path.dirname(dir), `.removing-${path.basename(dir)}-${process.pid}`);
  fs.renameSync(dir, doomed);
  fs.rmSync(doomed, { recursive: true, force: true });
}

/**
 * Called by `--check` once it has decided to refuse an early updater's schema change. When every
 * precondition holds it keeps the built release out of the updater's cleanup and starts the
 * runner. Nothing changes otherwise, and the reason is returned for the printed rebuild.
 */
export async function startEarlyGitReleaseRecovery(
  change: EarlyGitReleaseSchemaChange,
  deps: StartDeps = defaultStartDeps(),
): Promise<EarlyGitReleaseRecoveryStart> {
  const planned = await planRecovery(change, deps).catch((error: unknown) => ({
    reason: `its preconditions could not be read (${String(error)})`,
  }));
  if ("running" in planned) {
    return { started: false, running: planned.running };
  }
  if ("reason" in planned) {
    return { started: false, reason: planned.reason };
  }
  const { plan } = planned;
  const run = deps.run;
  // An earlier attempt's release no longer serves: the updater could not run otherwise.
  if (fs.existsSync(path.dirname(plan.release))) {
    removeTree(path.dirname(plan.release));
    await git(run, plan.checkout, "worktree", "prune");
  }
  fs.mkdirSync(path.dirname(plan.release), { recursive: true });
  const moved = await git(run, plan.checkout, "worktree", "move", change.root, plan.release);
  if (!ok(moved)) {
    fs.rmSync(path.dirname(plan.release), { recursive: true, force: true });
    return { started: false, reason: `the built release could not be kept (${tail(moved)})` };
  }
  const worker = resolveRuntimeWorkerUrl({
    ...runtimeProcessEntrypoints.updateMigratedFinalize,
    root: plan.release,
  });
  const started = await run([
    "systemd-run",
    "--user",
    `--unit=${plan.unit}`,
    "--collect",
    "--quiet",
    "--description=OpenClaw update recovery",
    "--property=Restart=on-abnormal",
    "--property=RestartSec=15s",
    `--working-directory=${plan.checkout}`,
    ...PASSED_ENV.flatMap((key) => (deps.env[key] ? [`--setenv=${key}=${deps.env[key]}`] : [])),
    process.execPath,
    fileURLToPath(worker),
    EARLY_RELEASE_RECOVERY_FLAG,
    JSON.stringify(plan),
  ]);
  if (!ok(started)) {
    await git(run, plan.checkout, "worktree", "move", plan.release, change.root);
    fs.rmSync(path.dirname(plan.release), { recursive: true, force: true });
    return { started: false, reason: `systemd-run failed (${tail(started)})` };
  }
  return { started: true, unit: plan.unit, target: plan.target };
}

export type RunnerDeps = {
  run: RunCommand;
  log: (line: string) => void;
  /** True while the updater that started this runner has not exited. */
  driverAlive: (driver: RecoveryPlan["driver"]) => boolean;
  /** Restarts systemd made of this unit after an abnormal exit. */
  restarts: (unit: string) => Promise<number>;
  migrated: () => boolean;
  record: (outcome: RecoveryOutcome) => Promise<void>;
  /** Runs the finishing step from the rebuilt checkout, whose code is this release's. */
  finish: (plan: RecoveryPlan, facts: FinishFacts) => Promise<CommandResult>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
};

export type FinishFacts = { downtimeMs: number };
export type RecoveryOutcome = {
  plan: RecoveryPlan;
  status: "succeeded" | "failed";
  reason: string;
  detail: string;
  nextAction?: string;
  downtimeMs?: number;
};

const REBUILD = "pnpm install --frozen-lockfile && pnpm build";

/**
 * The runner, started from the kept release. Every exit leaves a Gateway serving. Returns true
 * once the finishing step removed the kept release.
 */
export async function runEarlyGitReleaseRecovery(
  plan: RecoveryPlan,
  deps: RunnerDeps,
): Promise<boolean> {
  const { run, log } = deps;
  const cli = (root: string, ...args: string[]) =>
    run([process.execPath, path.join(root, "openclaw.mjs"), ...args], {
      cwd: root,
      stream: true,
      timeoutMs: 15 * 60_000,
    });
  const serve = async (root: string) => {
    const installed = await cli(root, "gateway", "install", "--force", "--json");
    return ok(installed) ? cli(root, "gateway", "start", "--json") : installed;
  };
  const abandon = async (why: string) => {
    log(`stopped before changing the Gateway: ${why}. The next \`openclaw update\` tries again.`);
    if (fs.existsSync(path.dirname(plan.release))) {
      removeTree(path.dirname(plan.release));
      await git(run, plan.checkout, "worktree", "prune");
    }
    return false;
  };
  const fail = async (reason: string, detail: string, nextAction: string) => {
    log(`${detail} Next step: ${nextAction}`);
    await deps.record({ plan, status: "failed", reason, detail, nextAction });
    return false;
  };

  if ((await deps.restarts(plan.unit)) > MAX_RESTARTS) {
    return deps.migrated()
      ? fail(
          "early-release-recovery-interrupted",
          `The recovery was interrupted ${MAX_RESTARTS + 1} times; the Gateway serves the new release.`,
          `from the checkout, run \`${REBUILD} && openclaw gateway install --force\``,
        )
      : abandon("it was interrupted repeatedly");
  }
  // The updater still records its own outcome in the state database; migrating under it races.
  log("waiting for the update that started this recovery to exit");
  const until = deps.now() + DRIVER_EXIT_TIMEOUT_MS;
  while (deps.driverAlive(plan.driver)) {
    if (deps.now() > until) {
      return abandon("the update that started it did not exit");
    }
    await deps.sleep(1000);
  }
  const head = (await git(run, plan.checkout, "rev-parse", "HEAD")).output.trim();
  if (head !== plan.target) {
    const branch = (await git(run, plan.checkout, "symbolic-ref", "-q", "--short", "HEAD")).output;
    const dirty = await git(run, plan.checkout, "status", "--porcelain", "--untracked-files=no");
    if (branch.trim() !== plan.branch || !ok(dirty) || dirty.output.trim()) {
      return abandon("the checkout changed since the update checked it");
    }
    log(`fast-forwarding ${plan.branch} to ${plan.target}`);
    const merged = await git(run, plan.checkout, "merge", "--ff-only", "--quiet", plan.target);
    if (!ok(merged)) {
      return abandon(`the fast-forward failed (${tail(merged)})`);
    }
  }
  let downtimeMs = 0;
  const switched = async (root: string) => {
    const started = deps.now();
    const result = await serve(root);
    downtimeMs += deps.now() - started;
    return result;
  };
  const before = fs.readFileSync(plan.serviceFile);
  // A resumed run finds the service already on the release and continues from the build.
  if (!before.includes(plan.release)) {
    log("restarting the Gateway on the new release; it migrates state at startup");
    const served = await switched(plan.release);
    if (!ok(served)) {
      if (!deps.migrated()) {
        // Nothing migrated, so the previous build can serve again: put back its definition.
        fs.writeFileSync(plan.serviceFile, before);
        await run(["systemctl", "--user", "daemon-reload"]);
        await run(["systemctl", "--user", "restart", path.basename(plan.serviceFile)]);
        return abandon(`the new release did not become ready (${tail(served)})`);
      }
      return fail(
        "early-release-recovery-start-failed",
        `The new release migrated state but did not report ready (${tail(served)}).`,
        "run `openclaw triage` on this machine",
      );
    }
  }
  log("rebuilding the checkout while the Gateway serves the new release");
  for (const argv of [
    ["pnpm", "install", "--frozen-lockfile", "--config.confirmModulesPurge=false"],
    ["pnpm", "build"],
  ]) {
    const built = await run(argv, {
      cwd: plan.checkout,
      stream: true,
      timeoutMs: COMMAND_TIMEOUT_MS,
    });
    if (!ok(built)) {
      return fail(
        "early-release-recovery-build-failed",
        `The Gateway serves OpenClaw ${VERSION} from the release the update built. \`${argv.join(" ")}\` failed in the checkout (${tail(built)}).`,
        `fix the cause, then from the checkout run \`${REBUILD} && openclaw gateway install --force\``,
      );
    }
  }
  log("restarting the Gateway on the rebuilt checkout");
  const final = await switched(plan.checkout);
  if (!ok(final)) {
    const back = await serve(plan.release);
    return fail(
      "early-release-recovery-switch-failed",
      `The rebuilt checkout did not become ready (${tail(final)}); the Gateway ${ok(back) ? "serves the new release again" : "could not be put back on the new release"}.`,
      "from the checkout, run `openclaw gateway install --force && openclaw gateway start`",
    );
  }
  const finished = await deps.finish(plan, { downtimeMs });
  if (!ok(finished)) {
    log(`the rebuilt checkout serves, but cleanup did not finish (${tail(finished)})`);
  }
  return !fs.existsSync(plan.release);
}

/**
 * The last step, run from the rebuilt checkout so the kept release can be removed. Removes what
 * the early layout left and records the outcome for `openclaw update status`.
 */
export async function finishEarlyGitReleaseRecovery(
  plan: RecoveryPlan,
  facts: FinishFacts,
  deps: Pick<RunnerDeps, "run" | "log" | "record">,
) {
  const removed: string[] = [];
  const kept: string[] = [];
  const releases = path.join(plan.prefix, "releases");
  const trial = path.join(releases, ".trial");
  try {
    if (!("v" in (JSON.parse(fs.readFileSync(trial, "utf8")) as object))) {
      fs.rmSync(trial);
      removed.push("the old-format trial");
    }
  } catch {}
  const legacy = path.join(plan.prefix, "lib", "node_modules", "openclaw");
  if (fs.lstatSync(legacy, { throwIfNoEntry: false })?.isSymbolicLink()) {
    fs.rmSync(legacy);
    for (const dir of ["lib/node_modules", "lib"]) {
      try {
        fs.rmdirSync(path.join(plan.prefix, dir));
      } catch {}
    }
    removed.push("the old release link");
  }
  const live = fs.existsSync("/proc")
    ? fs
        .readdirSync("/proc")
        .filter((pid) => /^\d+$/u.test(pid))
        .map((pid) => {
          try {
            return {
              pid,
              argv: fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").replaceAll("\0", " "),
            };
          } catch {
            return { pid, argv: "" };
          }
        })
    : [];
  const doomed = [
    ...(fs.existsSync(releases) ? fs.readdirSync(releases) : [])
      .filter(
        (id) =>
          !id.startsWith(".") &&
          fs.existsSync(path.join(releases, id, "lib", "node_modules", "openclaw")),
      )
      .map((id) => path.join(releases, id)),
    path.dirname(plan.release),
  ];
  for (const dir of doomed.filter((candidate) => fs.existsSync(candidate))) {
    if (live.some(({ argv }) => argv.includes(dir))) {
      kept.push(dir);
      continue;
    }
    removeTree(dir);
    removed.push(path.relative(plan.prefix, dir));
  }
  await git(deps.run, plan.checkout, "worktree", "prune");
  const runners = live
    .filter(
      ({ pid, argv }) =>
        Number(pid) !== process.pid &&
        argv.includes(`${plan.checkout}/openclaw.mjs`) &&
        / node (run|start)\b/u.test(argv),
    )
    .map(({ pid }) => pid);
  const detail = [
    `Rebuilt the checkout at ${plan.target.slice(0, 11)} and moved the Gateway onto it.`,
    removed.length ? `Removed ${removed.join(", ")}.` : "",
    kept.length ? `Kept ${kept.join(", ")}, still in use.` : "",
    runners.length
      ? `Node runner ${runners.join(", ")} still runs the code from before the rebuild; restart it.`
      : "",
  ]
    .filter(Boolean)
    .join(" ");
  deps.log(detail);
  await deps.record({
    plan,
    status: "succeeded",
    reason: "early-release-recovered",
    detail,
    downtimeMs: facts.downtimeMs,
    ...(runners.length
      ? { nextAction: "restart the node runner that runs from this checkout" }
      : {}),
  });
}

async function recordOutcome(outcome: RecoveryOutcome) {
  const { createUpdateRunAsync, finishUpdateRunAsync, recordUpdateRunStepAsync } =
    await import("./update-run-write.async.js");
  const target = { kind: "git" as const, version: VERSION, sha: outcome.plan.target };
  const run = await createUpdateRunAsync({
    trigger: "cli",
    target,
    before: { version: outcome.plan.fromVersion },
  });
  await recordUpdateRunStepAsync(run.runId, {
    step: "early-release-recovery",
    status: outcome.status === "succeeded" ? "completed" : "failed",
    endedAtMs: Date.now(),
    detail: outcome.detail,
  });
  await finishUpdateRunAsync(run.runId, {
    status: outcome.status,
    reason: outcome.reason,
    ...(outcome.nextAction ? { nextAction: outcome.nextAction } : {}),
    ...(outcome.status === "succeeded"
      ? { after: { version: VERSION, sha: outcome.plan.target } }
      : {}),
    ...(outcome.downtimeMs === undefined ? {} : { downtimeMs: outcome.downtimeMs }),
  });
}

/** Entry for `update-migrated-finalize.worker --early-release-recovery <plan> [finish <facts>]`. */
export async function runEarlyGitReleaseRecoveryEntry(argv: readonly string[]) {
  const plan = JSON.parse(argv[0] ?? "") as RecoveryPlan;
  const log = (line: string) => process.stdout.write(`[openclaw update recovery] ${line}\n`);
  const record = async (outcome: RecoveryOutcome) => {
    try {
      await recordOutcome(outcome);
    } catch (error) {
      log(`the outcome could not be recorded for \`openclaw update status\`: ${String(error)}`);
    }
  };
  if (argv[1] === "finish") {
    await finishEarlyGitReleaseRecovery(plan, JSON.parse(argv[2] ?? "{}") as FinishFacts, {
      run: runCommand,
      log,
      record,
    });
    return false;
  }
  return runEarlyGitReleaseRecovery(plan, {
    run: runCommand,
    log,
    driverAlive: (driver) => processStart(driver.pid) === driver.start,
    restarts: async (unit) =>
      Number(
        (
          await runCommand(["systemctl", "--user", "show", "--property=NRestarts", "--value", unit])
        ).output.trim(),
      ) || 0,
    // Unreadable state counts as migrated: the old build is never put back on data it may not open.
    migrated: () => readPendingSchemaChange() === null,
    record,
    finish: (current, facts) => {
      const worker = resolveRuntimeWorkerUrl({
        ...runtimeProcessEntrypoints.updateMigratedFinalize,
        root: current.checkout,
      });
      return runCommand(
        [
          process.execPath,
          fileURLToPath(worker),
          EARLY_RELEASE_RECOVERY_FLAG,
          JSON.stringify(current),
          "finish",
          JSON.stringify(facts),
        ],
        { cwd: current.checkout, stream: true, timeoutMs: 10 * 60_000 },
      );
    },
    now: Date.now,
    sleep: (ms) => delay(ms),
  });
}
