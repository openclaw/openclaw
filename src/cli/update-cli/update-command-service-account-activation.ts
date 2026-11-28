import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseKeyValueOutput } from "../../daemon/runtime-parse.js";
import { resolveServiceEntrypointIndex } from "../../daemon/service-layout.js";
import type { SystemdServiceIdentity } from "../../daemon/service-types.js";
import { isSystemdControlGroupEmpty } from "../../daemon/systemd-cgroup.js";
import { execSystemctl } from "../../daemon/systemd-exec.js";
import { startSystemdService, stopSystemdService } from "../../daemon/systemd-lifecycle.js";
import { captureSystemdServiceIdentity } from "../../daemon/systemd-service-identity.js";
import { hasErrnoCode } from "../../infra/errno.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { readPackageVersion } from "../../infra/package-json.js";
import { readBuiltGatewayBuildId } from "../../infra/update-git-runtime.js";
import { hasCommandProcessCleanupError } from "../../process/exec-result.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import { inspectSystemServiceAccountForAdmission } from "./update-command-admit-service-account.js";
import {
  createServiceAccountHandoff,
  runReleaseAsServiceAccount,
  SERVICE_ACCOUNT_ENV_LOADER,
  SERVICE_ACCOUNT_LAUNCH_PATH,
  type ServiceAccountExecution,
  type ServiceAccountHandoff,
} from "./update-command-service-account-run.js";

/** What the root updater did for a system unit that runs this installation as another account. */
export type ServiceAccountActivation =
  | {
      status: "updated";
      unitName: string;
      account: string;
      notServingMs: number;
      /** Transient unit that records the run and retires the backup once the updater exits. */
      settleUnit: string;
    }
  | {
      status: "failed";
      unitName: string;
      account: string;
      /** True only when the account's own restore reported the backed-up state restored. */
      stateRestored: boolean;
      message: string;
    };

type Options = {
  root: string;
  candidateVersion: string;
  /** The installed updater's remaining Doctor budget, when it set one. */
  remainingMs?: () => number | undefined;
  warn: (message: string) => void;
};

const DEFAULT_MIGRATE_TIMEOUT_MS = 60 * 60_000;
const DEFAULT_READY_TIMEOUT_MS = 10 * 60_000;
/** systemd restarts of the started candidate that mean it will not come ready. */
const CRASH_LOOP_RESTARTS = 5;
const STOP_TIMEOUT_MS = 90_000;
const ACCOUNT_RESULT_MAX_BYTES = 256 * 1024;

/**
 * Runs in a transient root unit after the installed updater exits, because only then is the
 * package final: that updater may still restore the previous one. Its input is one JSON
 * argument of root-derived values; the account's environment stays in its handoff file.
 *
 * - "settle" (the unit served the candidate): candidate still installed, so the account's
 *   `update finish` records the run and retires the backup; previous package back, so stop
 *   the unit, run that package's `update restore` as the account, then start the unit.
 * - "start" (state already restored): start the unit once the previous package is back.
 */
