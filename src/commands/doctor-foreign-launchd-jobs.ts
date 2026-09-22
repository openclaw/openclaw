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
import { isTruthyEnvValue } from "../infra/env.js";
import { formatErrorMessage } from "../infra/errors.js";
import type { RuntimeEnv } from "../runtime.js";
import type { DoctorOptions } from "./doctor-prompter.js";
import {
  resolveServiceRepairPolicy,
  shouldManageGatewayService,
} from "./doctor-service-repair-policy.js";

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
  const candidates = jobs.filter((job) => job.safeToRemove);
  if (candidates.length > 0) {
    lines.push(
      `Run ${formatCliCommand("openclaw doctor --fix", env)} to remove confirmed stray Gateway lifecycle jobs.`,
    );
  }
  note(lines.join("\n"), "Foreign launchd jobs (macOS)");
  if (options.repair !== true || candidates.length === 0) {
    return;
  }
  if (
    !isDefaultInstallIdentity(env) ||
    resolveServiceRepairPolicy(env) === "external" ||
    !(await shouldManageGatewayService(env)) ||
    isTruthyEnvValue(env.OPENCLAW_UPDATE_IN_PROGRESS)
  ) {
    runtime.log(
      "Foreign launchd job repair skipped: this Doctor invocation does not own service repair or an update is in progress. No jobs were removed.",
    );
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
