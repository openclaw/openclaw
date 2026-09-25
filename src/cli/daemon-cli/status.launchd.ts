/** Live launchd job diagnostics shared by shallow and deep Gateway status. */
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

export type LaunchdJobDiagnostics = {
  staleUpdateLaunchdJobs?: StaleOpenClawUpdateLaunchdJob[];
  foreignLaunchdJobs?: ForeignLaunchdJob[];
  foreignLaunchdInspectionError?: string;
  forcedRestartSummary?: GatewayForcedRestartSummary;
};

export async function gatherLaunchdJobDiagnostics(
  env: NodeJS.ProcessEnv,
  deep: boolean,
): Promise<LaunchdJobDiagnostics> {
  const diagnostics: LaunchdJobDiagnostics = {};
  const stale = deep
    ? await import("../../daemon/launchd.js")
        .then(({ findStaleOpenClawUpdateLaunchdJobs }) => findStaleOpenClawUpdateLaunchdJobs(env))
        .catch(() => [])
    : [];
  if (stale.length) {
    diagnostics.staleUpdateLaunchdJobs = stale;
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
