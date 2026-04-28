import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { callGatewayTool } from "../agents/tools/gateway.js";
import { extractDeliveryInfo } from "../config/sessions/delivery-info.js";
import { ADMIN_SCOPE } from "../gateway/operator-scopes.js";
import { emitAgentEvent } from "../infra/agent-events.js";
import { formatErrorMessage } from "../infra/errors.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { registerPluginSessionSchedulerJob } from "./host-hook-runtime.js";
import {
  isPluginJsonValue,
  type PluginAgentEventEmitParams,
  type PluginAgentEventEmitResult,
  type PluginJsonValue,
  type PluginSessionAttachmentParams,
  type PluginSessionAttachmentResult,
  type PluginSessionSchedulerJobHandle,
  type PluginSessionTurnScheduleParams,
} from "./host-hooks.js";
import type { PluginOrigin } from "./plugin-origin.types.js";

const DEFAULT_ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;
const MAX_ATTACHMENT_FILES = 10;
const PLUGIN_AGENT_EVENT_STREAM_PREFIX = "plugin.";
const log = createSubsystemLogger("plugins/host-workflow");
type SendMessage = typeof import("../infra/outbound/message.js").sendMessage;
let sendMessagePromise: Promise<SendMessage> | undefined;

async function loadSendMessage(): Promise<SendMessage> {
  sendMessagePromise ??= import("../infra/outbound/message.js").then(
    (module) => module.sendMessage,
  );
  return sendMessagePromise;
}

function normalizePluginEventData(params: {
  pluginId: string;
  pluginName?: string;
  data: PluginJsonValue;
}): Record<string, unknown> {
  if (params.data && typeof params.data === "object" && !Array.isArray(params.data)) {
    return {
      ...params.data,
      pluginId: params.pluginId,
      ...(params.pluginName ? { pluginName: params.pluginName } : {}),
    };
  }
  return {
    value: params.data,
    pluginId: params.pluginId,
    ...(params.pluginName ? { pluginName: params.pluginName } : {}),
  };
}

function isPluginOwnedAgentEventStream(stream: string): boolean {
  return (
    stream.startsWith(PLUGIN_AGENT_EVENT_STREAM_PREFIX) &&
    stream.length > PLUGIN_AGENT_EVENT_STREAM_PREFIX.length
  );
}

export function emitPluginAgentEvent(params: {
  pluginId: string;
  pluginName?: string;
  event: PluginAgentEventEmitParams;
}): PluginAgentEventEmitResult {
  const runId = normalizeOptionalString(params.event.runId);
  const stream = normalizeOptionalString(params.event.stream);
  if (!runId || !stream) {
    return { emitted: false, reason: "runId and stream are required" };
  }
  if (!isPluginJsonValue(params.event.data)) {
    return { emitted: false, reason: "event data must be JSON-compatible" };
  }
  if (!isPluginOwnedAgentEventStream(stream)) {
    return {
      emitted: false,
      reason: `plugin-emitted streams must use plugin.* namespace: ${stream}`,
    };
  }
  emitAgentEvent({
    runId,
    stream,
    ...(params.event.sessionKey ? { sessionKey: params.event.sessionKey } : {}),
    data: normalizePluginEventData({
      pluginId: params.pluginId,
      pluginName: params.pluginName,
      data: params.event.data,
    }),
  });
  return { emitted: true, stream };
}

async function validateAttachmentFiles(
  files: PluginSessionAttachmentParams["files"],
  maxBytes: number,
): Promise<string[] | { error: string }> {
  if (files.length > MAX_ATTACHMENT_FILES) {
    return { error: `at most ${MAX_ATTACHMENT_FILES} attachment files are allowed` };
  }
  const paths: string[] = [];
  let totalBytes = 0;
  for (const file of files) {
    if (!file || typeof file !== "object" || Array.isArray(file)) {
      return { error: "attachment file entry must be an object" };
    }
    const filePath = normalizeOptionalString((file as { path?: unknown }).path);
    if (!filePath) {
      return { error: "attachment file path is required" };
    }
    const info = await stat(filePath).catch(() => undefined);
    if (!info?.isFile()) {
      return { error: `attachment file not found: ${filePath}` };
    }
    if (info.size > maxBytes) {
      return { error: `attachment file exceeds ${maxBytes} bytes: ${filePath}` };
    }
    totalBytes += info.size;
    if (totalBytes > maxBytes) {
      return { error: `attachment files exceed ${maxBytes} bytes total` };
    }
    paths.push(filePath);
  }
  return paths;
}

