import { validateCronRunsParams } from "../../../packages/gateway-protocol/src/index.js";
import {
  isInvalidCronRunJobIdError,
  projectCronRunHistoryPage,
  type ReadCronRunHistoryPageOptions,
} from "../../cron/run-history.js";
import { cronStoreKey } from "../../cron/store/key.js";
import { readCronRunRecords } from "../../cron/store/read-only.js";
import { cronJobMatchesCallerScope, readCronCallerScope } from "./cron-caller-scope.js";
import {
  assertCronReadCurrent,
  resolveCronJobId,
  respondCronJobNotFound,
  respondInvalidCronParams,
  respondMissingCronJobId,
} from "./cron-job-access.js";
import { cronRunLogPageFilters, filterCronRunLogJobsByAgent } from "./cron-run-log-filters.js";
import { createCronSessionVisibility, cronJobIsVisible } from "./cron-visibility.js";
import type { GatewayRequestHandler } from "./types.js";
import { assertValidParams } from "./validation.js";

export const cronRunsHandler: GatewayRequestHandler = async (options) => {
  const { params, respond, context, client } = options;
  if (!assertValidParams(params, validateCronRunsParams, "cron.runs", respond)) {
    return;
  }
  const p = params;
  const hasJobSelector = p.id !== undefined || p.jobId !== undefined;
  const jobId = resolveCronJobId(p);
  const scope = p.scope ?? (hasJobSelector ? "job" : "all");
  const visibilityRead = createCronSessionVisibility(client, context);
  const assertCurrent = (storeKey: string) => {
    assertCronReadCurrent(options);
    if (cronStoreKey(context.cronStorePath) !== storeKey) {
      throw new Error("Cron history store changed; retry the request");
    }
  };
  if (scope === "all") {
    if (readCronCallerScope(client)) {
      respondInvalidCronParams(respond, "cron.runs", "scope all is not allowed by caller scope");
      return;
    }
    const listedJobs = await context.cron.list({ includeDisabled: true });
    const storeKey = cronStoreKey(context.cronStorePath);
    const records = await readCronRunRecords(storeKey);
    await visibilityRead.prepare();
    assertCurrent(storeKey);
    const jobs = filterCronRunLogJobsByAgent(
      listedJobs.flatMap(({ id }) => {
        const job = context.cron.getJob(id);
        return job ? [job] : [];
      }),
      p.agentId,
      context.cron.getDefaultAgentId(),
    );
    if (readCronCallerScope(client)) {
      throw new Error("Cron history scope changed; retry the request");
    }
    const visibility = visibilityRead.resolve();
    const visibleJobs = jobs.filter((job) =>
      cronJobIsVisible(job, visibility, context.cron.getDefaultAgentId()),
    );
    const visibleIds = new Set(visibleJobs.map((job) => job.id));
    const pageOptions: ReadCronRunHistoryPageOptions = {
      storeKey,
      ...cronRunLogPageFilters(p),
      agentId: p.agentId,
      jobNameById: Object.fromEntries(visibleJobs.map((job) => [job.id, job.name])),
      entryFilter: visibility ? (entry) => visibleIds.has(entry.jobId) : undefined,
    };
    const page = projectCronRunHistoryPage(records, {
      ...pageOptions,
      entryFilter: visibility
        ? (entry) =>
            visibleIds.has(entry.jobId) &&
            (!entry.sessionKey || visibility(entry.sessionKey, p.agentId))
        : undefined,
    });
    respond(true, page, undefined);
    return;
  }
  if (!jobId) {
    respondMissingCronJobId(respond, "cron.runs");
    return;
  }
  try {
    await context.cron.readJob(jobId);
    const storeKey = cronStoreKey(context.cronStorePath);
    const records = await readCronRunRecords(storeKey, jobId);
    await visibilityRead.prepare();
    assertCurrent(storeKey);
    const callerScope = readCronCallerScope(client);
    const job = context.cron.getJob(jobId);
    const visibility = visibilityRead.resolve();
    const defaultAgentId = context.cron.getDefaultAgentId();
    const matchedJob =
      job &&
      filterCronRunLogJobsByAgent([job], p.agentId, defaultAgentId).length > 0 &&
      cronJobIsVisible(job, visibility, defaultAgentId) &&
      cronJobMatchesCallerScope({
        job,
        callerScope,
        defaultAgentId,
        allowCurrentJob: true,
      })
        ? job
        : undefined;
    // Operator history survives deletion; scoped reads need a live matching owner.
    if ((callerScope || p.agentId || visibility) && !matchedJob) {
      respondCronJobNotFound(respond, jobId);
      return;
    }
    const pageOptions: ReadCronRunHistoryPageOptions = {
      storeKey,
      jobId,
      ...cronRunLogPageFilters(p),
      jobNameById:
        matchedJob && typeof matchedJob.name === "string"
          ? { [jobId]: matchedJob.name }
          : undefined,
    };
    const page = projectCronRunHistoryPage(records, {
      ...pageOptions,
      entryFilter: visibility
        ? (entry) => !entry.sessionKey || visibility(entry.sessionKey, matchedJob?.agentId)
        : undefined,
    });
    if (
      !job &&
      page.total === 0 &&
      projectCronRunHistoryPage(records, { storeKey, jobId, limit: 1 }).total === 0
    ) {
      respondCronJobNotFound(respond, jobId);
      return;
    }
    respond(true, page, undefined);
  } catch (error) {
    if (!isInvalidCronRunJobIdError(error)) {
      throw error;
    }
    respondInvalidCronParams(respond, "cron.runs", "invalid id");
  }
};
