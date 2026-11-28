import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { safeParseJsonRecord } from "@openclaw/normalization-core/json-coercion";
import { resolveStateDir } from "../config/paths.js";
import { getFileLockProcessStartTime } from "../shared/pid-alive.js";
import { escapeXml } from "../shared/xml.js";
import { VERSION } from "../version.js";
import { runtimeProcessEntrypoints } from "./runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";
import { readSchemaVersions, type SchemaVersions } from "./update-candidate-check-early-release.js";
import { waitForGatewayReady } from "./update-early-release-recovery-ready.js";
import {
  holdUpdateLock,
  recordOutcome,
  type RecoveryOutcome,
  type RecoveryPlan,
} from "./update-early-release-recovery-record.js";
import {
  gatewayServiceControl,
  recoveryJobRestarts,
  type CommandResult,
  type GatewayServiceControl,
  type RunCommand,
} from "./update-early-release-recovery-service.js";

/**
 * Automatic recovery for Git checkouts whose installed updater has the early release layout
 * (see `update-candidate-check-early-release.ts`). That updater stops at this release's `--check`;
 * the check then keeps the release it built and starts this runner as a job of the user's
 * service manager (a transient systemd user service, or a separate launchd job in the GUI
 * domain), which outlives the updater and the Gateway restarts. The runner moves the checkout to
 * the target commit, serves the Gateway from that release (it migrates state at boot) while the
 * checkout rebuilds, then serves the rebuilt checkout: the arrangement a by-hand rebuild leaves,
 * which current updates continue from.
 *
 * Linux with a systemd user service and macOS with a launchd user Gateway; elsewhere, and when
 * either cannot run it, the check prints the rebuild instead. Remove with
 * `update-candidate-check-early-release.ts` and the `-start`, `-service`, `-ready` and `-record`
 * siblings, on the evidence that file names.
 */

export const EARLY_RELEASE_RECOVERY_FLAG = "--early-release-recovery";
const DRIVER_EXIT_TIMEOUT_MS = 30 * 60_000;
/** Each rebuild command's limit. */
const COMMAND_TIMEOUT_MS = 60 * 60_000;
const MAX_RESTARTS = 2;

/** Runs a command; `stream` copies its output to this process's (the job log's) output. */
export const runRecoveryCommand: RunCommand = (argv, options = {}) =>
  new Promise((resolve) => {
    const child = spawn(argv[0]!, argv.slice(1), {
      cwd: options.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      // Its own group, so a timeout stops the build's descendants too.
      detached: true,
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
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {}
    }, options.timeoutMs ?? 120_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      resolve({ code: null, output: String(error) });
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code, output });
    });
  });

export const ok = (result: CommandResult) => result.code === 0;
export const commandTail = (result: CommandResult) =>
  result.output.trim().split("\n").slice(-6).join(" ").slice(-600);

export async function git(run: RunCommand, cwd: string, ...args: string[]) {
  return run(["git", "-C", cwd, ...args]);
}

/** A process's start identity (procfs ticks on Linux, seconds on macOS); null once it is gone. */
export function processStart(pid: number): string | null {
  const start = Number.isSafeInteger(pid) && pid > 0 ? getFileLockProcessStartTime(pid) : null;
  return start === null ? null : String(start);
}

