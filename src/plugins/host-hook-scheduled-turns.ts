import { randomUUID } from "node:crypto";
import { ADMIN_SCOPE } from "../gateway/operator-scopes.js";
import { formatErrorMessage } from "../infra/errors.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import {
  deletePluginSessionSchedulerJob,
  registerPluginSessionSchedulerJob,
} from "./host-hook-runtime.js";
import type {
  PluginSessionSchedulerJobHandle,
  PluginSessionTurnScheduleParams,
  PluginSessionTurnUnscheduleByTagParams,
  PluginSessionTurnUnscheduleByTagResult,
} from "./host-hooks.js";
import type { PluginOrigin } from "./plugin-origin.types.js";
import type { PluginRegistry } from "./registry-types.js";

const log = createSubsystemLogger("plugins/host-scheduled-turns");
const PLUGIN_CRON_NAME_PREFIX = "plugin:";
const PLUGIN_CRON_TAG_MARKER = ":tag:";

type CallGatewayTool = typeof import("../agents/tools/gateway.js").callGatewayTool;
let callGatewayToolPromise: Promise<CallGatewayTool> | undefined;

type ResolvedSessionTurnSchedule =
  | {
      kind: "cron";
      expr: string;
      tz?: string;
    }
  | {
      kind: "at";
      at: string;
    };

async function callGatewayToolLazy(
  ...args: Parameters<CallGatewayTool>
): Promise<Awaited<ReturnType<CallGatewayTool>>> {
  callGatewayToolPromise ??= import("../agents/tools/gateway.js").then(
    (module) => module.callGatewayTool,
  );
  const callGatewayTool = await callGatewayToolPromise;
  return callGatewayTool(...args);
}

function resolveSchedule(
  params: PluginSessionTurnScheduleParams,
): ResolvedSessionTurnSchedule | undefined {
  const cron = normalizeOptionalString((params as { cron?: unknown }).cron);
  if (cron) {
    const tz = normalizeOptionalString((params as { tz?: unknown }).tz);
    return {
      kind: "cron",
      expr: cron,
      ...(tz ? { tz } : {}),
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
  const rawAt = (params as { at?: unknown }).at;
  const at = rawAt instanceof Date ? rawAt : new Date(rawAt as string | number | Date);
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
    const result = await callGatewayToolLazy(
      "cron.remove",
      {},
      { id: params.jobId },
      { scopes: [ADMIN_SCOPE] },
    );
    return didCronCleanupJob(result);
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

function didCronCleanupJob(value: unknown): boolean {
  const result = unwrapGatewayPayload(value);
  if (!isCronJobRecord(result) || result.ok === false) {
    return false;
  }
  return result.removed === true || result.removed === false;
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

const PLUGIN_CRON_RESERVED_DELIMITER = ":";

function resolvePluginSessionTurnTag(value: unknown): {
  tag?: string;
  invalid: boolean;
} {
  const tag = normalizeOptionalString(value);
  if (!tag) {
    return { invalid: false };
  }
  if (tag.includes(PLUGIN_CRON_RESERVED_DELIMITER)) {
    return { invalid: true };
  }
  return { tag, invalid: false };
}

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
    const listResult = await callGatewayToolLazy(
      "cron.list",
      {},
      {
        includeDisabled: true,
        limit: 200,
        query,
        sortBy: "name",
        sortDir: "asc",
        ...(offset > 0 ? { offset } : {}),
      },
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
  ownerRegistry?: PluginRegistry;
}): Promise<PluginSessionSchedulerJobHandle | undefined> {
  if (params.origin !== "bundled") {
    return undefined;
  }
  const sessionKey = normalizeOptionalString(params.schedule.sessionKey);
  const message = normalizeOptionalString(params.schedule.message);
  if (!sessionKey || !message) {
    return undefined;
  }
  const cronSchedule = resolveSchedule(params.schedule);
  if (!cronSchedule) {
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
  if (cronSchedule.kind === "cron" && params.schedule.deleteAfterRun === true) {
    log.warn(
      `plugin session turn scheduling failed (${formatScheduleLogContext({
        pluginId: params.pluginId,
        sessionKey,
        ...(scheduleName ? { name: scheduleName } : {}),
      })}): deleteAfterRun requires a one-shot schedule`,
    );
    return undefined;
  }
  const { tag, invalid: invalidTag } = resolvePluginSessionTurnTag(params.schedule.tag);
  if (invalidTag) {
    log.warn(
      `plugin session turn scheduling failed (${formatScheduleLogContext({
        pluginId: params.pluginId,
        sessionKey,
        ...(scheduleName ? { name: scheduleName } : {}),
      })}): tag contains reserved delimiter ":"`,
    );
    return undefined;
  }
  const cronDeliveryMode = deliveryMode ?? "announce";
  if (params.shouldCommit && !params.shouldCommit()) {
    return undefined;
  }
  const cronJobName = buildPluginSchedulerCronName({
    pluginId: params.pluginId,
    sessionKey,
    ...(tag !== undefined ? { tag } : {}),
    ...(scheduleName ? { uniqueId: scheduleName } : {}),
  });
  const cronPayload: Record<string, unknown> = {
    kind: "agentTurn",
    message,
  };
  let result: unknown;
  try {
    result = await callGatewayToolLazy(
      "cron.add",
      {},
      {
        name: cronJobName,
        schedule: cronSchedule,
        sessionTarget: `session:${sessionKey}`,
        payload: cronPayload,
        ...(params.schedule.agentId ? { agentId: params.schedule.agentId } : {}),
        deleteAfterRun: params.schedule.deleteAfterRun ?? cronSchedule.kind === "at",
        wakeMode: "now",
        delivery: {
          mode: cronDeliveryMode,
          ...(cronDeliveryMode === "announce" ? { channel: "last" } : {}),
        },
      },
      { scopes: [ADMIN_SCOPE] },
    );
  } catch (error) {
    log.warn(
      `plugin session turn scheduling failed (${formatScheduleLogContext({
        pluginId: params.pluginId,
        sessionKey,
        name: cronJobName,
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
      name: cronJobName,
    });
    if (!removed) {
      log.warn(
        `plugin session turn scheduling rollback failed (${formatScheduleLogContext({
          pluginId: params.pluginId,
          sessionKey,
          name: cronJobName,
          jobId,
        })}): failed to remove stale scheduled session turn`,
      );
    }
    return undefined;
  }
  const handle = registerPluginSessionSchedulerJob({
    pluginId: params.pluginId,
    pluginName: params.pluginName,
    ownerRegistry: params.ownerRegistry,
    job: {
      id: jobId,
      sessionKey,
      kind: "session-turn",
      cleanup: async () => {
        const removed = await removeScheduledSessionTurn({
          jobId,
          pluginId: params.pluginId,
          sessionKey,
          name: cronJobName,
        });
        if (!removed) {
          throw new Error(`failed to remove scheduled session turn: ${jobId}`);
        }
      },
    },
  });
  return handle;
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
  const { tag, invalid: invalidTag } = resolvePluginSessionTurnTag(params.request.tag);
  if (!sessionKey || !tag || invalidTag) {
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
      const result = await callGatewayToolLazy(
        "cron.remove",
        {},
        { id },
        { scopes: [ADMIN_SCOPE] },
      );
      if (didCronRemoveJob(result)) {
        removed += 1;
        deletePluginSessionSchedulerJob({
          pluginId: params.pluginId,
          jobId: id,
          sessionKey,
        });
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
