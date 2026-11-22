import { validateCronRunParams } from "../../../packages/gateway-protocol/src/index.js";
import { isInvalidCronSessionTargetIdError } from "../../cron/session-target.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { isRecord } from "../../utils.js";
import { getCronManagementAuthority } from "../cron-creator-authority-grant.js";
import { getGatewayProcessInstanceId } from "../process-instance.js";
import { assertCronModelJobAllowed, resolveCronMutationCommitGuard } from "./cron-caller-scope.js";
import { isCronInvalidRequestError } from "./cron-error-classification.js";
import { cronRunQueuesBehindCaller } from "./cron-input-validation.js";
import {
  assertCronReadCurrent,
  respondInvalidCronParams,
  scopedCronJobHandler,
} from "./cron-job-access.js";
import { cronRunsHandler } from "./cron-runs.js";

export const cronRunHandler = scopedCronJobHandler(
  "cron.run",
  validateCronRunParams,
  async (options, { jobId, callerScope, job }) => {
    const {
      params: p,
      respond,
      context,
      client,
      sessionMutationCommitGuard,
      hasCurrentClientAuthority,
    } = options;
    if (
      p.expectedProcessInstanceId &&
      p.expectedProcessInstanceId !== getGatewayProcessInstanceId()
    ) {
      respondInvalidCronParams(respond, "cron.run", "Gateway process changed after preflight");
      return;
    }
    let result: Awaited<ReturnType<typeof context.cron.enqueueRun>>;
    const cfg = context.getRuntimeConfig();
    try {
      assertCronModelJobAllowed(client, cfg, job);
      const commitGuard = resolveCronMutationCommitGuard(
        client,
        context,
        { callerScope, jobId },
        {
          sessionMutationCommitGuard,
          hasCurrentClientAuthority,
          modelJobPolicy: { config: cfg, jobId },
        },
      );
      result = commitGuard
        ? await context.cron.enqueueRun(jobId, p.mode ?? "force", { commitGuard })
        : await context.cron.enqueueRun(jobId, p.mode ?? "force");
    } catch (error) {
      if (error instanceof TypeError) {
        respondInvalidCronParams(respond, "cron.run", formatErrorMessage(error));
        return;
      }
      if (isInvalidCronSessionTargetIdError(error)) {
        respond(true, { ok: true, ran: false, reason: "invalid-spec" }, undefined);
        return;
      }
      if (isCronInvalidRequestError(error)) {
        respondInvalidCronParams(respond, "cron.run", formatErrorMessage(error));
        return;
      }
      throw error;
    }
    const ack = { ...result, processInstanceId: getGatewayProcessInstanceId() };
    const runQueuesBehindCaller =
      p.waitTimeoutMs !== undefined &&
      "enqueued" in result &&
      (await cronRunQueuesBehindCaller({
        job,
        cfg: context.getRuntimeConfig(),
        caller: client?.internal?.agentRuntimeIdentity,
        resolveDefaultAgentId: () => context.cron.getDefaultAgentId(),
      }));
    let run: unknown;
    let finished = false;
    // cron.run stays an enqueue (#40192); waiting is opt-in and bounded by the caller.
    // The outcome is read through cron.runs so it honors the same history visibility.
    if (p.waitTimeoutMs !== undefined && "enqueued" in result && !runQueuesBehindCaller) {
      finished = await context.cron.waitForManualRun(result.runId, p.waitTimeoutMs, options.signal);
    }
    if (finished && "enqueued" in result) {
      try {
        await cronRunsHandler({
          ...options,
          params: { id: jobId, runId: result.runId, limit: 1 },
          respond: (ok, page) => {
            run = ok && isRecord(page) && Array.isArray(page.entries) ? page.entries[0] : undefined;
          },
        });
        // The mutation response skips the read-response guard, so recheck read authority
        // with no await between the check and releasing the outcome.
        assertCronReadCurrent(options);
        const identity = client?.internal?.agentRuntimeIdentity;
        if (identity) {
          getCronManagementAuthority(identity)?.();
        }
      } catch {
        // Authority can lapse during a long wait (grant expiry, revocation). The run is
        // already accepted, so return only its ack and release nothing about the outcome.
        run = undefined;
        finished = false;
      }
    }
    respond(true, run ? { ...ack, run } : finished ? { ...ack, finished } : ack, undefined);
  },
);