function readText(file: string): string {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

/** A string field of a JSON file, or null when the file or field is missing. */
export function readJsonString(file: string, key: string): string | null {
  try {
    const value = safeParseJsonRecord(fs.readFileSync(file, "utf8"))?.[key];
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
}

export const buildCommit = (root: string) =>
  readJsonString(path.join(root, "dist", "build-info.json"), "commit");

export function removeTree(dir: string) {
  // Rename first, so an interrupted removal never leaves a half-removed release in place.
  const doomed = path.join(path.dirname(dir), `.removing-${path.basename(dir)}-${process.pid}`);
  fs.renameSync(dir, doomed);
  fs.rmSync(doomed, { recursive: true, force: true });
}

/** The early updater's release link. While it exists, `openclaw gateway install` on current
 * `main` binds the service to that updater's launcher, which starts the release the link names. */
export const legacyLinkPath = (plan: Pick<RecoveryPlan, "prefix">) =>
  path.join(plan.prefix, "lib", "node_modules", "openclaw");

type RunnerDeps = {
  run: RunCommand;
  log: (line: string) => void;
  /** True while the updater that started this runner has not exited. */
  driverAlive: (driver: RecoveryPlan["driver"]) => boolean;
  /** Restarts the service manager made of this runner's job after an abnormal exit. */
  restarts: (plan: RecoveryPlan) => Promise<number>;
  /** Every store's schema version now; null when unreadable. */
  schema: () => SchemaVersions | null;
  /** The Gateway service, through its manager. */
  service: GatewayServiceControl;
  /** The state directory this process resolves. */
  stateDir: () => string;
  /** Opens this recovery's update run and takes the release updater's lock, so an update the
   * new release's Gateway accepts waits; null while another update holds it. */
  hold: (plan: RecoveryPlan) => Promise<string | null>;
  /** Waits for the Gateway on this port to answer `/readyz`, without opening state; gives up
   * early when the service keeps failing. */
  ready: (port: number | null) => Promise<boolean>;
  record: (outcome: RecoveryOutcome) => Promise<void>;
  /** Runs the finishing step from the rebuilt checkout, whose code is this release's. */
  finish: (plan: RecoveryPlan, facts: FinishFacts) => Promise<CommandResult>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
};

/** `downtimeMs` is left out when a restart of the runner lost the first switch's timing. */
type FinishFacts = { downtimeMs?: number; runId?: string };

const REBUILD = "pnpm install --frozen-lockfile && pnpm build";
/** The command that finishes a recovery that stopped after migrating, run from the checkout. */
const FINISH = `${REBUILD} && openclaw gateway install --force`;
/** Each file of the Gateway's definition as it was before the recovery, kept beside it. */
const savedPath = (file: string) => `${file}.before-update-recovery`;

function realpath(file: string): string {
  try {
    return fs.realpathSync(file);
  } catch {
    return path.resolve(file);
  }
}

/**
 * The runner, started from the kept release. Every exit leaves a Gateway serving. Returns true
 * once the finishing step removed the kept release.
 */
export async function runEarlyGitReleaseRecovery(
  plan: RecoveryPlan,
  deps: RunnerDeps = defaultRunnerDeps(plan),
): Promise<boolean> {
  const { run, log, service } = deps;
  const original = savedPath(plan.serviceFile);
  const legacy = legacyLinkPath(plan);
  const gateway = path.basename(plan.serviceFile);
  const definition = () => readText(plan.serviceFile);
  // The plist names its paths XML-escaped.
  const names = (root: string) =>
    definition().includes(root) || definition().includes(escapeXml(root));
  const servesRelease = () => names(plan.release);
  // Any difference from the versions `--check` read, or an unreadable store, counts as moved:
  // the previous build is only put back on databases exactly as it left them.
  const moved = () => !isDeepStrictEqual(deps.schema(), plan.schema);
  const unitPort = () =>
    Number(/--port(?:\s+|<\/string>\s*<string>)(\d+)/u.exec(definition())?.[1]) || null;
  const cli = (root: string, ...args: string[]) =>
    run([process.execPath, path.join(root, "openclaw.mjs"), ...args], {
      cwd: root,
      stream: true,
      timeoutMs: 15 * 60_000,
    });
  // The CLI's own start check opens state, which the booting release holds for its migration,
  // so readiness is read over HTTP. `switched` is false when the definition never changed.
  const serve = async (root: string) => {
    // Keep the port the service runs on, which `--port` may have set outside the config.
    const current = unitPort();
    const port = current ? ["--port", String(current)] : [];
    const before = await service.loaded();
    const installed = await cli(root, "gateway", "install", "--force", ...port, "--json");
    const entry = path.join(root, "dist");
    if (!names(entry)) {
      return { switched: false, ready: false, detail: commandTail(installed) };
    }
    // The service manager keeps running what it loaded: a ready answer counts only from a
    // process it started from the new definition, not from the Gateway the install replaced.
    const ready = ok(installed) && (await deps.ready(unitPort()));
    const after = await service.loaded();
    const started = after.pid !== before.pid && after.command.includes(entry);
    return { switched: true, ready: ready && started, detail: commandTail(installed) };
  };
  // `gateway install --force` enables the systemd service; a disabled autostart stays disabled.
  const keepEnablement = async () => {
    if (
      plan.supervisor === "systemd" &&
      plan.enabled === "disabled" &&
      !ok(await run(["systemctl", "--user", "disable", gateway]))
    ) {
      log(
        `the Gateway service could not be disabled again; run \`systemctl --user disable ${gateway}\``,
      );
    }
  };
  const removeRelease = async () => {
    if (fs.existsSync(path.dirname(plan.release))) {
      removeTree(path.dirname(plan.release));
      await git(run, plan.checkout, "worktree", "prune");
    }
  };
  // The early updater's launcher starts only the release this link names, which cannot open
  // migrated state; the previous build may start through it.
  const removeLegacyLink = () => {
    if (fs.lstatSync(legacy, { throwIfNoEntry: false })?.isSymbolicLink()) {
      fs.rmSync(legacy);
    }
  };
  const restoreLegacyLink = () => {
    if (plan.legacyLink && !fs.lstatSync(legacy, { throwIfNoEntry: false })) {
      fs.mkdirSync(path.dirname(legacy), { recursive: true });
      fs.symlinkSync(plan.legacyLink, legacy);
    }
  };
  const saveDefinition = () => {
    for (const file of plan.definitionFiles) {
      // The environment file can hold secrets; the copy keeps its mode.
      fs.copyFileSync(file, savedPath(file));
      fs.chmodSync(savedPath(file), fs.statSync(file).mode & 0o777);
    }
  };
  const restoreDefinition = () => {
    for (const file of plan.definitionFiles) {
      const saved = savedPath(file);
      // An artifact the failed install left as it was has no copy left to restore.
      if (!fs.existsSync(saved)) {
        continue;
      }
      const temporary = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(temporary, fs.readFileSync(saved), {
        mode: fs.statSync(saved).mode & 0o777,
      });
      fs.renameSync(temporary, file);
      fs.rmSync(saved);
    }
  };
  const dropUnchangedCopies = () => {
    for (const file of plan.definitionFiles) {
      const saved = savedPath(file);
      if (fs.existsSync(saved) && fs.readFileSync(saved).equals(fs.readFileSync(file))) {
        fs.rmSync(saved);
      }
    }
  };
  let fastForwarded = false;
  // State the release may have migrated: the definition was saved just before the first switch,
  // and until then a different inventory (a new or unreadable store) is not a migration.
  const migratedByRelease = () => fs.existsSync(original) && moved();
  const abandon = async (why: string) => {
    // A resumed runner can stop after the release migrated state; the previous build cannot
    // open it, so the release keeps serving and the outcome names the finishing command.
    if (migratedByRelease()) {
      const failed = await fail(
        "early-release-recovery-stopped",
        `The recovery stopped: ${why}. Your databases were already migrated, so the Gateway service keeps ${servesRelease() ? "the new release" : "the checkout"}. ${kept()}`,
        `from the checkout run \`${FINISH}\``,
      );
      if ((await service.state()) !== "active") {
        await service.start(false);
      }
      return failed;
    }
    // The service may run the release, which can still be migrating: stop it and compare the
    // schemas again before the previous build comes back.
    if (servesRelease()) {
      return notReady(`The recovery stopped: ${why}`);
    }
    const moves = fastForwarded
      ? ` The checkout's branch was fast-forwarded to ${plan.target.slice(0, 11)} but not rebuilt; the Gateway still serves the previous build.`
      : "";
    log(
      `stopped before changing the Gateway: ${why}.${moves} The next \`openclaw update\` tries again.`,
    );
    restoreLegacyLink();
    // A failed install may have rewritten, stopped or (on launchd) unloaded the service; the
    // previous build serves again from its own definition. Only the definition of the previous
    // build is put back: abandon never runs once state moved.
    dropUnchangedCopies();
    const changed = plan.definitionFiles.some((file) => fs.existsSync(savedPath(file)));
    if (changed && (await service.stop())) {
      restoreDefinition();
    }
    if (changed || (await service.state()) !== "active") {
      await service.start(true);
    }
    // A failed install may still have enabled the service.
    await keepEnablement();
    await removeRelease();
    return false;
  };
  let runId: string | undefined;
  const fail = async (reason: string, detail: string, nextAction: string, always = false) => {
    log(`${detail} Next step: ${nextAction}`);
    await keepEnablement();
    const migrated = always || moved();
    // Once state moved, `gateway install --force` would otherwise bind the early launcher.
    if (migrated) {
      removeLegacyLink();
    }
    // Recording opens state through this release, which migrates it: only once it moved, once
    // this runner holds a run, whose opening already wrote state, or when the service keeps the
    // release, which migrates state anyway when it starts.
    if (migrated || runId) {
      await deps.record({ plan, runId, status: "failed", reason, detail, nextAction });
    }
    return false;
  };
  const kept = () => `The service definition from before the recovery is kept at ${original}.`;
  /** The release does not serve. Unmigrated databases get the previous build back. */
  const notReady = async (why: string) => {
    let unconfirmed = false;
    if (!moved() && fs.existsSync(original)) {
      // Stopped and confirmed down before the second comparison: a release inside a migration
      // commits it before it exits.
      unconfirmed = !(await service.stop());
      if (!unconfirmed && !moved()) {
        restoreDefinition();
        restoreLegacyLink();
        await service.start(true);
        await keepEnablement();
        const back = await deps.ready(unitPort());
        // The release goes only once the previous build serves; until then it is the other build.
        if (back) {
          await removeRelease();
        }
        const next = back
          ? `see ${service.describe} and ${plan.follow} for why the new release stopped, fix that, then run \`openclaw update\` again`
          : `see ${service.describe} for why the previous build does not start`;
        const detail = `${why}. Nothing was migrated, so the Gateway service starts the previous build again${back ? " and it serves" : `, which did not report ready either; the new release stays at ${path.dirname(plan.release)}`}.`;
        if (runId) {
          await deps.record({
            plan,
            runId,
            status: "failed",
            reason: "early-release-recovery-put-back",
            detail,
            nextAction: next,
          });
        }
        log(
          `${detail}${runId ? "" : " This is not recorded for `openclaw update status`, because recording through the new release would migrate the databases the previous build uses."} Next step: ${next}.`,
        );
        return false;
      }
    }
    const cause = unconfirmed
      ? "the Gateway service did not confirm it stopped, so whether the new release migrated your databases is unknown"
      : !fs.existsSync(original)
        ? "its definition from before the recovery is missing"
        : deps.schema()
          ? "your databases are no longer as the previous build left them"
          : "your databases could not be read, so whether they were migrated is unknown";
    const state = await service.state();
    // Recorded before the release starts again, so the two do not open state at the same time.
    const failed = await fail(
      "early-release-recovery-start-failed",
      `${why}, and ${cause}, so the previous build was not put back. ${state === "active" ? "The Gateway service still runs the new release." : `The Gateway service ${state === "failed" ? "had failed" : `was ${state || "not running"}`}; it starts the new release again, and the service manager restarts it after a failure.`} ${kept()}`,
      `see ${service.describe} for why the new release does not start, fix that, then from the checkout run \`${FINISH}\``,
      true,
    );
    if (state !== "active") {
      await service.start(false);
    }
    return failed;
  };

  const recover = async (): Promise<boolean> => {
    // The runner reads and records state through the state directory the service uses; under
    // another one every schema comparison and record would be about the wrong installation.
    if (realpath(deps.stateDir()) !== realpath(plan.stateDir)) {
      log(
        `stopped before changing the Gateway: this job resolves the state directory ${deps.stateDir()}, not the service's ${plan.stateDir}. Next step: run \`openclaw update\` again from the checkout.`,
      );
      // The service never named the release unless an earlier run of this job moved it there.
      if (!servesRelease()) {
        await removeRelease();
      }
      return false;
    }
    const restarts = await deps.restarts(plan);
    if (restarts > MAX_RESTARTS) {
      const why = `The recovery was interrupted ${MAX_RESTARTS + 1} times`;
      if (!migratedByRelease()) {
        return servesRelease() ? notReady(why) : abandon("it was interrupted repeatedly");
      }
      return fail(
        "early-release-recovery-interrupted",
        `${why}; the Gateway service starts ${servesRelease() ? "the new release" : "the checkout"}.`,
        `from the checkout, run \`${FINISH}\``,
      );
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
      const branch = (await git(run, plan.checkout, "symbolic-ref", "-q", "--short", "HEAD"))
        .output;
      const dirty = await git(run, plan.checkout, "status", "--porcelain", "--untracked-files=no");
      if (branch.trim() !== plan.branch || !ok(dirty) || dirty.output.trim()) {
        return abandon("the checkout changed since the update checked it");
      }
      log(`fast-forwarding ${plan.branch} to ${plan.target}`);
      const merged = await git(run, plan.checkout, "merge", "--ff-only", "--quiet", plan.target);
      if (!ok(merged)) {
        return abandon(`the fast-forward failed (${commandTail(merged)})`);
      }
      // A pull past the target since the check leaves HEAD elsewhere; never build that.
      if ((await git(run, plan.checkout, "rev-parse", "HEAD")).output.trim() !== plan.target) {
        return abandon(`the checkout's branch moved past ${plan.target.slice(0, 11)}`);
      }
      fastForwarded = true;
    }
    // Killed after the final switch: only the finishing step is left, once the manager runs the
    // rebuilt checkout (a published definition alone does not mean it restarted).
    if (
      !servesRelease() &&
      buildCommit(plan.checkout) === plan.target &&
      moved() &&
      (await deps.ready(unitPort())) &&
      (await service.loaded()).command.includes(path.join(plan.checkout, "dist"))
    ) {
      runId = (await deps.hold(plan)) ?? undefined;
      await keepEnablement();
      await deps.finish(plan, runId ? { runId } : {});
      return !fs.existsSync(plan.release);
    }
    let downtimeMs = 0;
    const switched = async (root: string) => {
      const started = deps.now();
      const result = await serve(root);
      downtimeMs += deps.now() - started;
      return result;
    };
    if (!servesRelease()) {
      // One copy of the definition as the user left it; a resumed run keeps the first copy.
      if (restarts === 0 || !fs.existsSync(original)) {
        saveDefinition();
      }
      removeLegacyLink();
      log("restarting the Gateway on the new release; it migrates state at startup");
      const served = await switched(plan.release);
      if (!served.switched) {
        return abandon(
          `the Gateway service could not be moved to the new release (${served.detail})`,
        );
      }
      if (!served.ready) {
        return notReady("The new release did not report ready");
      }
    } else if (!(await deps.ready(unitPort()))) {
      // Resumed while the release migrates at boot: it holds state until it reports ready.
      return notReady("The new release did not report ready");
    }
    runId = (await deps.hold(plan)) ?? undefined;
    if (!runId) {
      return fail(
        "early-release-recovery-update-running",
        "The Gateway serves the new release, but another update is running, so the checkout was not rebuilt.",
        `once it finishes, from the checkout run \`${FINISH}\``,
      );
    }
    // A build this job ran before the service manager restarted it leaves its artifact lock.
    // The restart killed that run's processes, which is what the lock asks to verify first.
    const buildLock = path.join(plan.checkout, ".artifacts", "dist-artifacts.lock");
    const owner = safeParseJsonRecord(readText(path.join(buildLock, "owner.json")));
    const ownerStarted = Date.parse(String(owner?.startedAt));
    if (restarts > 0 && ownerStarted >= plan.plannedAt && !processStart(Number(owner?.pid))) {
      log(
        `releasing the build lock left by this recovery's interrupted build (PID ${String(owner?.pid)})`,
      );
      fs.rmSync(buildLock, { recursive: true, force: true });
    }
    const leftovers = `The kept release (${path.dirname(plan.release)}) and the older layout's releases under ${plan.prefix} stay on disk; after the rebuild nothing uses them.`;
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
          `The Gateway serves OpenClaw ${VERSION} from the release the update built. \`${argv.join(" ")}\` failed in the checkout (${commandTail(built)}). ${kept()} ${leftovers}`,
          `fix the cause, then from the checkout run \`${FINISH}\``,
        );
      }
    }
    log("restarting the Gateway on the rebuilt checkout");
    const final = await switched(plan.checkout);
    if (!final.ready) {
      const back = await serve(plan.release);
      return fail(
        "early-release-recovery-switch-failed",
        `The rebuilt checkout did not become ready (${final.detail}); the Gateway ${back.ready ? "serves the new release again" : "could not be put back on the new release"}. ${kept()} ${leftovers}`,
        `see ${plan.follow}, then from the checkout run \`${FINISH}\``,
      );
    }
    await keepEnablement();
    // A resumed runner lost the first switch's timing; leave it out rather than understate it.
    const finished = await deps.finish(plan, { ...(restarts > 0 ? {} : { downtimeMs }), runId });
    if (!ok(finished)) {
      log(`the rebuilt checkout serves, but cleanup did not finish (${commandTail(finished)})`);
    }
    return !fs.existsSync(plan.release);
  };

  try {
    return await recover();
  } catch (error) {
    const why = `The recovery stopped on an unexpected error (${String(error)})`;
    if (migratedByRelease()) {
      return fail(
        "early-release-recovery-error",
        `${why}; the Gateway service starts ${servesRelease() ? "the new release" : "the checkout"}.`,
        `see ${plan.follow}, then from the checkout run \`${FINISH}\``,
      );
    }
    try {
      return await (servesRelease() ? notReady(why) : abandon(why));
    } catch (again) {
      log(
        `${why}, and putting the previous state back failed (${String(again)}). Next step: see ${plan.follow}.`,
      );
      return false;
    }
  }
}

