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
import { formatErrorMessage } from "../../infra/errors.js";
import { readPackageVersion } from "../../infra/package-json.js";
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
const systemctl = (...args) => spawnSync("/usr/bin/systemctl", args, { stdio: "inherit" }).status === 0;
const active = () => spawnSync("/usr/bin/systemctl", ["show", "-p", "ActiveState", "--value", p.unit], { encoding: "utf8" }).stdout.trim();
// The account's answer is untrusted: success needs exit 0 and the expected status word on
// the last line of bounded output.
const asAccount = (expected, ...args) => {
  const run = spawnSync(p.runuser, ["-u", p.account, "--", process.execPath, "-e", p.loader, p.envFile, p.root + "/dist/index.js", ...args], { env: { PATH: p.path }, cwd: "/", stdio: ["ignore", "pipe", "inherit"], encoding: "utf8", maxBuffer: 256 * 1024, timeout: 60 * 60000 });
  if (run.status !== 0 || run.error) return false;
  try { return JSON.parse(run.stdout.trim().split("\\n").at(-1)).status === expected; } catch { return false; }
};
const deadline = Date.now() + 2 * 60 * 60000;
const settle = () => {
  let version;
  try { version = JSON.parse(fs.readFileSync(p.root + "/package.json", "utf8")).version; } catch {}
  const rolledBack = typeof version === "string" && version !== p.candidateVersion;
  if (p.mode === "start") {
    if (rolledBack) { log("previous package " + version + " restored; starting " + p.unit); systemctl("start", p.unit); }
    else log("package is " + version + "; " + p.unit + " stays stopped");
    return;
  }
  if (!rolledBack) {
    log("update kept; recording it as " + p.account);
    if (!asAccount("finished", "update", "finish", "--backup-root", p.backupRoot)) log("update finish did not confirm; the backup is kept; retry update finish as " + p.account);
    return;
  }
  log("the installed updater restored " + version + "; restoring " + p.account + "'s state");
  systemctl("stop", p.unit);
  // Stopped means inactive with an empty cgroup; KillMode= can leave processes behind.
  const emptyCgroup = () => {
    const cg = p.controlGroup;
    if (typeof cg !== "string" || !cg.startsWith("/") || cg.split("/").slice(1).some((part) => !part || part === "." || part === "..")) return false;
    try { return /^populated 0$/m.test(fs.readFileSync("/sys/fs/cgroup" + p.controlGroup + "/cgroup.events", "utf8")); }
    catch (error) { return error && error.code === "ENOENT"; }
  };
  const stopped = () => ["inactive", "failed"].includes(active()) && emptyCgroup();
  for (let i = 0; i < 90 && !stopped(); i++) spawnSync("/bin/sleep", ["1"]);
  if (!stopped()) { log(p.unit + " did not stop; state not restored, backup kept at " + p.backupRoot); return; }
  if (asAccount("restored", "update", "restore", "--backup-root", p.backupRoot)) systemctl("start", p.unit);
  else log("restore did not confirm; " + p.unit + " left stopped, backup kept at " + p.backupRoot);
};
const tick = () => {
  if (alive(p.driverPid)) {
    if (Date.now() < deadline) { setTimeout(tick, 1000); return; }
    // The package is not final while the updater runs; keep the backup for the operator.
    log("the installed updater is still running; nothing settled, backup kept at " + p.backupRoot);
    fs.rmSync(p.handoffDir, { recursive: true, force: true });
    return;
  }
  try { settle(); } finally { fs.rmSync(p.handoffDir, { recursive: true, force: true }); }
};
tick();
`;

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
    root: await fs.realpath(params.root),
    candidateVersion: params.candidateVersion,
    unit: execution.unitName,
    runuser: execution.runuser,
    account: execution.account,
    envFile: handoff.envFile,
    handoffDir: handoff.directory,
    backupRoot: params.backupRoot,
    controlGroup: params.controlGroup,
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
    ["--system", "show", unitName, "--property=ActiveState,MainPID,ControlGroup"],
    undefined,
    5_000,
  );
  const properties = parseKeyValueOutput(result.stdout, "=");
  return {
    ok: result.code === 0,
    active: properties.activestate ?? "",
    pid: Number(properties.mainpid ?? 0),
    controlGroup: properties.controlgroup ?? "",
  };
}

async function waitForUnit(
  unitName: string,
  done: (unit: Awaited<ReturnType<typeof readUnit>>) => boolean | Promise<boolean>,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const unit = await readUnit(unitName);
    if (unit.ok && (await done(unit))) {
      return true;
    }
    await delay(500);
  }
  return false;
}

/**
 * The serving process is the expected build when systemd's main process runs an entry inside
 * this installation and the root-owned package there is the candidate. Root derives both
 * from /proc and its own package; nothing the account wrote decides it.
 */
async function servesCandidate(pid: number, root: string, candidateVersion: string) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    const argv = (await fs.readFile(`/proc/${pid}/cmdline`, "utf8")).split("\0").filter(Boolean);
    const realRoot = await fs.realpath(root);
    // Runtime options such as --max-old-space-size come before the entry script.
    const index = resolveServiceEntrypointIndex(argv);
    const script = index === undefined ? undefined : argv[index];
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
    const asAccount = (args: string[], timeoutMs: number) =>
      runReleaseAsServiceAccount(execution, handoff, {
        root: options.root,
        args,
        timeoutMs,
        maxStdoutBytes: ACCOUNT_RESULT_MAX_BYTES,
      }).catch(() => null);
    const control = async (action: "start" | "stop") => {
      const args = { stdout: process.stderr, systemdIdentity: identity, warn: options.warn };
      await (action === "start" ? startSystemdService(args) : stopSystemdService(args));
    };
    // Restoring is only safe with no Gateway writing; an unproven stop keeps the backup.
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
          try {
            return Boolean(controlGroup) && isSystemdControlGroupEmpty(controlGroup);
          } catch {
            return false;
          }
        },
        STOP_TIMEOUT_MS,
      );
    };
    const backupKept = `the update backup is kept under ${path.dirname(backupRoot)}`;
    const restore = async (problem: string): Promise<ServiceAccountActivation> => {
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
      if (
        restored?.termination !== "exit" ||
        restored.code !== 0 ||
        readAccountStatus(restored.stdout) !== "restored"
      ) {
        return failed(
          false,
          `${problem} ${account}'s state could not be restored automatically; ${unitName} was left stopped and ${backupKept}.`,
        );
      }
      const settleUnit = await scheduleSettle("start", execution, handoff, {
        root: options.root,
        candidateVersion: options.candidateVersion,
        backupRoot,
        controlGroup,
      });
      handoffOwned = settleUnit === undefined;
      return failed(
        true,
        settleUnit
          ? `${problem} ${account}'s state was restored from the update backup; ${unitName} starts again once the previous package is restored (${settleUnit}).`
          : `${problem} ${account}'s state was restored from the update backup; ${unitName} is stopped. Start it with sudo systemctl start ${unitName} once the previous package is restored.`,
      );
    };
    const stoppedAt = Date.now();
    if (!(await stopConfirmed())) {
      // Nothing was migrated; give the previous Gateway back.
      await control("start").catch(() => {});
      return failed(false, `${unitName} did not stop; nothing was migrated.`);
    }
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
    try {
      await control("start");
    } catch (error) {
      return await restore(`${unitName} could not be started (${formatErrorMessage(error)}).`);
    }
    // Ready means systemd runs the candidate and the account's own client reaches that Gateway
    // with the unit's config and credentials; root reads only the exit status.
    const ready = await waitForUnit(
      unitName,
      async (unit) =>
        unit.active === "active" &&
        (await servesCandidate(unit.pid, options.root, options.candidateVersion)) &&
        (await asAccount(["gateway", "health", "--json"], 20_000).then(
          (health) => health?.termination === "exit" && health.code === 0,
        )),
      Math.min(DEFAULT_READY_TIMEOUT_MS, budget(DEFAULT_READY_TIMEOUT_MS)),
    );
    if (!ready) {
      return await restore(`${unitName} did not come ready on ${options.candidateVersion}.`);
    }
    const notServingMs = Date.now() - stoppedAt;
    const settleUnit = await scheduleSettle("settle", execution, handoff, {
      root: options.root,
      candidateVersion: options.candidateVersion,
      backupRoot,
      controlGroup,
    });
    if (settleUnit) {
      handoffOwned = false;
      return { status: "updated", unitName, account, notServingMs, settleUnit };
    }
    // Without the settle unit nothing could restore the state if the installed updater later
    // put the previous package back, so do not keep the update.
    return await restore(
      `${unitName} served ${options.candidateVersion}, but the step that settles this update could not be scheduled.`,
    );
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