const SETTLE_SCRIPT = `
const p = JSON.parse(process.argv[1]);
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const log = (message) => console.log(message);
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
// A PID is the same process only with the same start time; PIDs are reused.
const startedAt = (pid) => { try { const stat = fs.readFileSync("/proc/" + pid + "/stat", "utf8"); return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]; } catch { return undefined; } };
// The Doctor child and the account work it started (runuser and the account's loader carry
// this handoff's env file in their argv) can outlive the updater; nothing settles before they end.
const accountWorkRunning = () => {
  if (startedAt(p.doctorPid) === p.doctorStartedAt) return true;
  let pids = [];
  try { pids = fs.readdirSync("/proc").filter((name) => /^[0-9]+$/.test(name) && Number(name) !== process.pid); } catch { return true; }
  return pids.some((pid) => { try { return fs.readFileSync("/proc/" + pid + "/cmdline", "utf8").split("\\0").includes(p.envFile); } catch { return false; } });
};
const systemctl = (...args) => spawnSync("/usr/bin/systemctl", args, { stdio: "inherit" }).status === 0;
const show = (property) => String(spawnSync("/usr/bin/systemctl", ["show", "-p", property, "--value", p.unit], { encoding: "utf8" }).stdout || "").trim();
// The account's answer is untrusted: success needs exit 0 and the expected status word in
// the final JSON object of bounded output (Doctor output comes first).
const asAccount = (expected, ...args) => {
  const run = spawnSync(p.runuser, ["-u", p.account, "--", process.execPath, "-e", p.loader, p.envFile, p.root + "/dist/index.js", ...args], { env: { PATH: p.path }, cwd: "/", stdio: ["ignore", "pipe", "inherit"], encoding: "utf8", maxBuffer: 256 * 1024, timeout: 60 * 60000 });
  if (run.status !== 0 || run.error || typeof run.stdout !== "string") return false;
  if (expected === undefined) return true;
  const text = run.stdout;
  const at = text.startsWith("{") ? 0 : text.lastIndexOf("\\n{") + 1;
  if (at <= 0 && !text.startsWith("{")) return false;
  try { return JSON.parse(text.slice(at)).status === expected; } catch { return false; }
};
// Stopped means inactive with no populated cgroup; KillMode= can leave processes behind.
// Same rule as isSystemdControlGroupEmpty: a missing group is empty only in a hierarchy
// systemd tracks units in (unified, hybrid unified/, or legacy systemd/).
const fsType = (dir) => { try { return fs.statfsSync(dir).type; } catch { return 0; } };
const procsBelow = (dir) => {
  try {
    if (fs.readFileSync(dir + "/cgroup.procs", "utf8").trim()) return true;
    return fs.readdirSync(dir, { withFileTypes: true }).some((e) => e.isDirectory() && procsBelow(dir + "/" + e.name));
  } catch (error) { if (error && error.code === "ENOENT") return false; throw error; }
};
const emptyCgroup = (cg) => {
  if (!cg) return true;
  if (!cg.startsWith("/") || cg.split("/").slice(1).some((part) => !part || part === "." || part === "..")) return false;
  try {
    const unified = ["/sys/fs/cgroup", "/sys/fs/cgroup/unified"].find((dir) => fsType(dir) === 0x63677270);
    if (unified) {
      try { return /^populated 0$/m.test(fs.readFileSync(unified + cg + "/cgroup.events", "utf8")); }
      catch (error) { return Boolean(error && error.code === "ENOENT"); }
    }
    return fsType("/sys/fs/cgroup/systemd") === 0x27e0eb && !procsBelow("/sys/fs/cgroup/systemd" + cg);
  } catch { return false; }
};
const stopped = () => ["inactive", "failed"].includes(show("ActiveState")) && emptyCgroup(show("ControlGroup")) && emptyCgroup(p.controlGroup);
const deadline = Date.now() + 2 * 60 * 60000;
const settle = () => {
  let version;
  let buildId = null;
  try { version = JSON.parse(fs.readFileSync(p.root + "/package.json", "utf8")).version; } catch {}
  try { buildId = JSON.parse(fs.readFileSync(p.root + "/dist/build-info.json", "utf8")).buildId ?? null; } catch {}
  // A same-version replacement differs in its build; either difference is the previous package.
  const rolledBack = typeof version === "string" && (version !== p.candidateVersion || buildId !== p.candidateBuildId);
  if (p.mode === "start") {
    if (rolledBack) { log("previous package " + version + " restored; starting " + p.unit); systemctl("start", p.unit); }
    else log("package is " + version + "; " + p.unit + " stays stopped");
    return;
  }
  if (!rolledBack) {
    // Retire the backup only for a verified activation: root's marker from the Doctor child, or
    // the unit serving now with the account's own client reaching it.
    const verified = fs.existsSync(p.handoffDir + "/verified") || (show("ActiveState") === "active" && asAccount(undefined, ...p.health));
    if (verified) {
      log("update kept; recording it as " + p.account);
      if (!asAccount("finished", "update", "finish", "--backup-root", p.backupRoot)) log("update finish did not confirm; the backup is kept; retry update finish as " + p.account);
      return;
    }
    log("the update was not verified; restoring " + p.account + "'s state and leaving " + p.unit + " stopped");
    systemctl("stop", p.unit);
    for (let i = 0; i < 90 && !stopped(); i++) spawnSync("/bin/sleep", ["1"]);
    if (!stopped() || !asAccount("restored", "update", "restore", "--backup-root", p.backupRoot)) log("restore did not confirm; backup kept at " + p.backupRoot);
    return;
  }
  log("the installed updater restored " + version + "; restoring " + p.account + "'s state");
  systemctl("stop", p.unit);
  for (let i = 0; i < 90 && !stopped(); i++) spawnSync("/bin/sleep", ["1"]);
  if (!stopped()) { log(p.unit + " did not stop; state not restored, backup kept at " + p.backupRoot); return; }
  // No receipt means the migration never backed anything up, so the state was never changed.
  const untouched = () => { try { fs.lstatSync(p.backupRoot + ".receipt.json"); return false; } catch (error) { return Boolean(error && error.code === "ENOENT"); } };
  if (asAccount("restored", "update", "restore", "--backup-root", p.backupRoot) || untouched()) systemctl("start", p.unit);
  else log("restore did not confirm; " + p.unit + " left stopped, backup kept at " + p.backupRoot);
};
// Root's marker that an account run's processes could not be confirmed gone; one of them may
// still write the state, so this step changes nothing and leaves the backup to the operator.
const uncertain = () => fs.existsSync(p.handoffDir + "/uncertain");
const tick = () => {
  if (uncertain()) {
    log("the update steps run as " + p.account + " could not be confirmed stopped; nothing settled, " + p.unit + " left as it is, backup kept at " + p.backupRoot);
    fs.rmSync(p.handoffDir, { recursive: true, force: true });
    return;
  }
  if (alive(p.driverPid) || accountWorkRunning()) {
    if (Date.now() < deadline) { setTimeout(tick, 1000); return; }
    // The package is not final while the updater runs; keep the backup for the operator.
    log("the installed updater or its account work is still running; nothing settled, backup kept at " + p.backupRoot);
    fs.rmSync(p.handoffDir, { recursive: true, force: true });
    return;
  }
  try { settle(); } finally { fs.rmSync(p.handoffDir, { recursive: true, force: true }); }
};
tick();
`;

