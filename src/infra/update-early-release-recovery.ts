import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { safeParseJsonRecord } from "@openclaw/normalization-core/json-coercion";
import { VERSION } from "../version.js";
import { runtimeProcessEntrypoints } from "./runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";
import { readPendingSchemaChange } from "./update-candidate-check-early-release.js";

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
export const runCommand: RunCommand = (argv, options = {}) =>
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
export const tail = (result: CommandResult) =>
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
  migrated: () => boolean;
  /** Opens this recovery's update run and takes the release updater's lock, so an update the
   * new release's Gateway accepts waits; null while another update holds it. */
  hold: (plan: RecoveryPlan) => Promise<string | null>;
  /** Waits for the Gateway on this port to answer `/readyz`, without opening state. */
  ready: (port: number | null) => Promise<boolean>;
  record: (outcome: RecoveryOutcome) => Promise<void>;
  /** Runs the finishing step from the rebuilt checkout, whose code is this release's. */
  finish: (plan: RecoveryPlan, facts: FinishFacts) => Promise<CommandResult>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
};

export type FinishFacts = { downtimeMs: number; runId?: string };
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

/**
 * The runner, started from the kept release. Every exit leaves a Gateway serving. Returns true
 * once the finishing step removed the kept release.
 */
export async function runEarlyGitReleaseRecovery(
  plan: RecoveryPlan,
  deps: RunnerDeps = defaultRunnerDeps(),
): Promise<boolean> {
  const { run, log } = deps;
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
    const current = /--port\s+(\d+)/u.exec(fs.readFileSync(plan.serviceFile, "utf8"))?.[1];
    const port = current ? ["--port", current] : [];
    const installed = await cli(root, "gateway", "install", "--force", ...port, "--json");
    const unit = fs.readFileSync(plan.serviceFile, "utf8");
    if (!unit.includes(path.join(root, "dist"))) {
      return { switched: false, ready: false, detail: tail(installed) };
    }
    const ready = await deps.ready(Number(/--port\s+(\d+)/u.exec(unit)?.[1]) || null);
    return { switched: true, ready, detail: tail(installed) };
  };
  const abandon = async (why: string) => {
    log(`stopped before changing the Gateway: ${why}. The next \`openclaw update\` tries again.`);
    if (fs.existsSync(path.dirname(plan.release))) {
      removeTree(path.dirname(plan.release));
      await git(run, plan.checkout, "worktree", "prune");
    }
    return false;
  };
  let runId: string | undefined;
  const fail = async (reason: string, detail: string, nextAction: string) => {
    log(`${detail} Next step: ${nextAction}`);
    await deps.record({ plan, runId, status: "failed", reason, detail, nextAction });
    return false;
  };

  const servesRelease = () => fs.readFileSync(plan.serviceFile, "utf8").includes(plan.release);
  const restarts = await deps.restarts(plan.unit);
  const restarted = restarts > 0;
  if (restarts > MAX_RESTARTS) {
    return servesRelease() || deps.migrated()
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
  // Killed after the final switch: only the finishing step is left.
  const unitPort = () =>
    Number(/--port\s+(\d+)/u.exec(fs.readFileSync(plan.serviceFile, "utf8"))?.[1]) || null;
  if (
    !servesRelease() &&
    buildCommit(plan.checkout) === plan.target &&
    deps.migrated() &&
    (await deps.ready(unitPort()))
  ) {
    runId = (await deps.hold(plan)) ?? undefined;
    await deps.finish(plan, { downtimeMs: 0, ...(runId ? { runId } : {}) });
    return !fs.existsSync(plan.release);
  }
  let downtimeMs = 0;
  const switched = async (root: string) => {
    const started = deps.now();
    const result = await serve(root);
    downtimeMs += deps.now() - started;
    return result;
  };
  // A resumed run finds the service already on the release and continues from the build.
  if (!servesRelease()) {
    log("restarting the Gateway on the new release; it migrates state at startup");
    const served = await switched(plan.release);
    if (!served.switched) {
      return abandon(
        `the Gateway service could not be moved to the new release (${served.detail})`,
      );
    }
    // Never put the previous build back: the release may have started migrating state.
    if (!served.ready) {
      return fail(
        "early-release-recovery-start-failed",
        "The Gateway service now starts the new release, which did not report ready.",
        `from the checkout, run \`${REBUILD} && openclaw gateway install --force\``,
      );
    }
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
  if (restarted && ownerStarted >= plan.plannedAt && !processStart(Number(owner?.pid))) {
    log(
      `releasing the build lock left by this recovery's interrupted build (PID ${String(owner?.pid)})`,
    );
    fs.rmSync(buildLock, { recursive: true, force: true });
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
  if (!final.ready) {
    const back = await serve(plan.release);
    return fail(
      "early-release-recovery-switch-failed",
      `The rebuilt checkout did not become ready (${final.detail}); the Gateway ${back.ready ? "serves the new release again" : "could not be put back on the new release"}.`,
      `see \`journalctl --user -u ${plan.unit}\`, then from the checkout run \`${REBUILD} && openclaw gateway install --force\``,
    );
  }
  const finished = await deps.finish(plan, { downtimeMs, runId });
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
    ...(facts.runId ? { runId: facts.runId } : {}),
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
  const [{ finishUpdateRunAsync, recordUpdateRunStepAsync }, store] = await Promise.all([
    import("./update-run-write.async.js"),
    import("../update/store.js"),
  ]);
  const runId = outcome.runId ?? (await openRun(outcome.plan));
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
    if ((await store.readUpdateLock())?.runId === runId) {
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
async function holdUpdateLock(plan: RecoveryPlan): Promise<string | null> {
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

/** `update-migrated-finalize.worker --early-release-recovery <plan> [finish <facts>]`. */
export function readEarlyGitReleaseRecoveryArgs(argv: readonly string[]) {
  // SAFETY: the plan is written by this same build (`--check` or the runner).
  const plan = JSON.parse(argv[0] ?? "") as RecoveryPlan;
  const facts = safeParseJsonRecord(argv[2] ?? "");
  return {
    plan,
    finish: argv[1] === "finish" ? { downtimeMs: Number(facts?.downtimeMs) || 0 } : null,
  };
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
    // The same loopback probe `openclaw gateway start` waits on, including TLS pinning.
    ready: async (port) => {
      if (!port) {
        return false;
      }
      const [{ readSourceConfigBestEffort }, { waitForGatewayHttpReadiness }] = await Promise.all([
        import("../config/io.runtime.js"),
        import("../cli/daemon-cli/restart-health-probe.js"),
      ]);
      const readiness = await waitForGatewayHttpReadiness({
        config: await readSourceConfigBestEffort().catch(() => ({})),
        port,
        attempts: READY_TIMEOUT_MS / 1000,
        deadlineAt: performance.now() + READY_TIMEOUT_MS,
        delayMs: 1000,
      });
      return readiness.readyz === 200;
    },
    record,
    hold: holdUpdateLock,
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
  };
}
