import { randomUUID } from "node:crypto";
import { callGatewayTool } from "../agents/tools/gateway.js";
import { ADMIN_SCOPE } from "../gateway/operator-scopes.js";
import { formatErrorMessage } from "../infra/errors.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { registerPluginSessionSchedulerJob } from "./host-hook-runtime.js";
import type {
  PluginSessionSchedulerJobHandle,
  PluginSessionTurnScheduleParams,
  PluginSessionTurnUnscheduleByTagParams,
  PluginSessionTurnUnscheduleByTagResult,
} from "./host-hooks.js";
import type { PluginOrigin } from "./plugin-origin.types.js";

const log = createSubsystemLogger("plugins/host-workflow");

function resolveSchedule(params: PluginSessionTurnScheduleParams) {
  if ("cron" in params) {
    return {
      kind: "cron",
      expr: params.cron,
      ...(params.tz ? { tz: params.tz } : {}),
    };
  }
  if ("delayMs" in params) {
    if (!Number.isFinite(params.delayMs) || params.delayMs < 0) {
      return undefined;
    }
    const timestamp = Date.now() + Math.max(1, Math.floor(params.delayMs));
    if (!Number.isFinite(timestamp)) {
      return undefined;
    }
    const at = new Date(timestamp);
    if (!Number.isFinite(at.getTime())) {
      return undefined;
    }
    return { kind: "at", at: at.toISOString() };
  }
  const at = params.at instanceof Date ? params.at : new Date(params.at);
  if (!Number.isFinite(at.getTime())) {
    return undefined;
  }
  return { kind: "at", at: at.toISOString() };
}

function resolveSessionTurnDeliveryMode(deliveryMode: unknown): "none" | "announce" | undefined {
  if (deliveryMode === undefined) {
    return undefined;
  }
  if (deliveryMode === "none" || deliveryMode === "announce") {
    return deliveryMode;
  }
  return undefined;
}

function formatScheduleLogContext(params: {
  pluginId: string;
  sessionKey?: string;
  name?: string;
  jobId?: string;
}): string {
  const parts = [`pluginId=${params.pluginId}`];
  if (params.sessionKey) {
    parts.push(`sessionKey=${params.sessionKey}`);
  }
  if (params.name) {
    parts.push(`name=${params.name}`);
  }
  if (params.jobId) {
    parts.push(`jobId=${params.jobId}`);
  }
  return parts.join(" ");
}

async function removeScheduledSessionTurn(params: {
  jobId: string;
  pluginId: string;
  sessionKey?: string;
  name?: string;
}): Promise<boolean> {
  try {
    const result = await callGatewayTool(
      "cron.remove",
      {},
      { id: params.jobId },
      { scopes: [ADMIN_SCOPE] },
    );
    return didCronRemoveJob(result);
  } catch (error) {
    log.warn(
      `plugin session turn cleanup failed (${formatScheduleLogContext(params)}): ${formatErrorMessage(error)}`,
    );
    return false;
  }
}

function unwrapGatewayPayload(value: unknown): unknown {
  if (!isCronJobRecord(value)) {
    return value;
  }
  const payload = value.payload;
  return isCronJobRecord(payload) ? payload : value;
}

function didCronRemoveJob(value: unknown): boolean {
  const result = unwrapGatewayPayload(value);
  if (!isCronJobRecord(result)) {
    return false;
  }
  return result.ok !== false && result.removed === true;
}