/** Field 22 of /proc/<pid>/stat, the process start time; it pairs with the PID. */
async function readProcessStartedAt(pid: number): Promise<string | null> {
  try {
    const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] ?? null;
  } catch {
    return null;
  }
}

/** The account's own client, aimed at the port the unit's ExecStart chose. */
function healthArgs(execution: ServiceAccountExecution): string[] {
  return [
    "gateway",
    "health",
    "--json",
    ...(execution.port === undefined ? [] : ["--port", String(execution.port)]),
  ];
}

async function scheduleSettle(
  mode: "settle" | "start",
  execution: ServiceAccountExecution,
  handoff: ServiceAccountHandoff,
  params: { root: string; candidateVersion: string; backupRoot: string; controlGroup: string },
): Promise<string | undefined> {
  const unit = `openclaw-update-settle-${randomUUID()}.service`;
  const payload = {
    mode,
    // The installed updater that started this Doctor child; it restores the package, if at all.
    driverPid: process.ppid,
    // This Doctor child, which may outlive that updater while its account work runs.
    doctorPid: process.pid,
    doctorStartedAt: await readProcessStartedAt(process.pid),
    // The installation path as the unit uses it, not its target: a release-slot install
    // selects the previous release by moving this link.
    root: params.root,
    candidateVersion: params.candidateVersion,
    candidateBuildId: await readBuiltGatewayBuildId(params.root),
    unit: execution.unitName,
    runuser: execution.runuser,
    account: execution.account,
    envFile: handoff.envFile,
    handoffDir: handoff.directory,
    backupRoot: params.backupRoot,
    controlGroup: params.controlGroup,
    health: healthArgs(execution),
    loader: SERVICE_ACCOUNT_ENV_LOADER,
    path: SERVICE_ACCOUNT_LAUNCH_PATH,
  };
  const result = await runCommandWithTimeout(
    [
      "/usr/bin/systemd-run",
      "--quiet",
      "--collect",
      "--service-type=exec",
      `--unit=${unit}`,
      `--description=Settle the OpenClaw update of ${execution.unitName}`,
      "--",
      process.execPath,
      "-e",
      SETTLE_SCRIPT,
      JSON.stringify(payload),
    ],
    { timeoutMs: 30_000 },
  ).catch(() => null);
  return result?.code === 0 ? unit : undefined;
}

/**
 * The account's result is untrusted: the command prints Doctor output first and its result
 * last, as an indented JSON object. Only that final object is parsed, from bounded output,
 * and only a short status word is read from it.
 */
function readAccountStatus(stdout: Buffer): string | undefined {
  const text = stdout.toString("utf8");
  const at = text.startsWith("{") ? 0 : text.lastIndexOf("\n{") + 1;
  if (at <= 0 && !text.startsWith("{")) {
    return undefined;
  }
  try {
    const value: unknown = JSON.parse(text.slice(at));
    const status =
      value && typeof value === "object" && "status" in value ? value.status : undefined;
    return typeof status === "string" && /^[a-z-]{1,32}$/u.test(status) ? status : undefined;
  } catch {
    return undefined;
  }
}

