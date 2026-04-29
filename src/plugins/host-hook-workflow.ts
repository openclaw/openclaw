import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { callGatewayTool } from "../agents/tools/gateway.js";
import { extractDeliveryInfo } from "../config/sessions/delivery-info.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
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
  type PluginAttachmentChannelHints,
  type PluginJsonValue,
  type PluginSessionAttachmentCaptionFormat,
  type PluginSessionAttachmentParams,
  type PluginSessionAttachmentResult,
  type PluginSessionSchedulerJobHandle,
  type PluginSessionTurnScheduleParams,
  type PluginSessionTurnUnscheduleByTagParams,
  type PluginSessionTurnUnscheduleByTagResult,
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

/**
 * Resolved per-channel parseMode for attachment captions. `channelHints` wins
 * over `captionFormat` when both are set; absent values are returned as
 * `undefined` so callers can spread the result without nullability checks.
 */
type ResolvedAttachmentDelivery = {
  parseMode?: "HTML" | "MarkdownV2";
  disableNotification?: boolean;
  forceDocumentMime?: string;
  ephemeral?: boolean;
  suppressEmbeds?: boolean;
  unfurlLinks?: boolean;
  threadTs?: string;
};

function captionFormatToParseMode(
  captionFormat: PluginSessionAttachmentCaptionFormat | undefined,
): "HTML" | "MarkdownV2" | undefined {
  if (captionFormat === "html") {
    return "HTML";
  }
  if (captionFormat === "markdownv2") {
    return "MarkdownV2";
  }
  return undefined;
}

/**
 * Collapse `captionFormat` and `channelHints` into a single resolved view of
 * delivery hints. `channelHints.<channel>` keys win over `captionFormat` when
 * both are set; this matches the documented precedence on
 * {@link PluginSessionAttachmentParams.channelHints}.
 *
 * Channels only consume the keys they recognise, so extra fields are safe to
 * pass through; this helper centralises the precedence rule so every channel
 * adapter sees the same resolved view.
 */