/** Live processes and their command lines. */
function listProcesses(): Array<{ pid: string; argv: string }> {
  if (fs.existsSync("/proc")) {
    return fs
      .readdirSync("/proc")
      .filter((pid) => /^\d+$/u.test(pid))
      .map((pid) => ({
        pid,
        argv: readText(`/proc/${pid}/cmdline`).replaceAll("\0", " "),
      }));
  }
  // macOS has no procfs; ps prints the whole command line with `-ww`.
  try {
    return execFileSync("/bin/ps", ["-axww", "-o", "pid=,command="], { encoding: "utf8" })
      .split("\n")
      .flatMap((line) => {
        const match = /^\s*(\d+)\s+(.*)$/u.exec(line);
        return match ? [{ pid: match[1]!, argv: match[2]! }] : [];
      });
  } catch {
    return [];
  }
}

/**
 * The last step, run from the rebuilt checkout so the kept release can be removed. Removes what
 * the early layout left and records the outcome for `openclaw update status`.
 */
export async function finishEarlyGitReleaseRecovery(
  plan: RecoveryPlan,
  facts: FinishFacts,
  deps: Pick<RunnerDeps, "run" | "log" | "record"> & {
    processes?: () => Array<{ pid: string; argv: string }>;
  } = defaultRunnerDeps(plan),
) {
  const removed: string[] = [];
  const kept: string[] = [];
  const releases = path.join(plan.prefix, "releases");
  const trial = path.join(releases, ".trial");
  try {
    const record = safeParseJsonRecord(fs.readFileSync(trial, "utf8"));
    if (record && !("v" in record)) {
      fs.rmSync(trial);
      removed.push("the old-format trial");
    }
  } catch {}
  const legacy = legacyLinkPath(plan);
  if (fs.lstatSync(legacy, { throwIfNoEntry: false })?.isSymbolicLink()) {
    fs.rmSync(legacy);
    removed.push("the old release link");
  }
  for (const dir of ["lib/node_modules", "lib"]) {
    try {
      fs.rmdirSync(path.join(plan.prefix, dir));
    } catch {}
  }
  const live = (deps.processes ?? listProcesses)();
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
    // This step and the runner that started it carry the plan in argv; the runner exits next.
    const others = live.filter(({ pid }) => ![process.pid, process.ppid].includes(Number(pid)));
    if (others.some(({ argv }) => argv.includes(dir))) {
      kept.push(dir);
      continue;
    }
    removeTree(dir);
    removed.push(path.relative(plan.prefix, dir));
  }
  await git(deps.run, plan.checkout, "worktree", "prune");
  // Removals a killed process renamed away but did not finish, and dead checks' start locks.
  for (const dir of [plan.prefix, releases]) {
    for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
      if (name.startsWith(".removing-") || name.startsWith(".recovery-start.stale-")) {
        fs.rmSync(path.join(dir, name), { recursive: true, force: true });
      }
    }
  }
  const runners = live
    .filter(
      ({ pid, argv }) =>
        Number(pid) !== process.pid &&
        argv.includes(`${plan.checkout}/openclaw.mjs`) &&
        / node (run|start)\b/u.test(argv),
    )
    .map(({ pid }) => pid);
  const savedCopies = plan.definitionFiles.map(savedPath).filter((file) => fs.existsSync(file));
  const detail = [
    `Rebuilt the checkout at ${plan.target.slice(0, 11)} and moved the Gateway onto it.`,
    savedCopies.length
      ? `The service definition from before the recovery is kept at ${savedCopies.join(", ")}.`
      : "",
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
    ...(facts.runId ? { runId: facts.runId } : {}),
    status: "succeeded",
    reason: "early-release-recovered",
    detail,
    ...(facts.downtimeMs === undefined ? {} : { downtimeMs: facts.downtimeMs }),
    ...(runners.length
      ? { nextAction: "restart the node runner that runs from this checkout" }
      : {}),
  });
}