async function readUnit(unitName: string) {
  const result = await execSystemctl(
    ["--system", "show", unitName, "--property=ActiveState,MainPID,ControlGroup,NRestarts"],
    undefined,
    5_000,
  );
  const properties = parseKeyValueOutput(result.stdout, "=");
  return {
    ok: result.code === 0,
    active: properties.activestate ?? "",
    pid: Number(properties.mainpid ?? 0),
    controlGroup: properties.controlgroup ?? "",
    restarts: Number(properties.nrestarts ?? 0),
  };
}

async function waitForUnit(
  unitName: string,
  done: (unit: Awaited<ReturnType<typeof readUnit>>) => boolean | Promise<boolean>,
  timeoutMs: number,
  giveUp?: (unit: Awaited<ReturnType<typeof readUnit>>) => boolean,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const unit = await readUnit(unitName);
    if (unit.ok && (await done(unit))) {
      return true;
    }
    if (unit.ok && giveUp?.(unit)) {
      return false;
    }
    await delay(500);
  }
  return false;
}

/**
 * The serving process is the expected build when systemd's main process runs an entry inside
 * this installation and the root-owned package there is the candidate. Root derives both
 * from /proc, the unit's ExecStart it read itself and its own package; nothing the account
 * wrote decides it.
 */
async function servesCandidate(
  pid: number,
  root: string,
  candidateVersion: string,
  execution: ServiceAccountExecution,
) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    const argv = (await fs.readFile(`/proc/${pid}/cmdline`, "utf8")).split("\0").filter(Boolean);
    const realRoot = await fs.realpath(root);
    // Runtime options such as --max-old-space-size come before the entry script. A Gateway
    // started with --token or --password retitles itself, which overwrites its argv; the
    // main process of the unit root just started then runs the unit's own ExecStart.
    const retitled = argv.length === 1 && !argv[0]?.includes(path.sep);
    const command = retitled ? execution.programArguments : argv;
    const index = resolveServiceEntrypointIndex(command);
    const script = index === undefined ? undefined : command[index];
    const entry = script ? await fs.realpath(script).catch(() => "") : "";
    return (
      entry.startsWith(realRoot + path.sep) &&
      (await readPackageVersion(realRoot, { maxBytes: 1024 * 1024 })) === candidateVersion
    );
  } catch {
    return false;
  }
}

/**
 * Root owns the package and the unit; the unit's account owns its state. With the unit
 * stopped, the account's own `update migrate` backs up and migrates the state; root starts
 * the unit and verifies it serves the candidate. Once the installed updater exits, a
 * transient root unit records the run as the account, or restores the state if that updater
 * restored the previous package. A failure here restores the state as the account, only
 * after the unit is confirmed stopped, and never starts the candidate on restored state.
 */