export async function sendPluginSessionAttachment(
  params: PluginSessionAttachmentParams & { origin?: PluginOrigin },
): Promise<PluginSessionAttachmentResult> {
  if (params.origin !== "bundled") {
    return { ok: false, error: "session attachments are restricted to bundled plugins" };
  }
  const sessionKey = normalizeOptionalString(params.sessionKey);
  if (!sessionKey) {
    return { ok: false, error: "sessionKey is required" };
  }
  if (!Array.isArray(params.files) || params.files.length === 0) {
    return { ok: false, error: "at least one attachment file is required" };
  }
  const maxBytes =
    typeof params.maxBytes === "number" && Number.isFinite(params.maxBytes)
      ? Math.min(DEFAULT_ATTACHMENT_MAX_BYTES, Math.max(1, Math.floor(params.maxBytes)))
      : DEFAULT_ATTACHMENT_MAX_BYTES;
  const validated = await validateAttachmentFiles(params.files, maxBytes);
  if (!Array.isArray(validated)) {
    return { ok: false, error: validated.error };
  }
  const { deliveryContext, threadId } = extractDeliveryInfo(sessionKey);
  if (!deliveryContext?.channel || !deliveryContext.to) {
    return { ok: false, error: `session has no active delivery route: ${sessionKey}` };
  }
  const text = normalizeOptionalString(params.text) ?? "";
  const explicitThreadId = normalizeOptionalString(params.threadId);
  const deliveryThreadId = normalizeOptionalString(deliveryContext.threadId);
  const fallbackThreadId = normalizeOptionalString(threadId);
  let result: Awaited<ReturnType<SendMessage>>;
  try {
    const sendMessage = await loadSendMessage();
    result = await sendMessage({
      to: deliveryContext.to,
      content: text,
      channel: deliveryContext.channel,
      accountId: deliveryContext.accountId,
      threadId: explicitThreadId ?? deliveryThreadId ?? fallbackThreadId,
      requesterSessionKey: sessionKey,
      mediaUrls: validated,
      forceDocument: params.forceDocument,
    });
  } catch (error) {
    return { ok: false, error: `attachment delivery failed: ${formatErrorMessage(error)}` };
  }
  return {
    ok: true,
    channel: result.channel,
    deliveredTo: deliveryContext.to,
    count: validated.length,
  };
}

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
    await callGatewayTool("cron.remove", {}, { id: params.jobId }, { scopes: [ADMIN_SCOPE] });
    return true;
  } catch (error) {
    log.warn(
      `plugin session turn cleanup failed (${formatScheduleLogContext(params)}): ${formatErrorMessage(error)}`,
    );
    return false;
  }
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

function normalizeCronJobId(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
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
  const name = scheduleName ?? `plugin:${params.pluginId}:${sessionKey}:${randomUUID()}`;
  let result: unknown;
  try {
    result = await callGatewayTool(
      "cron.add",
      {},
      {
        name,
        schedule,
        sessionTarget: `session:${sessionKey}`,
        payload: {
          kind: "agentTurn",
          message,
        },
        ...(params.schedule.agentId ? { agentId: params.schedule.agentId } : {}),
        deleteAfterRun: params.schedule.deleteAfterRun ?? schedule.kind === "at",
        wakeMode: "now",
        ...(deliveryMode ? { delivery: { mode: deliveryMode } } : {}),
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
    await removeScheduledSessionTurn({
      jobId,
      pluginId: params.pluginId,
      sessionKey,
      name,
    });
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
