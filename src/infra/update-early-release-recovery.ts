import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { safeParseJsonRecord } from "@openclaw/normalization-core/json-coercion";
import { VERSION } from "../version.js";
import { runtimeProcessEntrypoints } from "./runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";
import { readSchemaVersions, type SchemaVersions } from "./update-candidate-check-early-release.js";

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
const DRIVER_EXIT_TIMEOUT_MS = 30 * 60_000;
const COMMAND_TIMEOUT_MS = 60 * 60_000;
/** A boot migration of a large agent database runs before the Gateway reports ready. */
const READY_TIMEOUT_MS = 20 * 60_000;
const MAX_RESTARTS = 2;

export type RecoveryPlan = {
  unit: string;
  checkout: string;
  branch: string;
  target: string;
  /** The release the updater built, kept here for the rebuild window. */
  release: string;
  prefix: string;
  serviceFile: string;
  /** `systemctl --user is-enabled` of the Gateway service when the recovery was planned. */
  enabled: string;
  /** Every store's schema version when the recovery was planned. */
  schema: SchemaVersions;
  fromVersion: string;
  driver: { pid: number; start: string };
  /** When `--check` planned this recovery (epoch milliseconds). */
  plannedAt: number;
};

export type CommandResult = { code: number | null; output: string };
export type RunCommand = (
  argv: string[],
  options?: { cwd?: string; stream?: boolean; timeoutMs?: number },
) => Promise<CommandResult>;

/** Runs a command; `stream` copies its output to this process's (the journal's) output. */
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

export function processStart(pid: number): string | null {
  try {
    // Field 22 (start time) follows the parenthesized command, which can contain spaces.
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] ?? null;
  } catch {
    return null;
  }
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

export type RunnerDeps = {
  run: RunCommand;
  log: (line: string) => void;
  /** True while the updater that started this runner has not exited. */
  driverAlive: (driver: RecoveryPlan["driver"]) => boolean;
  /** Restarts systemd made of this unit after an abnormal exit. */
  restarts: (unit: string) => Promise<number>;
  /** Every store's schema version now; null when unreadable. */
  schema: () => SchemaVersions | null;
  /** Opens this recovery's update run and takes the release updater's lock, so an update the
   * new release's Gateway accepts waits; null while another update holds it. */
  hold: (plan: RecoveryPlan) => Promise<string | null>;
  /** Waits for the Gateway on this port to answer `/readyz`, without opening state; gives up
   * early when the service unit keeps failing. */
  ready: (port: number | null, unit: string) => Promise<boolean>;
  record: (outcome: RecoveryOutcome) => Promise<void>;
  /** Runs the finishing step from the rebuilt checkout, whose code is this release's. */
  finish: (plan: RecoveryPlan, facts: FinishFacts) => Promise<CommandResult>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
};

/** `downtimeMs` is left out when a restart of the runner lost the first switch's timing. */
export type FinishFacts = { downtimeMs?: number; runId?: string };
type RecoveryOutcome = {
  plan: RecoveryPlan;
  runId?: string;
  status: "succeeded" | "failed";
  reason: string;
  detail: string;
  nextAction?: string;
  downtimeMs?: number;
};

const REBUILD = "pnpm install --frozen-lockfile && pnpm build";
/** The Gateway service's own definition before the recovery changed it, kept beside it. */
export const originalUnitPath = (plan: RecoveryPlan) =>
  `${plan.serviceFile}.before-update-recovery`;

/**
 * The runner, started from the kept release. Every exit leaves a Gateway serving. Returns true
 * once the finishing step removed the kept release.
 */
