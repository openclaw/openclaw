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

function isTerminalLifecyclePluginEvent(data: PluginJsonValue): boolean {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return false;
  }
  const phase = data.phase;
  return phase === "end" || phase === "error";
}

export function emitPluginAgentEvent(params: {
  pluginId: string;
  pluginName?: string;
  origin: PluginOrigin;
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
  if (params.origin !== "bundled" && (stream === "lifecycle" || stream === "model")) {
    return { emitted: false, reason: `stream ${stream} is reserved for bundled plugins` };
  }
  if (stream === "lifecycle" && isTerminalLifecyclePluginEvent(params.event.data)) {
    return { emitted: false, reason: "terminal lifecycle events are host-owned" };
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
  const paths: string[] = [];
  for (const file of files) {
    const filePath = normalizeOptionalString(file.path);
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
      ? Math.max(1, Math.floor(params.maxBytes))
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
      bestEffort: true,
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
    if (!Number.isFinite(params.delayMs)) {
      return undefined;
    }
    const timestamp = Date.now() + Math.max(1, params.delayMs);
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

function extractCronJobId(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const payload =
    record.payload && typeof record.payload === "object"
      ? (record.payload as Record<string, unknown>)
      : record;
  const id = payload.jobId ?? payload.id;
  return typeof id === "string" && id.trim() ? id.trim() : undefined;
}

export async function schedulePluginSessionTurn(params: {
  pluginId: string;
  pluginName?: string;
  origin?: PluginOrigin;
  schedule: PluginSessionTurnScheduleParams;
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
  const name =
    normalizeOptionalString(params.schedule.name) ??
    `plugin:${params.pluginId}:${sessionKey}:${randomUUID()}`;
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
        ...(params.schedule.deliveryMode
          ? { delivery: { mode: params.schedule.deliveryMode } }
          : {}),
      },
      { scopes: [ADMIN_SCOPE] },
    );
  } catch (error) {
    log.warn(`plugin session turn scheduling failed: ${formatErrorMessage(error)}`);
    return undefined;
  }
  const jobId = extractCronJobId(result);
  if (!jobId) {
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
        try {
          await callGatewayTool("cron.remove", {}, { id: jobId }, { scopes: [ADMIN_SCOPE] });
        } catch (error) {
          log.warn(`plugin session turn cleanup failed: ${formatErrorMessage(error)}`);
        }
      },
    },
  });
}
