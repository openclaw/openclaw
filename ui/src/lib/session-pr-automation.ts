import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { CronJob, CronJobsListResult } from "../api/types.ts";
import { assertCanonicalCronJobsCursor, readCanonicalCronJobsPage } from "./cron/jobs.ts";
import {
  CI_AUTOMATION_OPTIONS,
  ciAutomationDeclarationPrefix,
  ciAutomationJobMatches,
  ciAutomationJobSpec,
  type CiAutomationOption,
  type CiAutomationTarget,
} from "./session-pr-automation-spec.ts";

export type CiAutomationJobs = Partial<Record<CiAutomationOption, CronJob>>;

/** Cron owns durable settings, execution and access; this is only a scoped projection. */
export async function loadCiAutomationJobs(
  client: GatewayBrowserClient,
  target: CiAutomationTarget,
  signal: AbortSignal,
): Promise<CiAutomationJobs> {
  const jobs: CiAutomationJobs = {};
  const prefix = ciAutomationDeclarationPrefix(target);
  let offset = 0;
  let revision: string | undefined;
  do {
    const response = await client.request<CronJobsListResult>(
      "cron.list",
      {
        sessionKey: target.sessionKey,
        sessionAgentId: target.agentId,
        includeDisabled: true,
        includeDeliveryPreviews: false,
        limit: 200,
        offset,
      },
      { signal },
    );
    const page = readCanonicalCronJobsPage(response, 200);
    assertCanonicalCronJobsCursor(page, offset);
    if (revision && revision !== page.snapshotRevision) {
      throw new Error("Automation inventory changed. Refresh and try again.");
    }
    revision = page.snapshotRevision;
    for (const job of page.jobs) {
      if (!job.declarationKey?.startsWith(prefix)) {
        continue;
      }
      const option = CI_AUTOMATION_OPTIONS.find((key) => job.declarationKey === prefix + key);
      if (!option || !ciAutomationJobMatches(job, target, option) || jobs[option]) {
        throw new Error(
          "This CI automation was changed. Review it in Automations before continuing.",
        );
      }
      jobs[option] = job;
    }
    if (!page.hasMore) {
      return jobs;
    }
    offset += page.jobs.length;
  } while (!signal.aborted);
  signal.throwIfAborted();
  return jobs;
}

export async function setCiAutomationEnabled(
  client: GatewayBrowserClient,
  target: CiAutomationTarget,
  option: CiAutomationOption,
  enabled: boolean,
  current: CronJob | undefined,
): Promise<CronJob | undefined> {
  if (!current && !enabled) {
    return undefined;
  }
  let result: CronJob;
  if (current) {
    if (!ciAutomationJobMatches(current, target, option) || !current.configRevision) {
      throw new Error("Refresh the automation before changing it.");
    }
    result = await client.request<CronJob>("cron.update", {
      id: current.id,
      expectedConfigRevision: current.configRevision,
      patch: { enabled },
    });
  } else {
    // Declaration convergence makes a lost create acknowledgement discoverable as the same job.
    const response = await client.request<{ job: CronJob }>(
      "cron.add",
      ciAutomationJobSpec(target, option),
    );
    result = response.job;
  }
  if (!result || !ciAutomationJobMatches(result, target, option)) {
    throw new Error("The automation changed while saving. Refresh to check its current state.");
  }
  return result;
}