/** The finishing step's arguments to `update-migrated-finalize.worker`. */
const earlyReleaseFinishArgs = (plan: RecoveryPlan, facts: FinishFacts) => [
  EARLY_RELEASE_RECOVERY_FLAG,
  JSON.stringify(plan),
  "finish",
  JSON.stringify(facts),
];

/** `update-migrated-finalize.worker --early-release-recovery <plan> [finish <facts>]`. */
export function readEarlyGitReleaseRecoveryArgs(argv: readonly string[]) {
  // SAFETY: the plan is written by this same build (`--check` or the runner).
  const plan = JSON.parse(argv[0] ?? "") as RecoveryPlan;
  if (argv[1] !== "finish") {
    return { plan, finish: null };
  }
  const facts = safeParseJsonRecord(argv[2] ?? "");
  const [runId, downtimeMs] = [facts?.runId, facts?.downtimeMs];
  const finish: FinishFacts = {
    ...(typeof runId === "string" ? { runId } : {}),
    ...(typeof downtimeMs === "number" ? { downtimeMs } : {}),
  };
  return { plan, finish };
}

const log = (line: string) =>
  process.stdout.write(`[${new Date().toISOString()}] [openclaw update recovery] ${line}\n`);

const record = async (outcome: RecoveryOutcome) => {
  try {
    await recordOutcome(outcome);
  } catch (error) {
    log(`the outcome could not be recorded for \`openclaw update status\`: ${String(error)}`);
  }
};

