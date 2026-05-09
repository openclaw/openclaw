import { randomUUID } from "node:crypto";
import { lstat, open } from "node:fs/promises";
import { resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import { resolvePathFromInput } from "../agents/path-policy.js";
import { resolveWorkspaceRoot } from "../agents/workspace-dir.js";
import { extractDeliveryInfo } from "../config/sessions/delivery-info.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { ADMIN_SCOPE } from "../gateway/operator-scopes.js";
import { formatErrorMessage } from "../infra/errors.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { detectMime, FILE_TYPE_SNIFF_MAX_BYTES, normalizeMimeType } from "../media/mime.js";
import { resolveAgentIdFromSessionKey } from "../routing/session-key.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { isDeliverableMessageChannel, normalizeMessageChannel } from "../utils/message-channel.js";
import {
  deletePluginSessionSchedulerJob,
  registerPluginSessionSchedulerJob,
} from "./host-hook-runtime.js";
import type {
  PluginAttachmentChannelHints,
  PluginSessionAttachmentCaptionFormat,
  PluginSessionAttachmentParams,
  PluginSessionAttachmentResult,
  PluginSessionSchedulerJobHandle,
  PluginSessionTurnScheduleParams,
  PluginSessionTurnUnscheduleByTagParams,
  PluginSessionTurnUnscheduleByTagResult,
} from "./host-hooks.js";
import type { PluginOrigin } from "./plugin-origin.types.js";
import type { PluginRegistry } from "./registry-types.js";

const log = createSubsystemLogger("plugins/host-workflow");
const DEFAULT_ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;
const MAX_ATTACHMENT_FILES = 10;
const PLUGIN_CRON_NAME_PREFIX = "plugin:";
const PLUGIN_CRON_TAG_MARKER = ":tag:";

type SendMessage = typeof import("../infra/outbound/message.js").sendMessage;
let sendMessagePromise: Promise<SendMessage> | undefined;

async function loadSendMessage(): Promise<SendMessage> {
  sendMessagePromise ??= import("../infra/outbound/message.js").then(
    (module) => module.sendMessage,
  );
  return sendMessagePromise;
}

type GetChannelPlugin = typeof import("../channels/plugins/index.js").getChannelPlugin;
let getChannelPluginPromise: Promise<GetChannelPlugin> | undefined;

type AttachmentDeliveryChannelPlugin = {
  outbound?: {
    deliveryMode?: string;
  };
};

async function loadGetChannelPlugin(): Promise<GetChannelPlugin> {
  getChannelPluginPromise ??= import("../channels/plugins/index.js").then(
    (module) => module.getChannelPlugin,
  );
  return getChannelPluginPromise;
}

type ResolvedAttachmentDelivery = {
  parseMode?: "HTML";
  escapePlainHtmlCaption?: boolean;
  disableNotification?: boolean;
  forceDocumentMime?: string;
  threadTs?: string;
};

function captionFormatToParseMode(
  captionFormat: PluginSessionAttachmentCaptionFormat | undefined,
): "HTML" | undefined {
  if (captionFormat === "html") {
    return "HTML";
  }
  return undefined;
}
const ONE_SHOT_SCHEDULER_RECORD_PRUNE_GRACE_MS = 60_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

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

function escapeHtmlText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function readMimeSniffBuffer(
  filePath: string,
  size: number,
): Promise<Buffer | { error: string }> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(filePath, "r");
    const length = Math.min(Math.max(0, size), FILE_TYPE_SNIFF_MAX_BYTES);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead);
  } catch (error) {
    return {
      error: `attachment file MIME read failed for ${filePath}: ${formatErrorMessage(error)}`,
    };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export function resolveAttachmentDelivery(params: {
  channel: string;
  captionFormat?: PluginSessionAttachmentCaptionFormat;
  channelHints?: PluginAttachmentChannelHints;
}): ResolvedAttachmentDelivery {
  const fallbackParseMode = captionFormatToParseMode(params.captionFormat);
  const channel = params.channel.trim().toLowerCase();
  if (channel === "telegram") {
    const hint = params.channelHints?.telegram;
    const parseMode =
      hint?.parseMode ?? (params.captionFormat === "plain" ? "HTML" : fallbackParseMode);
    const escapePlainHtmlCaption = params.captionFormat === "plain" && parseMode === "HTML";
    const forceDocumentMime = normalizeMimeType(hint?.forceDocumentMime);
    return {
      ...(parseMode ? { parseMode } : {}),
      ...(escapePlainHtmlCaption ? { escapePlainHtmlCaption: true } : {}),
      ...(hint?.disableNotification !== undefined
        ? { disableNotification: hint.disableNotification }
        : {}),
      ...(forceDocumentMime ? { forceDocumentMime } : {}),
    };
  }
  if (channel === "discord") {
    return fallbackParseMode ? { parseMode: fallbackParseMode } : {};
  }
  if (channel === "slack") {
    const hint = params.channelHints?.slack;
    const threadTs = normalizeOptionalString(hint?.threadTs);
    return {
      ...(fallbackParseMode ? { parseMode: fallbackParseMode } : {}),
      ...(threadTs ? { threadTs } : {}),
    };
  }
  return fallbackParseMode ? { parseMode: fallbackParseMode } : {};
}

async function validateAttachmentFiles(
  files: PluginSessionAttachmentParams["files"],
  maxBytes: number,
  options?: {
    forceDocumentMime?: string;
    config?: OpenClawConfig;
    sessionKey?: string;
  },
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
    const resolvedPath = resolveAttachmentFilePath({
      filePath,
      config: options?.config,
      sessionKey: options?.sessionKey,
    });
    const info = await lstat(resolvedPath).catch(() => undefined);
    if (info?.isSymbolicLink()) {
      return { error: `attachment file symlinks are not allowed: ${resolvedPath}` };
    }
    if (!info?.isFile()) {
      return { error: `attachment file not found: ${resolvedPath}` };
    }
    if (info.size > maxBytes) {
      return { error: `attachment file exceeds ${maxBytes} bytes: ${resolvedPath}` };
    }
    if (options?.forceDocumentMime) {
      const fileBuffer = await readMimeSniffBuffer(resolvedPath, info.size);
      if (!Buffer.isBuffer(fileBuffer)) {
        return fileBuffer;
      }
      let detectedMime: string | undefined;
      try {
        detectedMime = normalizeMimeType(await detectMime({ buffer: fileBuffer }));
      } catch (error) {
        return {
          error:
            `attachment file MIME detection failed for ${filePath}: ` + formatErrorMessage(error),
        };
      }
      if (detectedMime !== options.forceDocumentMime) {
        return {
          error:
            `attachment file MIME mismatch for ${resolvedPath}: ` +
            `expected ${options.forceDocumentMime}, got ${detectedMime ?? "unknown"}`,
        };
      }
    }
    totalBytes += info.size;
    if (totalBytes > maxBytes) {
      return { error: `attachment files exceed ${maxBytes} bytes total` };
    }
    paths.push(resolvedPath);
  }
  return paths;
}