export function resolveAttachmentDelivery(params: {
  channel: string;
  captionFormat?: PluginSessionAttachmentCaptionFormat;
  channelHints?: PluginAttachmentChannelHints;
}): ResolvedAttachmentDelivery {
  const fallbackParseMode = captionFormatToParseMode(params.captionFormat);
  const channel = params.channel.trim().toLowerCase();
  if (channel === "telegram") {
    const hint = params.channelHints?.telegram;
    return {
      parseMode: hint?.parseMode ?? fallbackParseMode,
      ...(hint?.disableNotification !== undefined
        ? { disableNotification: hint.disableNotification }
        : {}),
      ...(hint?.forceDocumentMime ? { forceDocumentMime: hint.forceDocumentMime } : {}),
    };
  }
  if (channel === "discord") {
    const hint = params.channelHints?.discord;
    return {
      ...(fallbackParseMode ? { parseMode: fallbackParseMode } : {}),
      ...(hint?.ephemeral !== undefined ? { ephemeral: hint.ephemeral } : {}),
      ...(hint?.suppressEmbeds !== undefined ? { suppressEmbeds: hint.suppressEmbeds } : {}),
    };
  }
  if (channel === "slack") {
    const hint = params.channelHints?.slack;
    return {
      ...(fallbackParseMode ? { parseMode: fallbackParseMode } : {}),
      ...(hint?.unfurlLinks !== undefined ? { unfurlLinks: hint.unfurlLinks } : {}),
      ...(hint?.threadTs ? { threadTs: hint.threadTs } : {}),
    };
  }
  return fallbackParseMode ? { parseMode: fallbackParseMode } : {};
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
  params: PluginSessionAttachmentParams & { config?: OpenClawConfig; origin?: PluginOrigin },
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
  const { deliveryContext, threadId } = extractDeliveryInfo(sessionKey, { cfg: params.config });
  if (!deliveryContext?.channel || !deliveryContext.to) {
    return { ok: false, error: `session has no active delivery route: ${sessionKey}` };
  }
  const text = normalizeOptionalString(params.text) ?? "";
  const explicitThreadId = normalizeOptionalString(params.threadId);
  const deliveryThreadId = normalizeOptionalString(deliveryContext.threadId);
  const fallbackThreadId = normalizeOptionalString(threadId);
  // Resolve per-channel delivery hints (parseMode, disableNotification, etc.)
  // up front so the precedence rule lives in one place. Channels only consume
  // the hints they recognise; unknown keys are silently ignored.
  const resolvedDelivery = resolveAttachmentDelivery({
    channel: deliveryContext.channel,
    captionFormat: params.captionFormat,
    channelHints: params.channelHints,
  });
  // Slack threadTs hint takes precedence over the legacy threadId pipeline so
  // plugins can pin a reply to a specific Slack thread without abusing
  // `params.threadId`. Other channels keep the existing fallback chain.
  const resolvedThreadId =
    resolvedDelivery.threadTs ?? explicitThreadId ?? deliveryThreadId ?? fallbackThreadId;
  let result: Awaited<ReturnType<SendMessage>>;
  try {
    const sendMessage = await loadSendMessage();
    result = await sendMessage({
      to: deliveryContext.to,
      content: text,
      channel: deliveryContext.channel,
      accountId: deliveryContext.accountId,
      threadId: resolvedThreadId,
      requesterSessionKey: sessionKey,
      mediaUrls: validated,
      forceDocument:
        params.forceDocument ?? (resolvedDelivery.forceDocumentMime ? true : undefined),
      bestEffort: true,
      ...(resolvedDelivery.parseMode ? { parseMode: resolvedDelivery.parseMode } : {}),
      ...(resolvedDelivery.disableNotification !== undefined
        ? { silent: resolvedDelivery.disableNotification }
        : {}),
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

/** Prefix applied to plugin-scheduled cron job names so they are searchable. */
const PLUGIN_CRON_NAME_PREFIX = "plugin:";

/** Marker that separates the optional tag from the rest of the cron name. */
const PLUGIN_CRON_TAG_MARKER = ":tag:";

/**
 * Build the canonical cron job name for a plugin-scheduled session turn. Tags
 * are auto-prefixed with `${pluginId}:` so two plugins can reuse the same
 * short tag (e.g. `nudge`) without collision.
 */
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

/**
 * Extract the auto-prefixed cron name prefix used to find every job created
 * for a given `pluginId` + `tag` pair. Used by tag-based cleanup.
 */
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
  // When a tag is present, keep the host-owned prefix even if the plugin also
  // provides a name; tag cleanup depends on that prefix. Without a tag, a
  // custom name remains a full override for legacy/basic scheduling callers.
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
  // Cron normaliser preserves unknown payload fields via spread. Canonical
  // fields are written last so plugin extras cannot override the required
  // `kind`/`message` shape.
  const payload: Record<string, unknown> = {
    ...params.schedule.payloadExtras,
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

/**
 * Remove every plugin-scheduled session turn that was created with `tag`
 * inside `sessionKey`. Tag matching uses the auto-prefixed
 * `${pluginId}:${tag}` name fragment so two plugins reusing the same short
 * tag (e.g. "nudge") do not clobber each other.
 */
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
  let listResult: unknown;
  try {
    listResult = await callGatewayTool(
      "cron.list",
      {},
      { includeDisabled: true },
      { scopes: [ADMIN_SCOPE] },
    );
  } catch (error) {
    log.warn(`plugin session turn untag-list failed: ${formatErrorMessage(error)}`);
    return { removed: 0, failed: 1 };
  }
  const candidates = readCronListJobs(listResult).filter((job) => {
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
      await callGatewayTool("cron.remove", {}, { id }, { scopes: [ADMIN_SCOPE] });
      removed += 1;
    } catch (error) {
      log.warn(
        `plugin session turn untag-remove failed: id=${id} error=${formatErrorMessage(error)}`,
      );
      failed += 1;
    }
  }
  return { removed, failed };
}