export function defaultRunnerDeps(plan: RecoveryPlan): RunnerDeps {
  const service = gatewayServiceControl(plan, runRecoveryCommand);
  return {
    run: runRecoveryCommand,
    log,
    driverAlive: (driver) => processStart(driver.pid) === driver.start,
    restarts: (current) => recoveryJobRestarts(current, runRecoveryCommand),
    schema: () => readSchemaVersions(),
    service,
    stateDir: () => resolveStateDir(process.env),
    // The same loopback probe `openclaw gateway start` waits on, including TLS pinning.
    ready: async (port) => {
      if (!port) {
        return false;
      }
      const [{ readSourceConfigBestEffort }, { waitForGatewayHttpReadiness }] = await Promise.all([
        import("../config/io.runtime.js"),
        import("../cli/daemon-cli/restart-health-probe.js"),
      ]);
      const config = await readSourceConfigBestEffort().catch(() => ({}));
      const probe = async () =>
        (
          await waitForGatewayHttpReadiness({
            config,
            port,
            attempts: 5,
            deadlineAt: performance.now() + 5000,
            delayMs: 1000,
          })
        ).readyz === 200;
      return waitForGatewayReady(service, probe, { now: Date.now, log });
    },
    record,
    hold: holdUpdateLock,
    finish: (current, facts) => {
      const worker = resolveRuntimeWorkerUrl({
        ...runtimeProcessEntrypoints.updateMigratedFinalize,
        root: current.checkout,
      });
      return runRecoveryCommand(
        [process.execPath, fileURLToPath(worker), ...earlyReleaseFinishArgs(current, facts)],
        { cwd: current.checkout, stream: true, timeoutMs: 10 * 60_000 },
      );
    },
    now: Date.now,
    sleep: (ms) => delay(ms),
  };
}
