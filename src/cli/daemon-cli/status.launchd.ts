/** Live launchd job diagnostics shared by shallow and deep Gateway status. */
import { resolveStateDir } from "../../config/paths.js";
import {
  findForeignLaunchdJobs,
  type ForeignLaunchdJob,
} from "../../daemon/launchd-foreign-jobs.js";
import type { StaleOpenClawUpdateLaunchdJob } from "../../daemon/launchd.js";
import {
  readGatewayForcedRestartSummary,
  type GatewayForcedRestartSummary,
} from "../../daemon/restart-storm.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { redactSupportDiagnosticLine } from "../../logging/diagnostic-support-redaction.js";

type LaunchdJobDiagnostics = {
  staleUpdateLaunchdJobs?: StaleOpenClawUpdateLaunchdJob[];
  staleLaunchdInspectionError?: string;
  foreignLaunchdJobs?: ForeignLaunchdJob[];
  foreignLaunchdInspectionError?: string;
  forcedRestartSummary?: GatewayForcedRestartSummary;
};

export async function gatherLaunchdJobDiagnostics(
  env: NodeJS.ProcessEnv,
  deep: boolean,
): Promise<LaunchdJobDiagnostics> {
  const diagnostics: LaunchdJobDiagnostics = {};
  if (deep) {
    try {
      const { findStaleOpenClawUpdateLaunchdJobs } = await import("../../daemon/launchd.js");
      const stale = await findStaleOpenClawUpdateLaunchdJobs(env);
      if (stale.length) {
        diagnostics.staleUpdateLaunchdJobs = stale;
      }
    } catch (error: unknown) {
      diagnostics.staleLaunchdInspectionError = redactSupportDiagnosticLine(
        formatErrorMessage(error),
        { env, stateDir: resolveStateDir(env) },
      );
    }
  }
  try {
    const jobs = await findForeignLaunchdJobs(env);
    if (jobs.length) {
      diagnostics.foreignLaunchdJobs = jobs;
      diagnostics.forcedRestartSummary = readGatewayForcedRestartSummary(env);
    }
  } catch (error: unknown) {
    diagnostics.foreignLaunchdInspectionError = formatErrorMessage(error);
  }
  return diagnostics;
}
