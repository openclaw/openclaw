import { randomUUID } from "node:crypto";
import { normalizeCronJobCreate, normalizeCronJobPatch } from "../../cron/normalize.js";
import {
  readCronRunLogEntriesPage,
  readCronRunLogEntriesPageAll,
  resolveCronRunLogPath,
} from "../../cron/run-log.js";
import type { CronJobCreate, CronJobPatch } from "../../cron/types.js";
import { validateScheduleTimestamp } from "../../cron/validate-timestamp.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateCronAddParams,
  validateCronListParams,
  validateCronRemoveParams,
  validateCronRunParams,
  validateCronRunsParams,
  validateCronStatusParams,
  validateCronUpdateParams,
  validateWakeParams,
} from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";

const CRON_FORCE_RUN_DEDUPE_WINDOW_MS = 60_000;
const CRON_TRANSPORT_TIMEOUT_ERROR = "GATEWAY_TRANSPORT_TIMEOUT";
const CRON_RUN_NOT_ACCEPTED_ERROR = "RUN_NOT_ACCEPTED";
const CRON_RUN_EXECUTION_FAILURE_ERROR = "CRON_RUN_EXECUTION_FAILURE";

type CronRunAcceptedPayload = {
  ok: true;
  ran: true;
  accepted: true;
  status: "accepted";
  requestId: string;
  runId: string;
  jobId: string;
  mode: "due" | "force";
  queuedAt: number;
  deduped: boolean;
  errorType: null;
  transportErrorType: typeof CRON_TRANSPORT_TIMEOUT_ERROR;
  enqueueErrorType: typeof CRON_RUN_NOT_ACCEPTED_ERROR;
  executionErrorType: typeof CRON_RUN_EXECUTION_FAILURE_ERROR;
  reconcile: {
    method: "cron.runs";
    params: { id: string; runId: string; limit: 1 };
  };
  note: string;
};

type CronRunNotAcceptedPayload = {
  ok: false;
  ran: false;
  accepted: false;
  status: "not-accepted";
  requestId: null;
  runId: null;
  jobId: string;
  mode: "due" | "force";
  queuedAt: number;
  deduped: false;
  errorType: typeof CRON_RUN_NOT_ACCEPTED_ERROR;
  errorMessage: string;
  reconcile: {
    method: "cron.runs";
    params: { id: string; limit: 1 };
  };
};

function buildAcceptedCronRunPayload(params: {
  requestId: string;
  runId: string;
  jobId: string;
  mode: "due" | "force";
  queuedAt: number;
  deduped?: boolean;
  note?: string;
}): CronRunAcceptedPayload {
  return {
    ok: true,
    ran: true,
    accepted: true,
    status: "accepted",
    requestId: params.requestId,
    runId: params.runId,
    jobId: params.jobId,
    mode: params.mode,
    queuedAt: params.queuedAt,
    deduped: params.deduped === true,
    errorType: null,
    transportErrorType: CRON_TRANSPORT_TIMEOUT_ERROR,
    enqueueErrorType: CRON_RUN_NOT_ACCEPTED_ERROR,
    executionErrorType: CRON_RUN_EXECUTION_FAILURE_ERROR,
    reconcile: {
      method: "cron.runs",
      params: {
        id: params.jobId,
        runId: params.runId,
        limit: 1,
      },
    },
    note:
      params.note ??
      "If transport times out after acceptance, reconcile once via cron.runs using jobId+runId.",
  };
}

function buildNotAcceptedCronRunPayload(params: {
  jobId: string;
  mode: "due" | "force";
  queuedAt: number;
  errorMessage: string;
}): CronRunNotAcceptedPayload {
  return {
    ok: false,
    ran: false,
    accepted: false,
    status: "not-accepted",
    requestId: null,
    runId: null,
    jobId: params.jobId,
    mode: params.mode,
    queuedAt: params.queuedAt,
    deduped: false,
    errorType: CRON_RUN_NOT_ACCEPTED_ERROR,
    errorMessage: params.errorMessage,
    reconcile: {
      method: "cron.runs",
      params: {
        id: params.jobId,
        limit: 1,
      },
    },
  };
}