function resolveAttachmentFilePath(params: {
  filePath: string;
  config?: OpenClawConfig;
  sessionKey?: string;
}): string {
  const workspaceDir =
    params.sessionKey && params.config
      ? resolveAgentWorkspaceDir(params.config, resolveAgentIdFromSessionKey(params.sessionKey))
      : undefined;
  return resolvePathFromInput(params.filePath, resolveWorkspaceRoot(workspaceDir));
}

function normalizeOptionalThreadId(value: unknown): string | number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  return normalizeOptionalString(value);
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
  const { deliveryContext, threadId } = extractDeliveryInfo(sessionKey, { cfg: params.config });
  if (!deliveryContext?.channel || !deliveryContext.to) {
    return { ok: false, error: `session has no active delivery route: ${sessionKey}` };
  }
  const normalizedChannel = normalizeMessageChannel(deliveryContext.channel);
  try {
    const deliveryPlugin =
      normalizedChannel && isDeliverableMessageChannel(normalizedChannel)
        ? ((await loadGetChannelPlugin())(normalizedChannel) as
            | AttachmentDeliveryChannelPlugin
            | undefined)
        : undefined;
    if (deliveryPlugin?.outbound?.deliveryMode === "gateway") {
      return {
        ok: false,
        error:
          `session attachments require direct outbound delivery for channel ` +
          `${deliveryContext.channel}; channel uses gateway delivery`,
      };
    }
  } catch (error) {
    return {
      ok: false,
      error: `attachment delivery setup failed: ${formatErrorMessage(error)}`,
    };
  }
  const rawText = normalizeOptionalString(params.text) ?? "";
  const explicitThreadId = normalizeOptionalThreadId(params.threadId);
  const deliveryThreadId = normalizeOptionalThreadId(deliveryContext.threadId);
  const fallbackThreadId = normalizeOptionalThreadId(threadId);
  const resolvedDelivery = resolveAttachmentDelivery({
    channel: deliveryContext.channel,
    captionFormat: params.captionFormat,
    channelHints: params.channelHints,
  });
  const validated = await validateAttachmentFiles(params.files, maxBytes, {
    forceDocumentMime: resolvedDelivery.forceDocumentMime,
    config: params.config,
    sessionKey,
  });
  if (!Array.isArray(validated)) {
    return { ok: false, error: validated.error };
  }
  const resolvedThreadId =
    resolvedDelivery.threadTs ?? explicitThreadId ?? fallbackThreadId ?? deliveryThreadId;
  let result: Awaited<ReturnType<SendMessage>>;
  try {
    const sendMessage = await loadSendMessage();
    result = await sendMessage({
      to: deliveryContext.to,
      content: resolvedDelivery.escapePlainHtmlCaption ? escapeHtmlText(rawText) : rawText,
      channel: deliveryContext.channel,
      accountId: deliveryContext.accountId,
      threadId: resolvedThreadId,
      requesterSessionKey: sessionKey,
      mediaUrls: validated,
      forceDocument: resolvedDelivery.forceDocumentMime ? true : params.forceDocument,
      bestEffort: false,
      ...(resolvedDelivery.parseMode ? { parseMode: resolvedDelivery.parseMode } : {}),
      ...(resolvedDelivery.disableNotification !== undefined
        ? { silent: resolvedDelivery.disableNotification }
        : {}),
    });
  } catch (error) {
    return { ok: false, error: `attachment delivery failed: ${formatErrorMessage(error)}` };
  }
  if (!result.result) {
    return { ok: false, error: "attachment delivery failed: no delivery result returned" };
  }
  return {
    ok: true,
    channel: result.channel,
    deliveredTo: deliveryContext.to,
    count: validated.length,
  };
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
  if (schedule.kind === "cron" && params.schedule.deleteAfterRun === true) {
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
  const name = buildPluginSchedulerCronName({
    pluginId: params.pluginId,
    sessionKey,
    ...(tag !== undefined ? { tag } : {}),
    ...(scheduleName ? { uniqueId: scheduleName } : {}),
  });
  const payload: Record<string, unknown> = {
    kind: "agentTurn",
    message,
  };
  let result: unknown;
  try {
    result = await callGatewayToolLazy(
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
      log.warn(
        `plugin session turn scheduling rollback failed (${formatScheduleLogContext({
          pluginId: params.pluginId,
          sessionKey,
          name,
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
          name,
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
