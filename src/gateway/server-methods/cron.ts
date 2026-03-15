import { loadConfig } from "../../config/config.js";
import { normalizeCronJobCreate, normalizeCronJobPatch } from "../../cron/normalize.js";
import {
  readCronRunLogEntriesPage,
  readCronRunLogEntriesPageAll,
  resolveCronRunLogPath,
} from "../../cron/run-log.js";
import type { CronJobCreate, CronJobPatch } from "../../cron/types.js";
import { validateScheduleTimestamp } from "../../cron/validate-timestamp.js";
import { listConfiguredMessageChannels } from "../../infra/outbound/channel-selection.js";
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

/**
 * Checks whether a delivery/failureDestination block is ambiguous for announce
 * mode when multiple channels are configured.
 */
function isAnnounceWithoutChannel(delivery: Record<string, unknown>): boolean {
  const mode = typeof delivery.mode === "string" ? delivery.mode.trim().toLowerCase() : undefined;
  if (mode !== "announce") {
    return false;
  }
  return !(typeof delivery.channel === "string" && delivery.channel.trim());
}

/**
 * Validates that announce-mode delivery has an explicit channel when multiple
 * channels are configured. Without this, delivery silently fails at runtime
 * because the "last" channel fallback cannot resolve an unambiguous target.
 * See: https://github.com/openclaw/openclaw/issues/47524
 */
async function validateDeliveryChannelForAnnounce(
  delivery: Record<string, unknown> | undefined,
): Promise<string | null> {
  if (!delivery || typeof delivery !== "object") {
    return null;
  }
  // Check top-level delivery
  const needsChannel = isAnnounceWithoutChannel(delivery);
  // Check failureDestination
  const failureDest = delivery.failureDestination as Record<string, unknown> | undefined;
  const failureNeedsChannel =
    failureDest && typeof failureDest === "object" && isAnnounceWithoutChannel(failureDest);
  if (!needsChannel && !failureNeedsChannel) {
    return null;
  }
  // Both paths need the channel list — fetch once
  try {
    const cfg = loadConfig();
    const configured = await listConfiguredMessageChannels(cfg);
    if (configured.length > 1) {
      if (needsChannel && failureNeedsChannel) {
        return `delivery.channel and delivery.failureDestination.channel are both required when mode is "announce" and multiple channels are configured (${configured.join(", ")}). Set --channel explicitly.`;
      }
      const field = needsChannel ? "delivery.channel" : "delivery.failureDestination.channel";
      return `${field} is required when mode is "announce" and multiple channels are configured (${configured.join(", ")}). Set --channel explicitly.`;
    }
    return null;
  } catch {
    // Fail open: if we cannot load config, don't block the request
    return null;
  }
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
    const sessionKey =
      typeof (params as { sessionKey?: unknown } | null)?.sessionKey === "string"
        ? (params as { sessionKey: string }).sessionKey
        : undefined;
    const normalized =
      normalizeCronJobCreate(params, {
        sessionContext: { sessionKey },
      }) ?? params;
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
    const deliveryChannelError = await validateDeliveryChannelForAnnounce(
      (jobCreate as { delivery?: Record<string, unknown> }).delivery,
    );
    if (deliveryChannelError) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, deliveryChannelError));
      return;
    }
    const job = await context.cron.add(jobCreate);
    context.logGateway.info("cron: job created", { jobId: job.id, schedule: jobCreate.schedule });
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
    if (patch.delivery) {
      // Merge with existing delivery so partial patches (e.g. { channel: "" }) don't
      // bypass validation when the stored job already has mode "announce".
      const existing = context.cron.getJob(jobId);
      const effectiveDelivery = {
        ...(existing?.delivery as Record<string, unknown> | undefined),
        ...patch.delivery,
      } as Record<string, unknown>;
      // Merge failureDestination too
      if (
        patch.delivery.failureDestination &&
        existing?.delivery?.failureDestination &&
        typeof patch.delivery.failureDestination === "object"
      ) {
        effectiveDelivery.failureDestination = {
          ...(existing.delivery.failureDestination as Record<string, unknown>),
          ...(patch.delivery.failureDestination as Record<string, unknown>),
        };
      }
      const deliveryChannelError = await validateDeliveryChannelForAnnounce(effectiveDelivery);
      if (deliveryChannelError) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, deliveryChannelError));
        return;
      }
    }
    const job = await context.cron.update(jobId, patch);
    context.logGateway.info("cron: job updated", { jobId });
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
    if (result.removed) {
      context.logGateway.info("cron: job removed", { jobId });
    }
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
    if (!jobId) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "invalid cron.run params: missing id"),
      );
      return;
    }
    const result = await context.cron.enqueueRun(jobId, p.mode ?? "force");
    respond(true, result, undefined);
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
      query: p.query,
      sortDir: p.sortDir,
    });
    respond(true, page, undefined);
  },
};
