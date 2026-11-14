import {
  validateCronScratchGetParams,
  validateCronScratchSetParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { cronScratchReadView } from "../../cron/job-read-view.js";
import { CRON_JOB_SCRATCH_MAX_BYTES } from "../../cron/scratch-contract.js";
import type { CronJob } from "../../cron/types.js";
import { formatErrorMessage } from "../../infra/errors.js";
import {
  cronCallerRunsJob,
  cronJobMatchesCallerScope,
  readCronCallerScope,
  resolveCronMutationCommitGuard,
  type CronCallerScope,
} from "./cron-caller-scope.js";
import {
  assertCronReadCurrent,
  respondInvalidCronParams,
  scopedCronJobHandler,
} from "./cron-job-access.js";
import type { GatewayRequestHandlers } from "./types.js";

export const cronScratchHandlers: GatewayRequestHandlers = {
  "cron.scratch.get": scopedCronJobHandler(
    "cron.scratch.get",
    validateCronScratchGetParams,
    async (options, { jobId }) => {
      const { respond, context, client } = options;
      const assertCurrent = () => {
        assertCronReadCurrent(options);
        const job = context.cron.getJob(jobId);
        if (
          !job ||
          !cronJobMatchesCallerScope({
            job,
            callerScope: readCronCallerScope(client),
            defaultAgentId: context.cron.getDefaultAgentId(),
            allowCurrentJob: true,
          })
        ) {
          throw new Error("Cron scratch owner changed before reply");
        }
      };
      assertCurrent();
      const state = await context.cron.readScratch(jobId, {
        assertCurrent,
        signal: options.signal,
      });
      assertCurrent();
      respond(
        true,
        {
          scratch: cronScratchReadView(state.scratch),
          currentRevision: state.currentRevision,
          maxBytes: CRON_JOB_SCRATCH_MAX_BYTES,
        },
        undefined,
      );
    },
    // The job's own scheduled run reads its scratch; the docs promise self-scoped access.
    { allowCurrentJob: true },
  ),
  "cron.scratch.set": scopedCronJobHandler(
    "cron.scratch.set",
    validateCronScratchSetParams,
    async (
      { params, respond, context, client, sessionMutationCommitGuard, hasCurrentClientAuthority },
      { jobId, callerScope, job },
    ) => {
      const p = params;
      const defaultAgentId = context.cron.getDefaultAgentId();
      // Scratch is appended to the run prompt, so a conversation may not write it under operator
      // authority. The job's own run already holds that authority and may keep its notes. The
      // final guard repeats the check on the locked job with a freshly read run claim.
      const operatorOnly = (
        candidate: CronJob | undefined,
        scope: CronCallerScope | undefined,
      ): boolean =>
        Boolean(scope && !scope.manageAll) &&
        candidate?.scheduledToolPolicy?.mode === "trusted" &&
        !cronCallerRunsJob(candidate, scope, defaultAgentId);
      const operatorOnlyMessage =
        "This automation runs with operator access, so only a Gateway owner, an operator or the automation's own run can change its scratch.";
      if (operatorOnly(job, callerScope)) {
        respondInvalidCronParams(respond, "cron.scratch.set", operatorOnlyMessage);
        return;
      }
      try {
        const scopeGuard = resolveCronMutationCommitGuard(
          client,
          context,
          { callerScope, jobId, allowCurrentJob: true },
          { sessionMutationCommitGuard, hasCurrentClientAuthority },
        );
        const commitGuard = () => {
          scopeGuard?.();
          if (operatorOnly(context.cron.getJob(jobId), readCronCallerScope(client))) {
            throw new TypeError(operatorOnlyMessage);
          }
        };
        const result = await context.cron.writeScratch(jobId, {
          content: p.content,
          expectedRevision: p.expectedRevision,
          commitGuard,
        });
        if (!result.ok) {
          respond(true, result, undefined);
          return;
        }
        respond(
          true,
          {
            ok: true,
            scratch: cronScratchReadView(result.scratch),
            currentRevision: result.currentRevision,
            maxBytes: CRON_JOB_SCRATCH_MAX_BYTES,
          },
          undefined,
        );
      } catch (error) {
        respondInvalidCronParams(respond, "cron.scratch.set", formatErrorMessage(error));
      }
    },
    { allowCurrentJob: true },
  ),
};
