import { validateCronListParams } from "../../../packages/gateway-protocol/src/index.js";
import { tryResolveCronJobEffectiveAgentId } from "../../cron/agent-id.js";
import { resolveCronDeliveryPreviews } from "../../cron/delivery-preview.js";
import { resolveCronJobBoundSessionKeys } from "../../cron/job-session-bindings.js";
import type { CronListPageResult } from "../../cron/service/list-page-types.js";
import type { CronJob } from "../../cron/types.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { parseAgentSessionKey } from "../../sessions/session-key-utils.js";
import {
  cronJobMatchesCallerScope,
  readCronCallerScope,
  resolveCronJobOwnerAgentId,
} from "./cron-caller-scope.js";
import { assertCronReadCurrent, respondInvalidCronParams } from "./cron-job-access.js";
import { startCronListDiagnostics } from "./cron-list-diagnostics.js";
import { projectCronListJobs } from "./cron-list-projection.js";
import {
  createCronSessionVisibility,
  cronJobIsVisible,
  cronJobVisibilityTarget,
} from "./cron-visibility.js";
import { createPreparedReadHandler } from "./prepared-read.js";
import { assertValidParams } from "./validation.js";

export const cronListHandler = createPreparedReadHandler((options) => {
  const { params, respond: originalRespond, context, client } = options;
  const diagnostics = startCronListDiagnostics(context.logGateway, originalRespond);
  const respondToCaller = diagnostics?.respond ?? originalRespond;
  const visibilityRead = createCronSessionVisibility(client, () => context.getRuntimeConfig());
  let handlerOutcome: "returned" | "threw" = "returned";
  let prepared = false;
  try {
    if (!assertValidParams(params, validateCronListParams, "cron.list", respondToCaller)) {
      return undefined;
    }
    const p = params;
    const admittedScope = readCronCallerScope(client);
    const callerScope = admittedScope?.manageAll ? undefined : admittedScope;
    const requestedAgentId = p.agentId ? normalizeAgentId(p.agentId) : undefined;
    if (callerScope && requestedAgentId && requestedAgentId !== callerScope.agentId) {
      respondInvalidCronParams(respondToCaller, "cron.list", "agentId outside caller scope");
      return undefined;
    }
    const release = (outcome: "returned" | "threw") => {
      visibilityRead.release();
      diagnostics?.finish(outcome);
    };
    const shareable = !callerScope && !visibilityRead.resolve();
    diagnostics?.setRequestMode({
      compact: p.compact === true,
      previewsRequested: p.compact !== true && p.includeDeliveryPreviews !== false,
      scopeApplied: !shareable,
    });
    prepared = true;
    return {
      shareable,
      respond: respondToCaller,
      assertCurrent: () => assertCronReadCurrent(options),
      release,
      run: async (respond) => {
        const listOptions = {
          includeDisabled: p.includeDisabled,
          limit: p.limit,
          offset: p.offset,
          query: p.query,
          enabled: p.enabled,
          scheduleKind: p.scheduleKind,
          lastRunStatus: p.lastRunStatus,
          trigger: p.trigger,
          sortBy: p.sortBy,
          sortDir: p.sortDir,
          // Owners retain visibility when execution is retargeted to another agent.
          agentId: callerScope ? undefined : p.agentId,
        };
        const matchesRequestScope = (job: CronJob) => {
          const scope = readCronCallerScope(client);
          const currentScope = scope?.manageAll ? undefined : scope;
          const currentDefault = context.cron.getDefaultAgentId();
          return (
            cronJobMatchesCallerScope({
              job,
              callerScope: currentScope,
              defaultAgentId: currentDefault,
              allowCurrentJob: true,
            }) &&
            (!p.sessionKey ||
              (resolveCronJobBoundSessionKeys(job, {
                cfg: context.getRuntimeConfig(),
                defaultAgentId: currentDefault,
              }).has(p.sessionKey) &&
                (parseAgentSessionKey(p.sessionKey) !== null ||
                  !p.sessionAgentId ||
                  (resolveCronJobOwnerAgentId(job) ??
                    tryResolveCronJobEffectiveAgentId(job, currentDefault)) ===
                    normalizeAgentId(p.sessionAgentId))))
          );
        };
        if (visibilityRead.resolve()) {
          const loadedJobs: CronJob[] = [];
          // The list owner applies every authored filter before sharing preparation.
          await context.cron.listPage(listOptions, (job) => {
            if (matchesRequestScope(job)) {
              loadedJobs.push(job);
            }
            return false;
          });
          assertCronReadCurrent(options);
          await visibilityRead.prepare(
            loadedJobs.map((job) => cronJobVisibilityTarget(job, context.cron.getDefaultAgentId())),
          );
        }
        assertCronReadCurrent(options);
        const cronVisibility = visibilityRead.resolve();
        diagnostics?.mark("listing");
        const selectedJobIds = new Set<string>();
        const matchesCurrentJob = (job: CronJob) =>
          matchesRequestScope(job) &&
          cronJobIsVisible(job, visibilityRead.resolve(), context.cron.getDefaultAgentId());
        const assertPageCurrent = () => {
          assertCronReadCurrent(options);
          const currentScope = readCronCallerScope(client);
          // The filtered total belongs to this scope, even when its visible page is empty.
          if (
            Boolean(currentScope && !currentScope.manageAll) !== Boolean(callerScope) ||
            Boolean(visibilityRead.resolve()) !== Boolean(cronVisibility)
          ) {
            throw new Error("Cron list visibility changed; refresh the page");
          }
          for (const id of selectedJobIds) {
            const current = context.cron.getJob(id);
            if (!current || !matchesCurrentJob(current)) {
              throw new Error("Cron list visibility changed; refresh the page");
            }
          }
        };
        let matchesJob: ((job: CronJob) => boolean) | undefined;
        if (callerScope || cronVisibility || p.sessionKey) {
          diagnostics?.startScopeAttempt();
          matchesJob = (job) => {
            const matched = matchesCurrentJob(job);
            if (matched) {
              selectedJobIds.add(job.id);
            }
            return matched;
          };
        }
        let page: CronListPageResult;
        const finishPage = diagnostics?.startSourcePage();
        try {
          page = await context.cron.listPage(listOptions, matchesJob);
        } finally {
          finishPage?.();
        }
        if (matchesJob) {
          for (const job of page.jobs) {
            selectedJobIds.add(job.id);
          }
        }
        assertPageCurrent();
        diagnostics?.setReturnedCount(page.jobs.length);
        diagnostics?.mark("projection");
        const jobs = projectCronListJobs(context.cron, page, p.compact === true);
        if (p.compact === true || p.includeDeliveryPreviews === false) {
          // Full job rows are the default because editors need their payloads. Delivery
          // previews are independently suppressible so list-only callers avoid per-job I/O
          // without weakening the shipped full-response default.
          respond(true, { ...page, jobs }, undefined);
          return;
        }
        diagnostics?.mark("previews");
        const deliveryPreviews = await resolveCronDeliveryPreviews({
          cfg: context.getRuntimeConfig(),
          defaultAgentId: context.cron.getDefaultAgentId(),
          jobs: page.jobs,
        });
        assertPageCurrent();
        respond(true, { ...page, jobs, deliveryPreviews }, undefined);
      },
    };
  } catch (error) {
    handlerOutcome = "threw";
    throw error;
  } finally {
    if (!prepared) {
      visibilityRead.release();
      diagnostics?.finish(handlerOutcome);
    }
  }
});
