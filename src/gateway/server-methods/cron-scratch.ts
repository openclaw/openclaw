import {
  validateCronScratchGetParams,
  validateCronScratchSetParams,
} from "../../../packages/gateway-protocol/src/index.js";
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

// Migration provenance (sourceSha256) stays internal; the closed result schema
// exposes only content/revision/updatedAtMs.
function publicCronScratch(
  scratch: { content: string; revision: number; updatedAtMs: number } | undefined,
) {
  if (!scratch) {
    return null;
  }
  return {
    content: scratch.content,
    revision: scratch.revision,
    updatedAtMs: scratch.updatedAtMs,
  };
}

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
          scratch: publicCronScratch(state.scratch),
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
      { jobId, callerScope },
    ) => {
      const p = params;
      try {
        const commitGuard = resolveCronMutationCommitGuard(
          client,
          context,
          { callerScope, jobId },
          { sessionMutationCommitGuard, hasCurrentClientAuthority },
        );
        const result = await context.cron.writeScratch(jobId, {
          content: p.content,
          expectedRevision: p.expectedRevision,
          ...(commitGuard ? { commitGuard } : {}),
        });
        if (!result.ok) {
          respond(true, result, undefined);
          return;
        }
        respond(
          true,
          {
            ok: true,
            scratch: publicCronScratch(result.scratch),
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