function normalizeCronJobId(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function extractCronJobId(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const topLevelId = normalizeCronJobId(record.jobId ?? record.id);
  if (topLevelId) {
    return topLevelId;
  }
  const payload =
    record.payload && typeof record.payload === "object"
      ? (record.payload as Record<string, unknown>)
      : record;
  return normalizeCronJobId(payload.jobId ?? payload.id);
}

const PLUGIN_CRON_NAME_PREFIX = "plugin:";
const PLUGIN_CRON_TAG_MARKER = ":tag:";

export function buildPluginSchedulerCronName(params: {
  pluginId: string;
  sessionKey: string;
  tag?: string;
  uniqueId?: string;
}): string {
  const uniqueId = params.uniqueId ?? randomUUID();
  if (!params.tag) {
    return `${PLUGIN_CRON_NAME_PREFIX}${params.pluginId}:${params.sessionKey}:${uniqueId}`;
  }
  return `${PLUGIN_CRON_NAME_PREFIX}${params.pluginId}${PLUGIN_CRON_TAG_MARKER}${params.tag}:${params.sessionKey}:${uniqueId}`;
}

function buildPluginSchedulerTagPrefix(params: {
  pluginId: string;
  tag: string;
  sessionKey: string;
}): string {
  return `${PLUGIN_CRON_NAME_PREFIX}${params.pluginId}${PLUGIN_CRON_TAG_MARKER}${params.tag}:${params.sessionKey}:`;
}

function isCronJobRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readCronListJobs(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    return value.filter(isCronJobRecord);
  }
  if (isCronJobRecord(value)) {
    const jobs = (value as { jobs?: unknown }).jobs;
    if (Array.isArray(jobs)) {
      return jobs.filter(isCronJobRecord);
    }
  }
  return [];
}

function readCronListNextOffset(value: unknown): number | undefined {
  if (!isCronJobRecord(value)) {
    return undefined;
  }
  const nextOffset = value.nextOffset;
  return typeof nextOffset === "number" && Number.isInteger(nextOffset) && nextOffset >= 0
    ? nextOffset
    : undefined;
}

function readCronListHasMore(value: unknown): boolean {
  return isCronJobRecord(value) && value.hasMore === true;
}

async function listAllCronJobsForPluginTagCleanup(
  query: string,
): Promise<Record<string, unknown>[]> {
  const jobs: Record<string, unknown>[] = [];
  let offset = 0;
  for (;;) {
    const listResult = await callGatewayTool(
      "cron.list",
      {},
      { includeDisabled: true, limit: 200, query, ...(offset > 0 ? { offset } : {}) },
      { scopes: [ADMIN_SCOPE] },
    );
    jobs.push(...readCronListJobs(listResult));
    if (!readCronListHasMore(listResult)) {
      return jobs;
    }
    const nextOffset = readCronListNextOffset(listResult);
    if (nextOffset === undefined || nextOffset <= offset) {
      return jobs;
    }
    offset = nextOffset;
  }
}

