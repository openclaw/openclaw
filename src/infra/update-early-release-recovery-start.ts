import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveStateDir } from "../config/paths.js";
import { resolveGatewayProfileSuffix } from "../daemon/constants.js";
import { resolveServiceEntrypointIndex } from "../daemon/service-layout.js";
import { resolveManagedGatewayServiceCommand } from "../daemon/service-types.js";
import { resolveGatewayService } from "../daemon/service.js";
import { isPathInside } from "./path-guards.js";
import { runtimeProcessEntrypoints } from "./runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";
import {
  readSchemaVersions,
  type EarlyGitReleaseRecoveryStart,
  type EarlyGitReleaseSchemaChange,
  type SchemaVersions,
} from "./update-candidate-check-early-release.js";
import type { RecoveryPlan } from "./update-early-release-recovery-record.js";
import {
  buildCommit,
  EARLY_RELEASE_RECOVERY_FLAG,
  git,
  ok,
  processStart,
  readJsonString,
  removeTree,
  runRecoveryCommand,
  commandTail,
  type RunCommand,
} from "./update-early-release-recovery.js";

/**
 * The `--check` side of the early release recovery (see `update-early-release-recovery.ts`):
 * every precondition, then keeping the built release and starting the runner. Remove with it.
 */

/** Measured: a rebuild under a migrating Gateway peaked near 2.3 GiB across checkout and state. */
const MIN_FREE_BYTES = 4 * 1024 ** 3;

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
  "OPENCLAW_HOME",
  "OPENCLAW_CONFIG_PATH",
  "OPENCLAW_PROFILE",
  "OPENCLAW_AGENT_DIR",
  "PI_CODING_AGENT_DIR",
  "COREPACK_HOME",
  "NODE_EXTRA_CA_CERTS",
];

/**
 * The updater this check reports to: the nearest ancestor running `openclaw update`. The CLI
 * renames its process to `openclaw`, which on Linux replaces its command line; the Gateway
 * names itself `openclaw-gateway`.
 */