export const cronHandlers: GatewayRequestHandlers = {
  wake: ({ params, respond, context }) => {
    if (!validateWakeParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid wake params: ${formatValidationErrors(validateWakeParams.errors)}`,
        ),
      );
      return;
    }
    const p = params as {
      mode: "now" | "next-heartbeat";
      text: string;
    };
    const result = context.cron.wake({ mode: p.mode, text: p.text });
    respond(true, result, undefined);
  },
  "cron.list": async ({ params, respond, context }) => {
    if (!validateCronListParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid cron.list params: ${formatValidationErrors(validateCronListParams.errors)}`,
        ),
      );
      return;
    }
    const p = params as {
      includeDisabled?: boolean;
      limit?: number;
      offset?: number;
      query?: string;
      enabled?: "all" | "enabled" | "disabled";
      sortBy?: "nextRunAtMs" | "updatedAtMs" | "name";
      sortDir?: "asc" | "desc";
    };
    const page = await context.cron.listPage({
      includeDisabled: p.includeDisabled,
      limit: p.limit,
      offset: p.offset,
      query: p.query,
      enabled: p.enabled,
      sortBy: p.sortBy,
      sortDir: p.sortDir,
    });
    respond(true, page, undefined);
  },
  "cron.status": async ({ params, respond, context }) => {
    if (!validateCronStatusParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid cron.status params: ${formatValidationErrors(validateCronStatusParams.errors)}`,
        ),
      );
      return;
    }
    const status = await context.cron.status();
    respond(true, status, undefined);
  },
  "cron.add": async ({ params, respond, context }) => {
    const normalized = normalizeCronJobCreate(params) ?? params;
    if (!validateCronAddParams(normalized)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid cron.add params: ${formatValidationErrors(validateCronAddParams.errors)}`,
        ),
      );
      return;
    }
    const jobCreate = normalized as unknown as CronJobCreate;
    const timestampValidation = validateScheduleTimestamp(jobCreate.schedule);
    if (!timestampValidation.ok) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, timestampValidation.message),
      );
      return;
    }
    const job = await context.cron.add(jobCreate);
    respond(true, job, undefined);
  },
  "cron.update": async ({ params, respond, context }) => {
    const normalizedPatch = normalizeCronJobPatch((params as { patch?: unknown } | null)?.patch);
    const candidate =
      normalizedPatch && typeof params === "object" && params !== null
        ? { ...params, patch: normalizedPatch }
        : params;
    if (!validateCronUpdateParams(candidate)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid cron.update params: ${formatValidationErrors(validateCronUpdateParams.errors)}`,
        ),
      );
      return;
    }
    const p = candidate as {
      id?: string;
      jobId?: string;
      patch: Record<string, unknown>;
    };
    const jobId = p.id ?? p.jobId;
    if (!jobId) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "invalid cron.update params: missing id"),
      );
      return;
    }
    const patch = p.patch as unknown as CronJobPatch;
    if (patch.schedule) {
      const timestampValidation = validateScheduleTimestamp(patch.schedule);
      if (!timestampValidation.ok) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, timestampValidation.message),
        );
        return;
      }
    }
    const job = await context.cron.update(jobId, patch);
    respond(true, job, undefined);
  },
  "cron.remove": async ({ params, respond, context }) => {
    if (!validateCronRemoveParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid cron.remove params: ${formatValidationErrors(validateCronRemoveParams.errors)}`,
        ),
      );
      return;
    }
    const p = params as { id?: string; jobId?: string };
    const jobId = p.id ?? p.jobId;
    if (!jobId) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "invalid cron.remove params: missing id"),
      );
      return;
    }
    const result = await context.cron.remove(jobId);
    respond(true, result, undefined);
  },
  "cron.run": async ({ params, respond, context }) => {
    if (!validateCronRunParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid cron.run params: ${formatValidationErrors(validateCronRunParams.errors)}`,
        ),
      );
      return;
    }
    const p = params as { id?: string; jobId?: string; mode?: "due" | "force" };
    const jobId = p.id ?? p.jobId;
    const mode = p.mode ?? "force";
    if (!jobId) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "invalid cron.run params: missing id"),
      );
      return;
    }

    const jobs = await context.cron.list({ includeDisabled: true });
    const job = jobs.find((entry) => entry.id === jobId);
    const now = Date.now();
    if (!job) {
      respond(
        true,
        buildNotAcceptedCronRunPayload({
          jobId,
          mode,
          queuedAt: now,
          errorMessage: `job not found: ${jobId}`,
        }),
        undefined,
      );
      return;
    }

    const dedupeKey = `cron.run:force:${jobId}`;
    if (mode === "force") {
      const cached = context.dedupe.get(dedupeKey);
      const cachedPayload =
        cached && typeof cached.payload === "object" && cached.payload !== null
          ? (cached.payload as Partial<CronRunAcceptedPayload>)
          : null;
      if (
        cached &&
        cached.ok &&
        cachedPayload?.requestId &&
        cachedPayload?.runId &&
        now - cached.ts <= CRON_FORCE_RUN_DEDUPE_WINDOW_MS
      ) {
        respond(
          true,
          buildAcceptedCronRunPayload({
            requestId: cachedPayload.requestId,
            runId: cachedPayload.runId,
            jobId,
            mode,
            queuedAt:
              typeof cachedPayload.queuedAt === "number" && Number.isFinite(cachedPayload.queuedAt)
                ? cachedPayload.queuedAt
                : cached.ts,
            deduped: true,
            note: `Duplicate manual force run suppressed for ${CRON_FORCE_RUN_DEDUPE_WINDOW_MS}ms window.`,
          }),
          undefined,
        );
        return;
      }
    }

    if (typeof job.state.runningAtMs === "number") {
      respond(
        true,
        buildNotAcceptedCronRunPayload({
          jobId,
          mode,
          queuedAt: now,
          errorMessage: `job already running: ${jobId}`,
        }),
        undefined,
      );
      return;
    }

    if (mode === "due") {
      const nextRunAtMs = job.state.nextRunAtMs;
      const hasValidNextRun =
        typeof nextRunAtMs === "number" && Number.isFinite(nextRunAtMs) && nextRunAtMs > 0;
      const due = job.enabled && hasValidNextRun && now >= nextRunAtMs;
      if (!due) {
        const errorMessage = !job.enabled
          ? `job is disabled: ${jobId}`
          : hasValidNextRun
            ? `job not due yet (nextRunAtMs=${nextRunAtMs})`
            : `job has no due schedule: ${jobId}`;
        respond(
          true,
          buildNotAcceptedCronRunPayload({
            jobId,
            mode,
            queuedAt: now,
            errorMessage,
          }),
          undefined,
        );
        return;
      }
    }

    const requestId = randomUUID();
    const runId = requestId;
    const acceptedPayload = buildAcceptedCronRunPayload({
      requestId,
      runId,
      jobId,
      mode,
      queuedAt: now,
      deduped: false,
    });
    if (mode === "force") {
      context.dedupe.set(dedupeKey, { ts: now, ok: true, payload: acceptedPayload });
    }

    respond(true, acceptedPayload, undefined);

    void context.cron
      .run(jobId, mode, { runId })
      .then((result) => {
        if (!result.ok || !result.ran) {
          if (mode === "force") {
            context.dedupe.delete(dedupeKey);
          }
          const reason = "reason" in result ? result.reason : "unknown";
          context.logGateway.warn(
            `cron.run accepted but not executed (requestId=${requestId}, jobId=${jobId}, reason=${String(reason)})`,
          );
        }
      })
      .catch((err) => {
        if (mode === "force") {
          context.dedupe.delete(dedupeKey);
        }
        context.logGateway.error(
          `cron.run accepted execution failed (requestId=${requestId}, jobId=${jobId}): ${String(err)}`,
        );
      });
  },
  "cron.runs": async ({ params, respond, context }) => {
    if (!validateCronRunsParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid cron.runs params: ${formatValidationErrors(validateCronRunsParams.errors)}`,
        ),
      );
      return;
    }
    const p = params as {
      scope?: "job" | "all";
      id?: string;
      jobId?: string;
      runId?: string;
      limit?: number;
      offset?: number;
      statuses?: Array<"ok" | "error" | "skipped">;
      status?: "all" | "ok" | "error" | "skipped";
      deliveryStatuses?: Array<"delivered" | "not-delivered" | "unknown" | "not-requested">;
      deliveryStatus?: "delivered" | "not-delivered" | "unknown" | "not-requested";
      query?: string;
      sortDir?: "asc" | "desc";
    };
    const explicitScope = p.scope;
    const jobId = p.id ?? p.jobId;
    const scope: "job" | "all" = explicitScope ?? (jobId ? "job" : "all");
    if (scope === "job" && !jobId) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "invalid cron.runs params: missing id"),
      );
      return;
    }
    if (scope === "all") {
      const jobs = await context.cron.list({ includeDisabled: true });
      const jobNameById = Object.fromEntries(
        jobs
          .filter((job) => typeof job.id === "string" && typeof job.name === "string")
          .map((job) => [job.id, job.name]),
      );
      const page = await readCronRunLogEntriesPageAll({
        storePath: context.cronStorePath,
        limit: p.limit,
        offset: p.offset,
        statuses: p.statuses,
        status: p.status,
        deliveryStatuses: p.deliveryStatuses,
        deliveryStatus: p.deliveryStatus,
        runId: p.runId,
        query: p.query,
        sortDir: p.sortDir,
        jobNameById,
      });
      respond(true, page, undefined);
      return;
    }
    let logPath: string;
    try {
      logPath = resolveCronRunLogPath({
        storePath: context.cronStorePath,
        jobId: jobId as string,
      });
    } catch {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "invalid cron.runs params: invalid id"),
      );
      return;
    }
    const page = await readCronRunLogEntriesPage(logPath, {
      limit: p.limit,
      offset: p.offset,
      jobId: jobId as string,
      statuses: p.statuses,
      status: p.status,
      deliveryStatuses: p.deliveryStatuses,
      deliveryStatus: p.deliveryStatus,
      runId: p.runId,
      query: p.query,
      sortDir: p.sortDir,
    });
    respond(true, page, undefined);
  },
};
