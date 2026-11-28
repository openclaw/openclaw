import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseKeyValueOutput } from "../../daemon/runtime-parse.js";
import type { SystemdServiceIdentity } from "../../daemon/service-types.js";
import { execSystemctl } from "../../daemon/systemd-exec.js";
import { startSystemdService, stopSystemdService } from "../../daemon/systemd-lifecycle.js";
import { captureSystemdServiceIdentity } from "../../daemon/systemd-service-identity.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { readPackageVersion } from "../../infra/package-json.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import { inspectSystemServiceAccountForAdmission } from "./update-command-admit-service-account.js";
import {
  runReleaseAsServiceAccount,
  type ServiceAccountExecution,
} from "./update-command-service-account-run.js";

/** What the root updater did for a system unit that runs this installation as another account. */
export type ServiceAccountActivation =
  | {
      status: "updated";
      unitName: string;
      account: string;
      notServingMs: number;
      warnings: string[];
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
const ACCOUNT_RESULT_MAX_BYTES = 256 * 1024;

// Runs in a transient root unit after this updater exits. Its inputs are root-derived argv.
const START_AFTER_ROLLBACK_SCRIPT = `
const [driverPid, root, candidateVersion, unit] = process.argv.slice(1);
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const alive = (pid) => { try { process.kill(Number(pid), 0); return true; } catch { return false; } };
const deadline = Date.now() + 30 * 60_000;
const tick = () => {
  if (alive(driverPid)) {
    if (Date.now() < deadline) setTimeout(tick, 1000);
    return;
  }
  let version;
  try { version = JSON.parse(fs.readFileSync(root + "/package.json", "utf8")).version; } catch {}
  if (typeof version === "string" && version !== candidateVersion) {
    execFileSync("/usr/bin/systemctl", ["start", unit], { stdio: "inherit" });
  }
};
tick();
`;

/**
 * The installed updater puts the previous package back after this step fails, and only then
 * may the unit start again: the restored state belongs to that package. A transient root unit
 * waits for the updater to exit and starts the unit only if the package is no longer the
 * candidate. It never starts the candidate on restored state.
 */
async function scheduleStartAfterRollback(
  unitName: string,
  root: string,
  candidateVersion: string,
) {
  const result = await runCommandWithTimeout(
    [
      "/usr/bin/systemd-run",
      "--quiet",
      "--collect",
      "--service-type=exec",
      `--unit=openclaw-update-resume-${randomUUID()}`,
      `--description=Start ${unitName} after the previous OpenClaw package is restored`,
      "--",
      process.execPath,
      "-e",
      START_AFTER_ROLLBACK_SCRIPT,
      String(process.ppid),
      await fs.realpath(root),
      candidateVersion,
      unitName,
    ],
    { timeoutMs: 30_000 },
  ).catch(() => null);
  return result?.code === 0;
}

/** The account's JSON line is untrusted: only a bounded status word is read from it. */
function readAccountStatus(stdout: Buffer): string | undefined {
  const lines = stdout.toString("utf8").trim().split("\n");
  try {
    const value: unknown = JSON.parse(lines.at(-1) ?? "");
    const status =
      value && typeof value === "object" && "status" in value ? value.status : undefined;
    return typeof status === "string" && /^[a-z-]{1,32}$/u.test(status) ? status : undefined;
  } catch {
    return undefined;
  }
}

async function readUnit(unitName: string) {
  const result = await execSystemctl(
    [
      "--system",
      "show",
      unitName,
      "--property=ActiveState,SubState,MainPID,ExecMainStartTimestampMonotonic",
    ],
    undefined,
    5_000,
  );
  const properties = parseKeyValueOutput(result.stdout, "=");
  return {
    ok: result.code === 0,
    active: properties.activestate ?? "",
    pid: Number(properties.mainpid ?? 0),
    startedAt: properties.execmainstarttimestampmonotonic ?? "",
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
    const argv = (await fs.readFile(`/proc/${pid}/cmdline`, "utf8")).split("\0");
    const realRoot = await fs.realpath(root);
    const entry = argv[1] ? await fs.realpath(argv[1]).catch(() => "") : "";
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
 * the unit and verifies it serves the candidate; the account's `update finish` records the
 * run in its own state. Any failure after the backup restores the state as the account and
 * leaves the unit stopped so the installed updater can put the previous package back first.
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
  const backupRoot = path.join(
    execution.home,
    ".openclaw-update",
    `system-service-${randomUUID()}`,
    "native",
  );
  const asAccount = (command: "migrate" | "restore" | "finish", timeoutMs: number) =>
    runReleaseAsServiceAccount(execution, {
      root: options.root,
      args: ["update", command, "--backup-root", backupRoot],
      timeoutMs,
      maxStdoutBytes: ACCOUNT_RESULT_MAX_BYTES,
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
  const control = async (action: "start" | "stop") => {
    const args = { stdout: process.stderr, systemdIdentity: identity, warn: options.warn };
    await (action === "start" ? startSystemdService(args) : stopSystemdService(args));
  };
  const stoppedAt = Date.now();
  try {
    await control("stop");
  } catch (error) {
    return failed(false, `${unitName} could not be stopped (${formatErrorMessage(error)}).`);
  }
  const stopped = await waitForUnit(
    unitName,
    (unit) => unit.active === "inactive" || unit.active === "failed",
    60_000,
  );
  // Recovery order once the unit is down: the account restores its backup, then the unit stays
  // stopped; starting it now would run the new package on the restored state.
  const restore = async (problem: string) => {
    const restored = await asAccount("restore", DEFAULT_MIGRATE_TIMEOUT_MS).catch(() => null);
    const ok =
      restored?.termination === "exit" &&
      restored.code === 0 &&
      readAccountStatus(restored.stdout) === "restored";
    if (!ok) {
      return failed(
        false,
        `${problem} ${account}'s state could not be restored automatically; ${unitName} was left stopped and the update backup is kept under ${path.dirname(backupRoot)}.`,
      );
    }
    const scheduled = await scheduleStartAfterRollback(
      unitName,
      options.root,
      options.candidateVersion,
    );
    return failed(
      true,
      scheduled
        ? `${problem} ${account}'s state was restored from the update backup; ${unitName} starts again once the previous package is restored.`
        : `${problem} ${account}'s state was restored from the update backup; ${unitName} is stopped. Start it with sudo systemctl start ${unitName} once the previous package is restored.`,
    );
  };
  if (!stopped) {
    return failed(false, `${unitName} did not stop.`);
  }
  const budget = (fallback: number) => Math.max(1_000, options.remainingMs?.() ?? fallback);
  const migrated = await asAccount("migrate", budget(DEFAULT_MIGRATE_TIMEOUT_MS)).catch(() => null);
  if (
    !migrated ||
    migrated.termination !== "exit" ||
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
      (await runReleaseAsServiceAccount(execution, {
        root: options.root,
        args: ["gateway", "health", "--json"],
        timeoutMs: 20_000,
        maxStdoutBytes: ACCOUNT_RESULT_MAX_BYTES,
      })
        .then((health) => health.termination === "exit" && health.code === 0)
        .catch(() => false)),
    Math.min(DEFAULT_READY_TIMEOUT_MS, budget(DEFAULT_READY_TIMEOUT_MS)),
  );
  if (!ready) {
    await control("stop").catch(() => {});
    await waitForUnit(
      unitName,
      (unit) => unit.active === "inactive" || unit.active === "failed",
      60_000,
    );
    return await restore(`${unitName} did not come ready on ${options.candidateVersion}.`);
  }
  const notServingMs = Date.now() - stoppedAt;
  const warnings: string[] = [];
  const finished = await asAccount("finish", 10 * 60_000).catch(() => null);
  if (
    !finished ||
    finished.termination !== "exit" ||
    finished.code !== 0 ||
    readAccountStatus(finished.stdout) !== "finished"
  ) {
    warnings.push(
      `${unitName} serves ${options.candidateVersion}, but ${account}'s update record and backup cleanup did not finish; run update finish as ${account} with --backup-root ${backupRoot}.`,
    );
  }
  return { status: "updated", unitName, account, notServingMs, warnings };
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