function findDriver(): RecoveryPlan["driver"] | undefined {
  let pid = process.ppid;
  for (let depth = 0; depth < 8 && pid > 1; depth++) {
    try {
      const argv = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
      const start = processStart(pid);
      if (start && (argv.includes("update") || argv[0] === "openclaw")) {
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

/**
 * The package root a command on PATH runs: through symlinks (npm) and pnpm's command shims,
 * which name their target in a `# cmd-shim-target=` line. Null when it cannot be traced.
 */
function traceCommand(file: string): string | null {
  let current = file;
  for (let hop = 0; hop < 4; hop++) {
    const real = realpath(current);
    if (path.basename(real) === "openclaw.mjs") {
      return path.dirname(real);
    }
    let text = "";
    try {
      text = fs.readFileSync(real, "utf8").slice(-4096);
    } catch {}
    const target = /^# cmd-shim-target=(.+)$/mu.exec(text)?.[1];
    if (!target) {
      return null;
    }
    current = path.resolve(path.dirname(real), target.trim());
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
  readSchema: (env: NodeJS.ProcessEnv) => SchemaVersions | null;
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
  run: runRecoveryCommand,
  freeBytes: (dir) => {
    const stats = fs.statfsSync(dir);
    return stats.bavail * stats.bsize;
  },
  findDriver,
  readSchema: readSchemaVersions,
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
  // A running recovery answers first: the checks below can see its work in progress.
  if (!ok(await run(["systemctl", "--user", "show", "--property=Version"]))) {
    return { reason: "no systemd user manager is reachable" };
  }
  const unit = `openclaw-update-recovery${resolveGatewayProfileSuffix(env.OPENCLAW_PROFILE)}`;
  const state = (await run(["systemctl", "--user", "is-active", unit])).output.trim();
  if (["active", "activating", "deactivating", "reloading"].includes(state)) {
    return { running: unit };
  }
  if (!change.pending) {
    return {
      reason: `an earlier automatic recovery stopped after migrating (journalctl --user -u ${unit})`,
    };
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
  // The early updater targets `main`'s upstream whatever branch is checked out.
  if (!ok(await git(run, checkout, "merge-base", "--is-ancestor", target, "@{upstream}"))) {
    return { reason: `the checkout's upstream does not contain ${target.slice(0, 11)}` };
  }
  if (Math.min(deps.freeBytes(checkout), deps.freeBytes(change.prefix)) < MIN_FREE_BYTES) {
    return { reason: "less than 4 GiB is free for the rebuild" };
  }
  if (!ok(await run(["pnpm", "--version"], { cwd: checkout }))) {
    return { reason: "pnpm is not on PATH" };
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
  // The checkout is the main worktree; a linked or nested worktree is another installation.
  const toplevel = async (dir: string) => {
    const shown = await git(run, dir, "rev-parse", "--show-toplevel");
    return ok(shown) ? realpath(shown.output.trim()) : null;
  };
  const launcher = path.join(change.prefix, "openclaw-launcher.mjs");
  const legacy = realpath(path.join(change.prefix, "lib", "node_modules", "openclaw"));
  const entry = service.entry ? realpath(service.entry) : "";
  if (
    entry !== launcher &&
    (!entry || (await toplevel(path.dirname(entry))) !== realpath(checkout))
  ) {
    return { reason: "the Gateway service runs another installation" };
  }
  const cli = findOnPath("openclaw", env);
  const cliRoot = cli ? traceCommand(cli) : null;
  if (cli && !cliRoot) {
    return { reason: "the `openclaw` command on PATH could not be traced to an installation" };
  }
  if (cliRoot && (await toplevel(cliRoot)) !== realpath(checkout)) {
    return { reason: "the `openclaw` command on PATH runs another installation" };
  }
  if (cli) {
    const version = await run([cli, "--version"]);
    const commit = /\(([0-9a-f]{7,40})\)/u.exec(version.output)?.[1];
    const serving = [buildCommit(checkout), buildCommit(legacy)].flatMap((sha) => sha ?? []);
    if (!commit || !serving.some((sha) => sha.startsWith(commit))) {
      return { reason: "the `openclaw` command on PATH runs another build" };
    }
  } else if (entry === launcher) {
    return {
      reason:
        "the installation the Gateway service runs could not be identified (it starts the release launcher and `openclaw` is not on PATH)",
    };
  }
  // `gateway install --force` restarts the service; one the user stopped, or an update run
  // with --no-restart left alone, stays as it is.
  const gateway = path.basename(service.sourcePath);
  if ((await run(["systemctl", "--user", "is-active", gateway])).output.trim() !== "active") {
    return { reason: "the Gateway service is not running" };
  }
  const enabled = (await run(["systemctl", "--user", "is-enabled", gateway])).output.trim();
  const schema = deps.readSchema(env);
  if (!schema) {
    return { reason: "the database schema versions could not be read" };
  }
  const driver = deps.findDriver();
  if (!driver) {
    return { reason: "the updater process could not be identified" };
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
      enabled,
      schema,
      fromVersion: readJsonString(path.join(checkout, "package.json"), "version") ?? "unknown",
      driver,
      plannedAt: Date.now(),
    },
  };
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
  // Exclusive before anything is cleaned: a concurrent check that got this far reports the
  // running recovery instead of removing the release this one is keeping.
  const lock = path.join(plan.prefix, ".recovery-start");
  const owner = `${process.pid} ${processStart(process.pid) ?? ""}`;
  if (!takeStartLock(lock, owner)) {
    return { started: false, running: plan.unit };
  }
  try {
    return await keepAndStart(change, plan, deps);
  } catch (error) {
    return { started: false, reason: `the built release could not be kept (${String(error)})` };
  } finally {
    // Only this check's own lock; a lock another check holds stays with it.
    // Renamed away first: an emptied lock directory would accept another check's rename.
    if (readText(path.join(lock, "owner")) === owner) {
      removeTree(lock);
    }
  }
}

/** True once this check holds the start lock; false while a live check holds it. */
function takeStartLock(lock: string, owner: string): boolean {
  // Published whole by a rename, so the lock always names its owner.
  const staged = `${lock}.${process.pid}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    fs.rmSync(staged, { recursive: true, force: true });
    fs.mkdirSync(staged);
    fs.writeFileSync(path.join(staged, "owner"), owner);
    try {
      fs.renameSync(staged, lock);
      return true;
    } catch {
      fs.rmSync(staged, { recursive: true, force: true });
    }
    const seen = readText(path.join(lock, "owner"));
    const [pid, start = ""] = seen.split(" ");
    try {
      if (!seen || (process.kill(Number(pid), 0) && (processStart(Number(pid)) ?? "") === start)) {
        // Released a moment ago (try again), or held by a live check.
        if (seen) {
          return false;
        }
        continue;
      }
    } catch {}
    // A dead check's lock moves to a name only it has, so of two checks that saw it dead the
    // second moves nothing: its rename finds that name taken and leaves a newer live lock alone.
    // The tombstone stays (the finishing step removes it), so that name is never free again.
    try {
      fs.renameSync(lock, `${lock}.stale-${pid}-${start}`);
    } catch {}
  }
  return false;
}

function readText(file: string): string {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

async function keepAndStart(
  change: EarlyGitReleaseSchemaChange,
  plan: RecoveryPlan,
  deps: StartDeps,
): Promise<EarlyGitReleaseRecoveryStart> {
  const run = deps.run;
  // Under the lock: a recovery another check started a moment ago is running now.
  const state = (await run(["systemctl", "--user", "is-active", plan.unit])).output.trim();
  if (["active", "activating", "deactivating", "reloading"].includes(state)) {
    return { started: false, running: plan.unit };
  }
  // An earlier attempt's release no longer serves: the updater could not run otherwise.
  if (fs.existsSync(path.dirname(plan.release))) {
    removeTree(path.dirname(plan.release));
    await git(run, plan.checkout, "worktree", "prune");
  }
  fs.mkdirSync(path.dirname(plan.release));
  const moved = await git(run, plan.checkout, "worktree", "move", change.root, plan.release);
  if (!ok(moved)) {
    fs.rmSync(path.dirname(plan.release), { recursive: true, force: true });
    return {
      started: false,
      reason: `the built release could not be kept (${commandTail(moved)})`,
    };
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
    // Resolved, because the runner's working directory differs. Only when set: the runner's
    // `gateway install --force` writes it into the service definition.
    ...(deps.env.OPENCLAW_STATE_DIR
      ? [`--setenv=OPENCLAW_STATE_DIR=${path.resolve(change.stateDir)}`]
      : []),
    // systemd expands `$NAME` in a service's command line; `$$` passes a literal `$`.
    ...[
      process.execPath,
      fileURLToPath(worker),
      EARLY_RELEASE_RECOVERY_FLAG,
      JSON.stringify(plan),
    ].map((arg) => arg.replaceAll("$", () => "$$")),
  ]);
  if (!ok(started)) {
    // Keep the release where the updater's cleanup finds it; never delete it unmoved.
    if (ok(await git(run, plan.checkout, "worktree", "move", plan.release, change.root))) {
      fs.rmSync(path.dirname(plan.release), { recursive: true, force: true });
    }
    return { started: false, reason: `systemd-run failed (${commandTail(started)})` };
  }
  return { started: true, unit: plan.unit, target: plan.target };
}
