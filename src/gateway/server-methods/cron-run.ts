import { validateCronRunParams } from "../../../packages/gateway-protocol/src/index.js";
import { cronRunRecordToRunLogEntry } from "../../cron/run-history-detail.js";
import { normalizeCronRunJobId } from "../../cron/run-history.js";
import { canRetryArchivedCronJob } from "../../cron/service/one-shot-schedule.js";
import { isInvalidCronSessionTargetIdError } from "../../cron/session-target.js";
import { cronStoreKey } from "../../cron/store/key.js";
import {
  readCronRunHistoryCandidates,
  readCronRunHistoryRecords,
} from "../../cron/store/read-only.js";
import type { CronStoredJob } from "../../cron/types.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { isRecord } from "../../utils.js";
import { getCronManagementAuthority } from "../cron-creator-authority-grant.js";
import { getGatewayProcessInstanceId } from "../process-instance.js";
import { assertCronModelJobAllowed, resolveCronMutationCommitGuard } from "./cron-caller-scope.js";
import { isCronInvalidRequestError } from "./cron-error-classification.js";
import { cronRunQueuesBehindCaller } from "./cron-input-validation.js";
import {
  assertCronReadCurrent,
  canRetryCronHistory,
  resolveCronJobId,
  respondInvalidCronParams,
  scopedCronJobHandler,
} from "./cron-job-access.js";
import { cronRunsHandler } from "./cron-runs.js";
import type { GatewayRequestHandler } from "./types.js";
import { assertValidParams } from "./validation.js";

const runExistingCronJob = scopedCronJobHandler(
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

export const cronRunHandler: GatewayRequestHandler = async (options) => {
  const { params, client, context, respond } = options;
  if (!isRecord(params) || params.retryRunId === undefined) {
    return await runExistingCronJob(options);
  }
  if (!assertValidParams(params, validateCronRunParams, "cron.run", respond)) {
    return;
  }
  const fail = (reason: string) => respondInvalidCronParams(respond, "cron.run", reason);
  const id = resolveCronJobId(params);
  if (!id || !params.retryRunId || !canRetryCronHistory(client, context)) {
    fail("Retry from Activity requires a Gateway administrator with access to run history");
    return;
  }
  await context.cron.readJob(normalizeCronRunJobId(id));
  const getStoreKey = () => context.cron.getStoreKey?.() ?? cronStoreKey(context.cronStorePath);
  const storeKey = getStoreKey();
  const assertCurrent = () => {
    assertCronReadCurrent(options);
    if (getStoreKey() !== storeKey || !canRetryCronHistory(client, context)) {
      throw new TypeError(
        "The Gateway's automation store or your access changed. Reopen Activity.",
      );
    }
  };
  try {
    const { records } = await readCronRunHistoryCandidates(storeKey, id);
    const matches = records.filter(
      (record) => cronRunRecordToRunLogEntry(record)?.runId === params.retryRunId,
    );
    const [record] =
      matches.length === 1
        ? await readCronRunHistoryRecords(storeKey, [matches[0]!.id], "retry")
        : [];
    assertCurrent();
    if (
      !record ||
      !isRecord(record.detail) ||
      record.detail.retryAvailable !== true ||
      !isRecord(record.detail.archivedJob)
    ) {
      fail("This run no longer has a retryable automation definition");
      return;
    }
    // This private field is written by cron finalization or Doctor, never by RPC callers.
    const job = record.detail.archivedJob as Record<string, unknown> as CronStoredJob;
    if (job.id !== id || !canRetryArchivedCronJob(job)) {
      fail("This automation must be recreated to authorize its execution again");
      return;
    }
    const added = await context.cron.add(
      {
        ...job,
        id: undefined,
        state: undefined,
        enabled: true,
        // A fresh scheduler admission, not a replay of delivery or an old run receipt.
        schedule:
          job.schedule.kind === "at"
            ? { kind: "at", at: new Date(Date.now() + 1_000).toISOString() }
            : job.schedule,
      },
      {
        commitGuard: assertCurrent,
        createdActor: job.createdActor,
        inferenceBinding: job.inferenceBinding,
        scheduledToolPolicy: job.scheduledToolPolicy,
        sourceConversation: job.sourceConversation,
        skillLibrarySelections: job.skillLibrarySelections,
        toolsAllowProvenance: job.toolsAllowProvenance,
      },
    );
    respond(true, { ok: true, scheduled: true, jobId: added.id }, undefined);
  } catch (error) {
    if (error instanceof TypeError || isCronInvalidRequestError(error)) {
      fail(formatErrorMessage(error));
      return;
    }
    throw error;
  }
};
