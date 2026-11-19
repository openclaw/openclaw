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
import type { RuntimeEnv } from "../runtime.js";
import type { DoctorOptions } from "./doctor-prompter.js";
import {
  resolveServiceRepairPolicy,
  isServiceRepairDeferred,
  shouldManageGatewayService,
} from "./doctor-service-repair-policy.js";

type ForeignLaunchdRepairEligibility =
  | { ok: true }
  | { ok: false; reason: string; guidance: string };

/**
 * Names why this Doctor invocation cannot repair, so the report never sends an
 * operator to a `--fix` that the repair owner will refuse.
 */
async function resolveForeignLaunchdRepairEligibility(
  env: NodeJS.ProcessEnv,
): Promise<ForeignLaunchdRepairEligibility> {
  if (!isDefaultInstallIdentity(env)) {
    return {
      ok: false,
      reason:
        "this Doctor invocation is not the default install identity (a custom state dir, home, profile, or service identity).",
      guidance:
        "This Doctor invocation is not the default install identity (custom state dir, home, profile, or service identity), so it will not remove these jobs. Run it from the owning install or profile, or remove the launchd job manually.",
    };
  }
  const policy = resolveServiceRepairPolicy(env);
  if (isServiceRepairDeferred(policy)) {
    const external = policy !== "update";
    return {
      ok: false,
      reason: external
        ? "Gateway service repair is managed externally."
        : "an update is in progress.",
      guidance: external
        ? "Gateway service repair is managed externally, so Doctor will not remove these jobs. Remove them through your supervisor, or remove the launchd job manually."
        : "An update is in progress, so Doctor will not remove these jobs. Retry after it finishes, or remove the launchd job manually.",
    };
  }
  if (!(await shouldManageGatewayService(env))) {
    return {
      ok: false,
      reason: "another supervisor owns Gateway service management.",
      guidance:
        "Another supervisor owns Gateway service management, so Doctor will not remove these jobs. Remove them through that supervisor, or remove the launchd job manually.",
    };
  }
  return { ok: true };
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
  const candidates = jobs.filter((job) => job.safeToRemove);
  const eligibility =
    candidates.length > 0 ? await resolveForeignLaunchdRepairEligibility(env) : undefined;
  const lines = [formatForeignLaunchdJobs(jobs, { repairAvailable: eligibility?.ok ?? false })];
  const restarts = readGatewayForcedRestartSummary(env);
  if (restarts.count > 0) {
    lines.push(
      `${restarts.count} external forced Gateway restart(s) in the last ${Math.round(restarts.windowMs / 60_000)} minutes. Listed lifecycle jobs may be responsible; this is not proof of attribution.`,
    );
  }
  if (candidates.length > 0 && eligibility) {
    lines.push(
      eligibility.ok
        ? `Run ${formatCliCommand("openclaw doctor --fix", env)} to remove confirmed stray Gateway lifecycle jobs.`
        : eligibility.guidance,
    );
  }
  note(lines.join("\n"), "Foreign launchd jobs (macOS)");
  if (options.repair !== true || candidates.length === 0 || !eligibility) {
    return;
  }
  if (!eligibility.ok) {
    runtime.log(`Foreign launchd job repair skipped: ${eligibility.reason} No jobs were removed.`);
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
