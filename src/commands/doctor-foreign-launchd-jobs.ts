import { note } from "../../packages/terminal-core/src/note.js";
import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import { formatCliCommand } from "../cli/command-format.js";
import { isDefaultInstallIdentity } from "../config/paths.js";
import {
  findForeignLaunchdJobs,
  formatForeignLaunchdJobs,
  repairForeignLaunchdJob,
  type ForeignLaunchdJob,
} from "../daemon/launchd-foreign-jobs.js";
import { readGatewayForcedRestartSummary } from "../daemon/restart-storm.js";
import { formatErrorMessage } from "../infra/errors.js";
import { resolveGatewayPlatformSupervisor } from "../infra/gateway-supervision.js";
import type { RuntimeEnv } from "../runtime.js";
import type { DoctorMaintenancePending } from "./doctor-maintenance-pending.js";
import type { DoctorOptions } from "./doctor-prompter.js";
import {
  isServiceRepairDeferred,
  resolveServiceRepairPolicy,
  shouldManageGatewayService,
} from "./doctor-service-repair-policy.js";

async function resolveForeignLaunchdRepairBlock(env: NodeJS.ProcessEnv) {
  if (!isDefaultInstallIdentity(env)) {
    return {
      reason: "this is a non-default install identity",
      nextStep: "Run Doctor from the owning installation and profile.",
    };
  }
  const policy = resolveServiceRepairPolicy(env);
  if (policy === "update") {
    return {
      reason: "an OpenClaw update is in progress",
      nextStep: "After the update completes, rerun Doctor.",
    };
  }
  const deferred = isServiceRepairDeferred(policy);
  if (deferred || !(await shouldManageGatewayService(env))) {
    let reason = "service management is unavailable in this environment";
    if (policy === "external") {
      reason = "service repair is configured as external";
    } else if (deferred || resolveGatewayPlatformSupervisor(env)) {
      reason = "an external supervisor owns service management";
    }
    return {
      reason,
      nextStep:
        "Ask the job owner to unload the listed label with launchctl bootout gui/$UID/<label> and disable its launchd entry if needed.",
    };
  }
  return undefined;
}

const selectRemovableJobs = (jobs: readonly ForeignLaunchdJob[]) =>
  jobs.filter((job) => job.safeToRemove);

/** Read-only: whether `noteMacForeignLaunchdJobs` would try to remove a stray job. */
export async function checkMacForeignLaunchdJobRepairPending(
  options: DoctorOptions,
  env: NodeJS.ProcessEnv = process.env,
): Promise<DoctorMaintenancePending> {
  if (process.platform !== "darwin" || options.repair !== true) {
    return "none";
  }
  const candidates = selectRemovableJobs(await findForeignLaunchdJobs(env));
  if (candidates.length === 0 || (await resolveForeignLaunchdRepairBlock(env))) {
    return "none";
  }
  return "work";
}

/** Reports foreign launchd jobs; only explicit Doctor repair may remove lifecycle jobs. */
export async function noteMacForeignLaunchdJobs(
  options: DoctorOptions,
  runtime: RuntimeEnv,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (process.platform !== "darwin") {
    return;
  }
  let jobs: ForeignLaunchdJob[];
  try {
    jobs = await findForeignLaunchdJobs(env);
  } catch (error) {
    note(
      `Could not inspect foreign launchd jobs: ${sanitizeTerminalText(formatErrorMessage(error))}. No jobs were removed.`,
      "Foreign launchd jobs (macOS)",
    );
    return;
  }
  if (jobs.length === 0) {
    return;
  }
  const lines = [formatForeignLaunchdJobs(jobs)];
  const restarts = readGatewayForcedRestartSummary(env);
  if (restarts.count > 0) {
    lines.push(
      `${restarts.count} external forced Gateway restart(s) in the last ${Math.round(restarts.windowMs / 60_000)} minutes. Listed lifecycle jobs may be responsible; this is not proof of attribution.`,
    );
  }
  const candidates = selectRemovableJobs(jobs);
  const repairBlock =
    candidates.length > 0 ? await resolveForeignLaunchdRepairBlock(env) : undefined;
  if (repairBlock) {
    lines.push(
      `Doctor cannot remove the confirmed stray jobs because ${repairBlock.reason}. ${repairBlock.nextStep}`,
    );
  } else if (candidates.length > 0 && options.repair !== true) {
    lines.push(
      `Run ${formatCliCommand("openclaw doctor --fix", env)} to remove confirmed stray Gateway lifecycle jobs.`,
    );
  }
  note(lines.join("\n"), "Foreign launchd jobs (macOS)");
  if (options.repair !== true || candidates.length === 0) {
    return;
  }
  if (repairBlock) {
    runtime.log(`Foreign launchd job repair skipped: ${repairBlock.reason}. No jobs were removed.`);
    return;
  }
  for (const job of candidates) {
    try {
      const result = await repairForeignLaunchdJob(job, env);
      runtime.log(
        result.removed
          ? result.detail
          : `Removal not confirmed for launchd job ${job.label}: ${result.detail}`,
      );
    } catch (error) {
      runtime.log(
        `Removal not confirmed for launchd job ${job.label}: ${sanitizeTerminalText(formatErrorMessage(error))}`,
      );
    }
  }
}