export async function schedulePluginSessionTurn(params: {
  pluginId: string;
  pluginName?: string;
  origin?: PluginOrigin;
  schedule: PluginSessionTurnScheduleParams;
  shouldCommit?: () => boolean;
}): Promise<PluginSessionSchedulerJobHandle | undefined> {
  if (params.origin !== "bundled") {
    return undefined;
  }
  const sessionKey = normalizeOptionalString(params.schedule.sessionKey);
  const message = normalizeOptionalString(params.schedule.message);
  if (!sessionKey || !message) {
    return undefined;
  }
  const schedule = resolveSchedule(params.schedule);
  if (!schedule) {
    return undefined;
  }
  const rawDeliveryMode = (params.schedule as { deliveryMode?: unknown }).deliveryMode;
  const deliveryMode = resolveSessionTurnDeliveryMode(rawDeliveryMode);
  const scheduleName = normalizeOptionalString(params.schedule.name);
  if (rawDeliveryMode !== undefined && !deliveryMode) {
    log.warn(
      `plugin session turn scheduling failed (${formatScheduleLogContext({
        pluginId: params.pluginId,
        sessionKey,
        ...(scheduleName ? { name: scheduleName } : {}),
      })}): unsupported deliveryMode`,
    );
    return undefined;
  }
  if (params.shouldCommit && !params.shouldCommit()) {
    return undefined;
  }
  const tag = normalizeOptionalString(params.schedule.tag);
  const name =
    tag !== undefined
      ? buildPluginSchedulerCronName({
          pluginId: params.pluginId,
          sessionKey,
          tag,
          uniqueId: scheduleName,
        })
      : (scheduleName ??
        buildPluginSchedulerCronName({
          pluginId: params.pluginId,
          sessionKey,
        }));
  const payload: Record<string, unknown> = {
    kind: "agentTurn",
    message,
  };
  let result: unknown;
  try {
    result = await callGatewayTool(
      "cron.add",
      {},
      {
        name,
        schedule,
        sessionTarget: `session:${sessionKey}`,
        payload,
        ...(params.schedule.agentId ? { agentId: params.schedule.agentId } : {}),
        deleteAfterRun: params.schedule.deleteAfterRun ?? schedule.kind === "at",
        wakeMode: "now",
        ...(deliveryMode
          ? {
              delivery: {
                mode: deliveryMode,
                ...(deliveryMode === "announce" ? { channel: "last" } : {}),
              },
            }
          : {}),
      },
      { scopes: [ADMIN_SCOPE] },
    );
  } catch (error) {
    log.warn(
      `plugin session turn scheduling failed (${formatScheduleLogContext({
        pluginId: params.pluginId,
        sessionKey,
        name,
      })}): ${formatErrorMessage(error)}`,
    );
    return undefined;
  }
  const jobId = extractCronJobId(result);
  if (!jobId) {
    return undefined;
  }
  if (params.shouldCommit && !params.shouldCommit()) {
    const removed = await removeScheduledSessionTurn({
      jobId,
      pluginId: params.pluginId,
      sessionKey,
      name,
    });
    if (!removed) {
      throw new Error(`failed to remove stale scheduled session turn: ${jobId}`);
    }
    return undefined;
  }
  return registerPluginSessionSchedulerJob({
    pluginId: params.pluginId,
    pluginName: params.pluginName,
    job: {
      id: jobId,
      sessionKey,
      kind: "session-turn",
      cleanup: async () => {
        const removed = await removeScheduledSessionTurn({
          jobId,
          pluginId: params.pluginId,
          sessionKey,
          name,
        });
        if (!removed) {
          throw new Error(`failed to remove scheduled session turn: ${jobId}`);
        }
      },
    },
  });
}

export async function unschedulePluginSessionTurnsByTag(params: {
  pluginId: string;
  origin?: PluginOrigin;
  request: PluginSessionTurnUnscheduleByTagParams;
}): Promise<PluginSessionTurnUnscheduleByTagResult> {
  if (params.origin !== "bundled") {
    return { removed: 0, failed: 0 };
  }
  const sessionKey = normalizeOptionalString(params.request.sessionKey);
  const tag = normalizeOptionalString(params.request.tag);
  if (!sessionKey || !tag) {
    return { removed: 0, failed: 0 };
  }
  const namePrefix = buildPluginSchedulerTagPrefix({
    pluginId: params.pluginId,
    tag,
    sessionKey,
  });
  let jobs: Record<string, unknown>[];
  try {
    jobs = await listAllCronJobsForPluginTagCleanup(namePrefix);
  } catch (error) {
    log.warn(`plugin session turn untag-list failed: ${formatErrorMessage(error)}`);
    return { removed: 0, failed: 1 };
  }
  const candidates = jobs.filter((job) => {
    const name = typeof job.name === "string" ? job.name : "";
    const target = typeof job.sessionTarget === "string" ? job.sessionTarget : "";
    return name.startsWith(namePrefix) && target === `session:${sessionKey}`;
  });
  let removed = 0;
  let failed = 0;
  for (const job of candidates) {
    const id = typeof job.id === "string" ? job.id.trim() : "";
    if (!id) {
      continue;
    }
    try {
      const result = await callGatewayTool("cron.remove", {}, { id }, { scopes: [ADMIN_SCOPE] });
      if (didCronRemoveJob(result)) {
        removed += 1;
      } else {
        failed += 1;
      }
    } catch (error) {
      log.warn(
        `plugin session turn untag-remove failed: id=${id} error=${formatErrorMessage(error)}`,
      );
      failed += 1;
    }
  }
  return { removed, failed };
}