export async function runEarlyGitReleaseRecovery(
  plan: RecoveryPlan,
  deps: RunnerDeps = defaultRunnerDeps(),
): Promise<boolean> {
  const { run, log } = deps;
  const original = originalUnitPath(plan);
  const gateway = path.basename(plan.serviceFile);
  const systemctl = (...args: string[]) => run(["systemctl", "--user", ...args]);
  const servesRelease = () => fs.readFileSync(plan.serviceFile, "utf8").includes(plan.release);
  // Any difference from the versions `--check` read, or an unreadable store, counts as moved:
  // the previous build is only put back on databases exactly as it left them.
  const moved = () => !isDeepStrictEqual(deps.schema(), plan.schema);
  const unitPort = () =>
    Number(/--port\s+(\d+)/u.exec(fs.readFileSync(plan.serviceFile, "utf8"))?.[1]) || null;
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
    const installed = await cli(root, "gateway", "install", "--force", ...port, "--json");
    if (!fs.readFileSync(plan.serviceFile, "utf8").includes(path.join(root, "dist"))) {
      return { switched: false, ready: false, detail: commandTail(installed) };
    }
    return {
      switched: true,
      ready: await deps.ready(unitPort(), gateway),
      detail: commandTail(installed),
    };
  };
  // `gateway install --force` enables the service; a disabled autostart stays disabled.
  const keepEnablement = async () => {
    if (plan.enabled === "disabled" && !ok(await systemctl("disable", gateway))) {
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
  let fastForwarded = false;
  const abandon = async (why: string) => {
    const moves = fastForwarded
      ? ` The checkout's branch was fast-forwarded to ${plan.target.slice(0, 11)} but not rebuilt; the Gateway still serves the previous build.`
      : "";
    log(
      `stopped before changing the Gateway: ${why}.${moves} The next \`openclaw update\` tries again.`,
    );
    // A failed install may still have enabled the service.
    await keepEnablement();
    if (
      fs.existsSync(original) &&
      fs.readFileSync(original).equals(fs.readFileSync(plan.serviceFile))
    ) {
      fs.rmSync(original);
    }
    await removeRelease();
    return false;
  };
  let runId: string | undefined;
  const fail = async (reason: string, detail: string, nextAction: string) => {
    log(`${detail} Next step: ${nextAction}`);
    await keepEnablement();
    // Recording opens state through this release, which migrates it: only once it moved, or
    // once this runner holds a run, whose opening already wrote state.
    if (runId || moved()) {
      await deps.record({ plan, runId, status: "failed", reason, detail, nextAction });
    }
    return false;
  };
  const kept = () => `The service definition from before the recovery is kept at ${original}.`;
  /** The release does not serve. Unmigrated databases get the previous build back. */
  const notReady = async (why: string) => {
    if (!moved() && fs.existsSync(original)) {
      // Stopped first, so nothing can start migrating between the comparison and the switch.
      await systemctl("stop", gateway);
      if (!moved()) {
        const temporary = `${plan.serviceFile}.${process.pid}.tmp`;
        fs.writeFileSync(temporary, fs.readFileSync(original), {
          mode: fs.statSync(original).mode & 0o777,
        });
        fs.renameSync(temporary, plan.serviceFile);
        await systemctl("daemon-reload");
        await systemctl("reset-failed", gateway);
        await systemctl("start", gateway);
        await keepEnablement();
        const back = await deps.ready(unitPort(), gateway);
        fs.rmSync(original);
        await removeRelease();
        const next = back
          ? `see \`journalctl --user -u ${gateway}\` and \`journalctl --user -u ${plan.unit}\` for why it stopped, fix that, then run \`openclaw update\` again`
          : `run \`systemctl --user status ${gateway}\` and \`journalctl --user -u ${gateway}\` for why the previous build does not start`;
        const detail = `${why}. Nothing was migrated, so the Gateway service starts the previous build again${back ? " and it serves" : ", which did not report ready either"}.`;
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
      await systemctl("reset-failed", gateway);
      await systemctl("start", gateway);
    }
    return fail(
      "early-release-recovery-start-failed",
      `${why}, and ${moved() ? "your databases are no longer as the previous build left them" : "its definition from before the recovery is missing"}, so the previous build was not put back; the Gateway service keeps starting the new release. ${kept()}`,
      `see \`journalctl --user -u ${gateway}\` for why the new release does not start, fix that, then from the checkout run \`${REBUILD} && openclaw gateway install --force\``,
    );
  };

  const recover = async (): Promise<boolean> => {
    const restarts = await deps.restarts(plan.unit);
    if (restarts > MAX_RESTARTS) {
      const why = `The recovery was interrupted ${MAX_RESTARTS + 1} times`;
      if (!moved()) {
        return servesRelease() ? notReady(why) : abandon("it was interrupted repeatedly");
      }
      return fail(
        "early-release-recovery-interrupted",
        `${why}; the Gateway service starts ${servesRelease() ? "the new release" : "the checkout"}.`,
        `from the checkout, run \`${REBUILD} && openclaw gateway install --force\``,
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
    // Killed after the final switch: only the finishing step is left.
    if (
      !servesRelease() &&
      buildCommit(plan.checkout) === plan.target &&
      moved() &&
      (await deps.ready(unitPort(), gateway))
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
        fs.copyFileSync(plan.serviceFile, original);
      }
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
    } else if (!(await deps.ready(unitPort(), gateway))) {
      // Resumed while the release migrates at boot: it holds state until it reports ready.
      return notReady("The new release did not report ready");
    }
    runId = (await deps.hold(plan)) ?? undefined;
    if (!runId) {
      return fail(
        "early-release-recovery-update-running",
        "The Gateway serves the new release, but another update is running, so the checkout was not rebuilt.",
        `once it finishes, from the checkout run \`${REBUILD} && openclaw gateway install --force\``,
      );
    }
    // A build this unit ran before systemd restarted it leaves its artifact lock. The restart
    // killed that run's whole cgroup, which is what the lock asks to verify before release.
    const buildLock = path.join(plan.checkout, ".artifacts", "dist-artifacts.lock");
    const owner = safeParseJsonRecord(readText(path.join(buildLock, "owner.json")));
    const ownerStarted = Date.parse(String(owner?.startedAt));
    if (restarts > 0 && ownerStarted >= plan.plannedAt && !processStart(Number(owner?.pid))) {
      log(
        `releasing the build lock left by this recovery's interrupted build (PID ${String(owner?.pid)})`,
      );
      fs.rmSync(buildLock, { recursive: true, force: true });
    }
    const leftovers = `The kept release (${path.dirname(plan.release)}) and the older layout's link and releases under ${plan.prefix} stay on disk; after the rebuild nothing uses them.`;
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
          `fix the cause, then from the checkout run \`${REBUILD} && openclaw gateway install --force\``,
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
        `see \`journalctl --user -u ${plan.unit}\`, then from the checkout run \`${REBUILD} && openclaw gateway install --force\``,
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
    if (moved()) {
      return fail(
        "early-release-recovery-error",
        `${why}; the Gateway service starts ${servesRelease() ? "the new release" : "the checkout"}.`,
        `see \`journalctl --user -u ${plan.unit}\`, then from the checkout run \`${REBUILD} && openclaw gateway install --force\``,
      );
    }
    try {
      return await (servesRelease() ? notReady(why) : abandon(why));
    } catch (again) {
      log(
        `${why}, and putting the previous state back failed (${String(again)}). Next step: see \`journalctl --user -u ${plan.unit}\`.`,
      );
      return false;
    }
  }
}

/**
 * The last step, run from the rebuilt checkout so the kept release can be removed. Removes what
 * the early layout left and records the outcome for `openclaw update status`.
 */
export async function finishEarlyGitReleaseRecovery(
  plan: RecoveryPlan,
  facts: FinishFacts,
  deps: Pick<RunnerDeps, "run" | "log" | "record"> = defaultRunnerDeps(),
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
  // Removals a killed process renamed away but did not finish.
  for (const dir of [plan.prefix, releases]) {
    for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
      if (name.startsWith(".removing-")) {
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
  const detail = [
    `Rebuilt the checkout at ${plan.target.slice(0, 11)} and moved the Gateway onto it.`,
    fs.existsSync(originalUnitPath(plan))
      ? `The service definition from before the recovery is kept at ${originalUnitPath(plan)}.`
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

async function recordOutcome(outcome: RecoveryOutcome) {
  const [{ finishUpdateRunAsync, recordUpdateRunStepAsync }, store] = await Promise.all([
    import("./update-run-write.async.js"),
    import("../update/store.js"),
  ]);
  // Without a held run, take the lock as `hold` does: that settles an interrupted runner's run.
  const runId =
    outcome.runId ?? (await holdUpdateLock(outcome.plan)) ?? (await openRun(outcome.plan));
  try {
    await recordUpdateRunStepAsync(runId, {
      step: "early-release-recovery",
      status: outcome.status === "succeeded" ? "completed" : "failed",
      endedAtMs: Date.now(),
      detail: outcome.detail,
    });
    await finishUpdateRunAsync(runId, {
      status: outcome.status,
      reason: outcome.reason,
      ...(outcome.nextAction ? { nextAction: outcome.nextAction } : {}),
      ...(outcome.status === "succeeded"
        ? { after: { version: VERSION, sha: outcome.plan.target } }
        : {}),
      ...(outcome.downtimeMs === undefined ? {} : { downtimeMs: outcome.downtimeMs }),
    });
  } finally {
    // Held by this runner, or by the runner that started this finishing step.
    const holder = (await store.readUpdateLock())?.pid;
    if (holder === process.pid || holder === process.ppid) {
      await store.releaseUpdateLock();
    }
  }
}

async function openRun(plan: RecoveryPlan): Promise<string> {
  const { createUpdateRunAsync } = await import("./update-run-write.async.js");
  const target = { kind: "git" as const, version: VERSION, sha: plan.target };
  const run = await createUpdateRunAsync({
    trigger: "cli",
    target,
    before: { version: plan.fromVersion },
  });
  return run.runId;
}

/** The release updater's lock, held by this runner's update run until its outcome is recorded. */
export async function holdUpdateLock(plan: RecoveryPlan): Promise<string | null> {
  const [{ finishUpdateRunAsync }, store] = await Promise.all([
    import("./update-run-write.async.js"),
    import("../update/store.js"),
  ]);
  const runId = await openRun(plan);
  const lock = await store.acquireUpdateLock({
    runId,
    pid: process.pid,
    deadlineMs: COMMAND_TIMEOUT_MS * 3,
  });
  if (lock.acquired && lock.previous) {
    // An interrupted runner's run; the Gateway would otherwise settle it at its next start.
    await finishUpdateRunAsync(lock.previous.runId, { status: "failed", reason: "interrupted" });
  }
  if (!lock.acquired) {
    await finishUpdateRunAsync(runId, { status: "skipped", reason: "update-running" });
    return null;
  }
  return runId;
}

/** The finishing step's arguments to `update-migrated-finalize.worker`. */
export const earlyReleaseFinishArgs = (plan: RecoveryPlan, facts: FinishFacts) => [
  EARLY_RELEASE_RECOVERY_FLAG,
  JSON.stringify(plan),
  "finish",
  JSON.stringify(facts),
];

/** `update-migrated-finalize.worker --early-release-recovery <plan> [finish <facts>]`. */
export async function runEarlyGitReleaseRecoveryMode(argv: readonly string[]): Promise<number> {
  // SAFETY: the plan is written by this same build (`--check` or the runner).
  const plan = JSON.parse(argv[1] ?? "") as RecoveryPlan;
  if (argv[2] !== "finish") {
    // On success the finishing step removed the release this process runs from; nothing more
    // loads from it. A recovery that did not finish shows as failed in `systemctl --user status`.
    return (await runEarlyGitReleaseRecovery(plan)) ? 0 : 1;
  }
  const facts = safeParseJsonRecord(argv[3] ?? "");
  const [runId, downtimeMs] = [facts?.runId, facts?.downtimeMs];
  await finishEarlyGitReleaseRecovery(plan, {
    ...(typeof runId === "string" ? { runId } : {}),
    ...(typeof downtimeMs === "number" ? { downtimeMs } : {}),
  });
  return 0;
}

const log = (line: string) => process.stdout.write(`[openclaw update recovery] ${line}\n`);
const record = async (outcome: RecoveryOutcome) => {
  try {
    await recordOutcome(outcome);
  } catch (error) {
    log(`the outcome could not be recorded for \`openclaw update status\`: ${String(error)}`);
  }
};

function defaultRunnerDeps(): RunnerDeps {
  return {
    run: runRecoveryCommand,
    log,
    driverAlive: (driver) => processStart(driver.pid) === driver.start,
    restarts: async (unit) =>
      Number(
        (
          await runRecoveryCommand([
            "systemctl",
            "--user",
            "show",
            "--property=NRestarts",
            "--value",
            unit,
          ])
        ).output.trim(),
      ) || 0,
    schema: () => readSchemaVersions(),
    // The same loopback probe `openclaw gateway start` waits on, including TLS pinning.
    ready: async (port, unit) => {
      if (!port) {
        return false;
      }
      const [{ readSourceConfigBestEffort }, { waitForGatewayHttpReadiness }] = await Promise.all([
        import("../config/io.runtime.js"),
        import("../cli/daemon-cli/restart-health-probe.js"),
      ]);
      const config = await readSourceConfigBestEffort().catch(() => ({}));
      const until = Date.now() + READY_TIMEOUT_MS;
      while (Date.now() < until) {
        const readiness = await waitForGatewayHttpReadiness({
          config,
          port,
          attempts: 5,
          deadlineAt: performance.now() + 5000,
          delayMs: 1000,
        });
        if (readiness.readyz === 200) {
          return true;
        }
        // A migrating Gateway stays up while it works. One that keeps exiting before it serves
        // is restarted until the unit's own start limit fails it; that limit is sized for a
        // Gateway waiting out a previous one, so it is the crash-loop signal.
        const state = await runRecoveryCommand([
          "systemctl",
          "--user",
          "show",
          "--property=ActiveState",
          "--value",
          unit,
        ]);
        if (state.output.trim() === "failed") {
          log(`${unit} failed at its start limit before it served`);
          return false;
        }
      }
      return false;
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
