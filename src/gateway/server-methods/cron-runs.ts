import { validateCronRunsParams } from "../../../packages/gateway-protocol/src/index.js";
import {
  isInvalidCronRunJobIdError,
  projectCronRunHistoryPage,
  selectCronRunHistoryPage,
  type ReadCronRunHistoryPageOptions,
} from "../../cron/run-history.js";
import { cronStoreKey } from "../../cron/store/key.js";
import {
  readCronRunHistoryCandidates,
  readCronRunHistoryRecords,
} from "../../cron/store/read-only.js";
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
  if (scope === "all" && readCronCallerScope(client)) {
    respondInvalidCronParams(respond, "cron.runs", "scope all is not allowed by caller scope");
    return;
  }
  if (scope !== "all" && !jobId) {
    respondMissingCronJobId(respond, "cron.runs");
    return;
  }
  try {
    const loadedJobs =
      scope === "all"
        ? await context.cron.list({ includeDisabled: true })
        : [await context.cron.readJob(jobId!)].filter((job) => job !== undefined);
    const storeKey = cronStoreKey(context.cronStorePath);
    await visibilityRead.prepare();
    const resolvePageOptions = (): ReadCronRunHistoryPageOptions | undefined => {
      const visibility = visibilityRead.resolve();
      const defaultAgentId = context.cron.getDefaultAgentId();
      const callerScope = readCronCallerScope(client);
      if (scope === "all") {
        if (callerScope) {
          throw new Error("Cron history scope changed; retry the request");
        }
        const jobs = filterCronRunLogJobsByAgent(
          loadedJobs.flatMap(({ id }) => {
            const job = context.cron.getJob(id);
            return job ? [job] : [];
          }),
          p.agentId,
          defaultAgentId,
        ).filter((job) => cronJobIsVisible(job, visibility, defaultAgentId));
        const visibleIds = new Set(jobs.map((job) => job.id));
        return {
          storeKey,
          ...cronRunLogPageFilters(p),
          agentId: p.agentId,
          jobNameById: Object.fromEntries(jobs.map((job) => [job.id, job.name])),
          entryFilter: visibility
            ? (entry) =>
                visibleIds.has(entry.jobId) &&
                (!entry.sessionKey || visibility(entry.sessionKey, p.agentId))
            : undefined,
        };
      }
      const job = context.cron.getJob(jobId!);
      const matchedJob =
        job &&
        filterCronRunLogJobsByAgent([job], p.agentId, defaultAgentId).length > 0 &&
        cronJobIsVisible(job, visibility, defaultAgentId) &&
        cronJobMatchesCallerScope({ job, callerScope, defaultAgentId, allowCurrentJob: true })
          ? job
          : undefined;
      // Operator history survives deletion; scoped reads need a live matching owner.
      if ((callerScope || p.agentId || visibility) && !matchedJob) {
        respondCronJobNotFound(respond, jobId!);
        return undefined;
      }
      return {
        storeKey,
        jobId,
        ...cronRunLogPageFilters(p),
        jobNameById:
          matchedJob && typeof matchedJob.name === "string"
            ? { [jobId!]: matchedJob.name }
            : undefined,
        entryFilter: visibility
          ? (entry) => !entry.sessionKey || visibility(entry.sessionKey, matchedJob?.agentId)
          : undefined,
      };
    };
    const initialOptions = resolvePageOptions();
    if (!initialOptions) {
      return;
    }
    const candidates = await readCronRunHistoryCandidates(
      storeKey,
      scope === "all" ? undefined : jobId,
      p.query,
      p.query ? initialOptions.jobNameById : undefined,
    );
    const { records } = candidates;
    if (
      scope !== "all" &&
      !context.cron.getJob(jobId!) &&
      projectCronRunHistoryPage(records, { storeKey, jobId, limit: 1 }).total === 0
    ) {
      assertCurrent(storeKey);
      respondCronJobNotFound(respond, jobId!);
      return;
    }
    const queryMatchedTaskIds = candidates.queryMatches
      ? new Set(candidates.queryMatches)
      : undefined;
    const initial = selectCronRunHistoryPage(records, { ...initialOptions, queryMatchedTaskIds });
    const details = await readCronRunHistoryRecords(
      storeKey,
      initial.records.map((row) => row.id),
      p.view,
    );
    // Hydration awaits storage; visibility and caller authority belong at disclosure.
    assertCurrent(storeKey);
    const pageOptions = resolvePageOptions();
    if (!pageOptions) {
      return;
    }
    const hydratedById = new Map(details.map((record) => [record.id, record]));
    const selection = selectCronRunHistoryPage(
      records.map((record) => hydratedById.get(record.id) ?? record),
      { ...pageOptions, queryMatchedTaskIds },
    );
    const selectedIds = new Set(selection.records.map((row) => row.id));
    const entries = projectCronRunHistoryPage(
      details.filter((row) => selectedIds.has(row.id)),
      {
        ...pageOptions,
        offset: 0,
        query: undefined,
        runId: undefined,
      },
    ).entries;
    // A concurrently removed run or revoked session can shorten this page; refresh fills it.
    respond(true, { ...selection.page, entries }, undefined);
  } catch (error) {
    if (!isInvalidCronRunJobIdError(error)) {
      throw error;
    }
    respondInvalidCronParams(respond, "cron.runs", "invalid id");
  }
};