async function activateSystemServiceAsAccount(
  execution: ServiceAccountExecution,
  options: Options,
): Promise<ServiceAccountActivation> {
  const { unitName, account } = execution;
  const failed = (stateRestored: boolean, message: string): ServiceAccountActivation => ({
    status: "failed",
    unitName,
    account,
    stateRestored,
    message,
  });
  let identity: SystemdServiceIdentity;
  try {
    identity = await captureSystemdServiceIdentity({
      env: { OPENCLAW_SYSTEMD_UNIT: unitName },
      target: { scope: "system", unitName, unitPath: execution.unitPath },
      rootServiceAccount: account,
    });
  } catch (error) {
    return failed(
      false,
      `${unitName} could not be inspected as ${account}'s service (${formatErrorMessage(error)}); it was not stopped.`,
    );
  }
  const handoff = await createServiceAccountHandoff(execution);
  let handoffOwned = true;
  try {
    const backupRoot = path.join(
      execution.home,
      ".openclaw-update",
      `system-service-${randomUUID()}`,
      "native",
    );
    const budget = (fallback: number) => Math.max(1_000, options.remainingMs?.() ?? fallback);
    // Set once an account run's processes could not be confirmed gone; that work may still
    // write the state, so nothing restores or starts until the settle step sees it end.
    // The settle step reads root's marker and settles nothing while it is there.
    let accountWorkUncertain = false;
    const markUncertain = async (uncertain: boolean) => {
      if (uncertain && !accountWorkUncertain) {
        accountWorkUncertain = true;
        await fs.writeFile(path.join(handoff.directory, "uncertain"), "", { mode: 0o600 });
      }
    };
    const asAccount = async (args: string[], timeoutMs: number) => {
      try {
        const result = await runReleaseAsServiceAccount(execution, handoff, {
          root: options.root,
          args,
          timeoutMs,
          maxStdoutBytes: ACCOUNT_RESULT_MAX_BYTES,
        });
        await markUncertain(hasCommandProcessCleanupError(result.error));
        return result;
      } catch (error) {
        await markUncertain(hasCommandProcessCleanupError(error));
        return null;
      }
    };
    const control = async (action: "start" | "stop") => {
      const args = { stdout: process.stderr, systemdIdentity: identity, warn: options.warn };
      await (action === "start" ? startSystemdService(args) : stopSystemdService(args));
    };
    // Restoring is only safe with no Gateway writing: systemd must report the unit stopped and
    // its cgroup empty, since KillMode= can leave processes behind. The cgroup is the one the
    // running unit had; without it a stop is not confirmed and the backup is kept.
    let controlGroup = "";
    const stopConfirmed = async () => {
      const running = await readUnit(unitName);
      if (running.ok && running.controlGroup) {
        controlGroup = running.controlGroup;
      }
      await control("stop").catch((error: unknown) => {
        options.warn(`${unitName} stop request failed: ${formatErrorMessage(error)}`);
      });
      return await waitForUnit(
        unitName,
        (unit) => {
          if (unit.active !== "inactive" && unit.active !== "failed") {
            return false;
          }
          // systemd keeps a unit's cgroup while any process remains in it; an inactive unit
          // with no cgroup has none. The cgroup it had while running must be empty too.
          try {
            return [unit.controlGroup, controlGroup].every(
              (group) => !group || isSystemdControlGroupEmpty(group),
            );
          } catch {
            return false;
          }
        },
        STOP_TIMEOUT_MS,
      );
    };
    const backupKept = `the update backup is kept under ${path.dirname(backupRoot)}`;
    const stoppedAt = Date.now();
    if (!(await stopConfirmed())) {
      // Never start the new package next to processes that may still write the state. Once
      // the installed updater restores the previous package, the settle step starts it.
      const startUnit = await scheduleSettle("start", execution, handoff, {
        root: options.root,
        candidateVersion: options.candidateVersion,
        backupRoot,
        controlGroup,
      });
      handoffOwned = startUnit === undefined;
      return failed(
        false,
        `${unitName} did not stop cleanly; nothing was migrated.${startUnit ? ` It starts again once the previous package is restored (${startUnit}).` : ` Start it with sudo systemctl start ${unitName} once the previous package is restored.`}`,
      );
    }
    // Armed before migration: whatever happens to this process afterwards, including the
    // installed updater's deadline ending it, the settle step reconciles once that updater exits.
    const settleUnit = await scheduleSettle("settle", execution, handoff, {
      root: options.root,
      candidateVersion: options.candidateVersion,
      backupRoot,
      controlGroup,
    });
    if (!settleUnit) {
      // Without it nothing could restore the state if the installed updater later put the
      // previous package back, so nothing is migrated.
      return failed(
        false,
        `The step that settles this update could not be scheduled, so nothing was migrated; ${unitName} is stopped. Start it with sudo systemctl start ${unitName} once the previous package is restored.`,
      );
    }
    handoffOwned = false;
    const awaitingAccountWork = (problem: string) =>
      failed(
        false,
        `${problem} ${account}'s update steps could not be confirmed stopped, so nothing more was changed and nothing will be settled automatically; ${unitName} stays stopped and ${backupKept}. Once no process of ${account}'s update remains and the previous package is back, run openclaw update restore --backup-root ${backupRoot} as ${account} with ${unitName}'s environment, then start ${unitName} (https://docs.openclaw.ai/install/updating#linux-system-service-run-by-another-account).`,
      );
    const restore = async (problem: string): Promise<ServiceAccountActivation> => {
      const resumes = `${unitName} starts again once the previous package is restored (${settleUnit}).`;
      if (accountWorkUncertain) {
        return awaitingAccountWork(problem);
      }
      if (!(await stopConfirmed())) {
        return failed(
          false,
          `${problem} ${unitName} could not be confirmed stopped, so ${account}'s state was not restored; ${backupKept}.`,
        );
      }
      const restored = await asAccount(
        ["update", "restore", "--backup-root", backupRoot],
        DEFAULT_MIGRATE_TIMEOUT_MS,
      );
      if (accountWorkUncertain) {
        return awaitingAccountWork(problem);
      }
      // No receipt means the migration never backed anything up, so the state was never changed.
      const untouched = await fs
        .lstat(`${backupRoot}.receipt.json`)
        .then(() => false)
        .catch((error: unknown) => hasErrnoCode(error, "ENOENT"));
      if (untouched) {
        return failed(true, `${problem} ${account}'s state was not changed; ${resumes}`);
      }
      if (
        restored?.termination !== "exit" ||
        restored.code !== 0 ||
        readAccountStatus(restored.stdout) !== "restored"
      ) {
        return failed(
          false,
          `${problem} ${account}'s state could not be restored here; ${backupKept}, and ${settleUnit} retries the restore once the previous package is back.`,
        );
      }
      return failed(
        true,
        `${problem} ${account}'s state was restored from the update backup; ${resumes}`,
      );
    };
    const migrated = await asAccount(
      ["update", "migrate", "--backup-root", backupRoot],
      budget(DEFAULT_MIGRATE_TIMEOUT_MS),
    );
    if (
      migrated?.termination !== "exit" ||
      migrated.code !== 0 ||
      readAccountStatus(migrated.stdout) !== "migrated"
    ) {
      return await restore(`Migrating ${account}'s state as ${account} did not complete.`);
    }
    if (accountWorkUncertain) {
      return awaitingAccountWork(`Migrating ${account}'s state finished, but`);
    }
    try {
      await control("start");
    } catch (error) {
      return await restore(`${unitName} could not be started (${formatErrorMessage(error)}).`);
    }
    let restartsSinceStart = Number.POSITIVE_INFINITY;
    // Ready means systemd runs the candidate and the account's own client reaches that Gateway
    // with the unit's config and credentials; root reads only the exit status.
    const ready = await waitForUnit(
      unitName,
      async (unit) =>
        unit.active === "active" &&
        (await servesCandidate(unit.pid, options.root, options.candidateVersion, execution)) &&
        (await asAccount(healthArgs(execution), 20_000).then(
          (health) => health?.termination === "exit" && health.code === 0,
        )),
      Math.min(DEFAULT_READY_TIMEOUT_MS, budget(DEFAULT_READY_TIMEOUT_MS)),
      // A candidate that keeps exiting under Restart= will not come ready; restore now rather
      // than leave the service down for the whole readiness window.
      // Starting resets the counter (reset-failed), so count from the lowest value seen since.
      (unit) => {
        if (!Number.isSafeInteger(unit.restarts)) {
          return false;
        }
        restartsSinceStart = Math.min(restartsSinceStart, unit.restarts);
        return unit.restarts - restartsSinceStart >= CRASH_LOOP_RESTARTS;
      },
    );
    if (!ready) {
      return await restore(`${unitName} did not come ready on ${options.candidateVersion}.`);
    }
    // Root's own record that this activation was verified; the account cannot write here.
    await fs.writeFile(path.join(handoff.directory, "verified"), "", { mode: 0o600, flag: "wx" });
    return {
      status: "updated",
      unitName,
      account,
      notServingMs: Date.now() - stoppedAt,
      settleUnit,
    };
  } finally {
    if (handoffOwned) {
      await handoff.remove();
    }
  }
}

/**
 * Post-activation entry for the root updater: when the selected system unit runs this
 * installation as another account, run that unit's state steps as the account.
 */
export async function updateSystemServiceAsAccount(params: {
  root: string;
  remainingMs?: () => number | undefined;
  warn: (message: string) => void;
}): Promise<ServiceAccountActivation | undefined> {
  const candidateVersion = await readPackageVersion(params.root, { maxBytes: 1024 * 1024 });
  if (!candidateVersion) {
    return undefined;
  }
  const plan = await inspectSystemServiceAccountForAdmission({
    env: process.env,
    root: params.root,
    packageManager: "npm",
    candidateVersion,
  });
  if (!plan) {
    return undefined;
  }
  if (plan.kind === "refuse") {
    // Admission decides before activation; a changed observation must not proceed as root.
    throw new Error(`${plan.message} ${plan.nextAction}`);
  }
  return await activateSystemServiceAsAccount(plan, {
    root: params.root,
    candidateVersion,
    remainingMs: params.remainingMs,
    warn: params.warn,
  });
}
