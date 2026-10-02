import {
  validateCronScratchGetParams,
  validateCronScratchSetParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { cronScratchReadView } from "../../cron/job-read-view.js";
import { CRON_JOB_SCRATCH_MAX_BYTES } from "../../cron/scratch-contract.js";
import { formatErrorMessage } from "../../infra/errors.js";
import {
  cronJobMatchesCallerScope,
  readCronCallerScope,
  resolveCronMutationCommitGuard,
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
  ),
  "cron.scratch.set": scopedCronJobHandler(
    "cron.scratch.set",
    validateCronScratchSetParams,
    async (
      { params, respond, context, client, sessionMutationCommitGuard, hasCurrentClientAuthority },
      { jobId, callerScope, job },
    ) => {
      const p = params;
      // Scratch is appended to the run prompt, so a conversation may not write it under operator
      // authority. The final guard repeats the check on the locked job.
      const operatorOnly = (candidate: { scheduledToolPolicy?: { mode: string } } | undefined) =>
        Boolean(callerScope && !callerScope.manageAll) &&
        candidate?.scheduledToolPolicy?.mode === "trusted";
      const operatorOnlyMessage =
        "This automation runs with operator access, so only a Gateway owner or an operator can change its scratch.";
      if (operatorOnly(job)) {
        respondInvalidCronParams(respond, "cron.scratch.set", operatorOnlyMessage);
        return;
      }
      try {
        const scopeGuard = resolveCronMutationCommitGuard(
          client,
          context,
          { callerScope, jobId },
          { sessionMutationCommitGuard, hasCurrentClientAuthority },
        );
        const commitGuard = () => {
          scopeGuard?.();
          if (operatorOnly(context.cron.getJob(jobId))) {
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
  ),
};
