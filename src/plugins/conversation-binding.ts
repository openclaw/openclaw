import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ReplyPayload } from "../auto-reply/types.js";
import {
  createConversationBindingRecord,
  resolveConversationBindingRecord,
  unbindConversationBindingRecord,
} from "../bindings/records.js";
import { expandHomePrefix } from "../infra/home-dir.js";
import { writeJsonAtomic } from "../infra/json-files.js";
import { type ConversationRef } from "../infra/outbound/session-binding-service.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { getActivePluginRegistry } from "./runtime.js";
import type {
  PluginConversationBinding,
  PluginConversationBindingResolvedEvent,
  PluginConversationBindingResolutionDecision,
  PluginConversationBindingRequestParams,
  PluginConversationBindingRequestResult,
} from "./types.js";

const log = createSubsystemLogger("plugins/binding");

const APPROVALS_PATH = "~/.openclaw/plugin-binding-approvals.json";
const PLUGIN_BINDING_CUSTOM_ID_PREFIX = "pluginbind";
const PLUGIN_BINDING_OWNER = "plugin";
const PLUGIN_BINDING_SESSION_PREFIX = "plugin-binding";
const LEGACY_CODEX_PLUGIN_SESSION_PREFIXES = [
  "openclaw-app-server:thread:",
  "openclaw-codex-app-server:thread:",
] as const;

// Runtime plugin conversation bindings are approval-driven and distinct from
// configured channel bindings compiled from config.
type PluginBindingApprovalDecision = PluginConversationBindingResolutionDecision;

type PluginBindingApprovalEntry = {
  pluginRoot: string;
  pluginId: string;
  pluginName?: string;
  channel: string;
  accountId: string;
  approvedAt: number;
};

type PluginBindingApprovalsFile = {
  version: 1;
  approvals: PluginBindingApprovalEntry[];
};

type PluginBindingConversation = {
  channel: string;
  accountId: string;
  conversationId: string;
  parentConversationId?: string;
  threadId?: string | number;
};

type PendingPluginBindingRequest = {
  id: string;
  pluginId: string;
  pluginName?: string;
  pluginRoot: string;
  conversation: PluginBindingConversation;
  requestedAt: number;
  requestedBySenderId?: string;
  summary?: string;
  detachHint?: string;
};

type PluginBindingApprovalAction = {
  approvalId: string;
  decision: PluginBindingApprovalDecision;
};

type PluginBindingIdentity = {
  pluginId: string;
  pluginName?: string;
  pluginRoot: string;
};

type PluginBindingMetadata = {
  pluginBindingOwner: "plugin";
  pluginId: string;
  pluginName?: string;
  pluginRoot: string;
  summary?: string;
  detachHint?: string;
};

type PluginBindingResolveResult =
  | {
      status: "approved";
      binding: PluginConversationBinding;
      request: PendingPluginBindingRequest;
      decision: Exclude<PluginBindingApprovalDecision, "deny">;
    }
  | {
      status: "denied";
      request: PendingPluginBindingRequest;
    }
  | {
      status: "expired";
    };

const pendingRequests = new Map<string, PendingPluginBindingRequest>();

type PluginBindingGlobalState = {
  fallbackNoticeBindingIds: Set<string>;
};

const pluginBindingGlobalStateKey = Symbol.for("openclaw.plugins.binding.global-state");

let approvalsCache: PluginBindingApprovalsFile | null = null;
let approvalsLoaded = false;

function getPluginBindingGlobalState(): PluginBindingGlobalState {
  const globalStore = globalThis as typeof globalThis & {
    [pluginBindingGlobalStateKey]?: PluginBindingGlobalState;
  };
  return (globalStore[pluginBindingGlobalStateKey] ??= {
    fallbackNoticeBindingIds: new Set<string>(),
  });
}

function resolveApprovalsPath(): string {
  return expandHomePrefix(APPROVALS_PATH);
}

function normalizeChannel(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeConversation(params: PluginBindingConversation): PluginBindingConversation {
  return {
    channel: normalizeChannel(params.channel),
    accountId: params.accountId.trim() || "default",
    conversationId: params.conversationId.trim(),
    parentConversationId: params.parentConversationId?.trim() || undefined,
    threadId:
      typeof params.threadId === "number"
        ? Math.trunc(params.threadId)
        : params.threadId?.toString().trim() || undefined,
  };
}

function toConversationRef(params: PluginBindingConversation): ConversationRef {
  const normalized = normalizeConversation(params);
  if (normalized.channel === "telegram") {
    const threadId =
      typeof normalized.threadId === "number" || typeof normalized.threadId === "string"
        ? String(normalized.threadId).trim()
        : "";
    if (threadId) {
      const parent = normalized.parentConversationId?.trim() || normalized.conversationId;
      return {
        channel: "telegram",
        accountId: normalized.accountId,
        conversationId: `${parent}:topic:${threadId}`,
      };
    }
  }
  return {
    channel: normalized.channel,
    accountId: normalized.accountId,
    conversationId: normalized.conversationId,
    ...(normalized.parentConversationId
      ? { parentConversationId: normalized.parentConversationId }
      : {}),
  };
}

function buildApprovalScopeKey(params: {
  pluginRoot: string;
  channel: string;
  accountId: string;
}): string {
  return [
    params.pluginRoot,
    normalizeChannel(params.channel),
    params.accountId.trim() || "default",
  ].join("::");
}

function buildPluginBindingSessionKey(params: {
  pluginId: string;
  channel: string;
  accountId: string;
  conversationId: string;
}): string {
  const hash = crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        pluginId: params.pluginId,
        channel: normalizeChannel(params.channel),
        accountId: params.accountId,
        conversationId: params.conversationId,
      }),
    )
    .digest("hex")
    .slice(0, 24);
  return `${PLUGIN_BINDING_SESSION_PREFIX}:${params.pluginId}:${hash}`;
}

function isLegacyPluginBindingRecord(params: {
  record:
    | {
        targetSessionKey: string;
        metadata?: Record<string, unknown>;
      }
    | null
    | undefined;
}): boolean {
  if (!params.record || isPluginOwnedBindingMetadata(params.record.metadata)) {
    return false;
  }
  const targetSessionKey = params.record.targetSessionKey.trim();
  return (
    targetSessionKey.startsWith(`${PLUGIN_BINDING_SESSION_PREFIX}:`) ||
    LEGACY_CODEX_PLUGIN_SESSION_PREFIXES.some((prefix) => targetSessionKey.startsWith(prefix))
  );
}

function buildApprovalInteractiveReply(
  approvalId: string,
): NonNullable<ReplyPayload["interactive"]> {
  return {
    blocks: [
      {
        type: "buttons",
        buttons: [
          {
            label: "Allow once",
            value: buildPluginBindingApprovalCustomId(approvalId, "allow-once"),
            style: "success",
          },
          {
            label: "Always allow",
            value: buildPluginBindingApprovalCustomId(approvalId, "allow-always"),
            style: "primary",
          },
          {
            label: "Deny",
            value: buildPluginBindingApprovalCustomId(approvalId, "deny"),
            style: "danger",
          },
        ],
      },
    ],
  };
}

function createApprovalRequestId(): string {
  // Keep approval ids compact so Telegram callback_data stays under its 64-byte limit.
  return crypto.randomBytes(9).toString("base64url");
}

function loadApprovalsFromDisk(): PluginBindingApprovalsFile {
  const filePath = resolveApprovalsPath();
  try {
    if (!fs.existsSync(filePath)) {
      return { version: 1, approvals: [] };
    }
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<PluginBindingApprovalsFile>;
    if (!Array.isArray(parsed.approvals)) {
      return { version: 1, approvals: [] };
    }
    return {
      version: 1,
      approvals: parsed.approvals
        .filter((entry): entry is PluginBindingApprovalEntry =>
          Boolean(entry && typeof entry === "object"),
        )
        .map((entry) => ({
          pluginRoot: typeof entry.pluginRoot === "string" ? entry.pluginRoot : "",
          pluginId: typeof entry.pluginId === "string" ? entry.pluginId : "",
          pluginName: typeof entry.pluginName === "string" ? entry.pluginName : undefined,
          channel: typeof entry.channel === "string" ? normalizeChannel(entry.channel) : "",
          accountId:
            typeof entry.accountId === "string" ? entry.accountId.trim() || "default" : "default",
          approvedAt:
            typeof entry.approvedAt === "number" && Number.isFinite(entry.approvedAt)
              ? Math.floor(entry.approvedAt)
              : Date.now(),
        }))
        .filter((entry) => entry.pluginRoot && entry.pluginId && entry.channel),
    };
  } catch (error) {
    log.warn(`plugin binding approvals load failed: ${String(error)}`);
    return { version: 1, approvals: [] };
  }
}

async function saveApprovals(file: PluginBindingApprovalsFile): Promise<void> {
  const filePath = resolveApprovalsPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  approvalsCache = file;
  approvalsLoaded = true;
  await writeJsonAtomic(filePath, file, {
    mode: 0o600,
    trailingNewline: true,
  });
}

function getApprovals(): PluginBindingApprovalsFile {
  if (!approvalsLoaded || !approvalsCache) {
    approvalsCache = loadApprovalsFromDisk();
    approvalsLoaded = true;
  }
  return approvalsCache;
}

function hasPersistentApproval(params: {
  pluginRoot: string;
  channel: string;
  accountId: string;
}): boolean {
  const key = buildApprovalScopeKey(params);
  return getApprovals().approvals.some(
    (entry) =>
      buildApprovalScopeKey({
        pluginRoot: entry.pluginRoot,
        channel: entry.channel,
        accountId: entry.accountId,
      }) === key,
  );
}

async function addPersistentApproval(entry: PluginBindingApprovalEntry): Promise<void> {
  const file = getApprovals();
  const key = buildApprovalScopeKey(entry);
  const approvals = file.approvals.filter(
    (existing) =>
      buildApprovalScopeKey({
        pluginRoot: existing.pluginRoot,
        channel: existing.channel,
        accountId: existing.accountId,
      }) !== key,
  );
  approvals.push(entry);
  await saveApprovals({
    version: 1,
    approvals,
  });
}

function buildBindingMetadata(params: {
  pluginId: string;
  pluginName?: string;
  pluginRoot: string;
  summary?: string;
  detachHint?: string;
}): PluginBindingMetadata {
  return {
    pluginBindingOwner: PLUGIN_BINDING_OWNER,
    pluginId: params.pluginId,
    pluginName: params.pluginName,
    pluginRoot: params.pluginRoot,
    summary: params.summary?.trim() || undefined,
    detachHint: params.detachHint?.trim() || undefined,
  };
}

export function isPluginOwnedBindingMetadata(metadata: unknown): metadata is PluginBindingMetadata {
  if (!metadata || typeof metadata !== "object") {
    return false;
  }
  const record = metadata as Record<string, unknown>;
  return (
    record.pluginBindingOwner === PLUGIN_BINDING_OWNER &&
    typeof record.pluginId === "string" &&
    typeof record.pluginRoot === "string"
  );
}

export function isPluginOwnedSessionBindingRecord(
  record:
    | {
        metadata?: Record<string, unknown>;
      }
    | null
    | undefined,
): boolean {
  return isPluginOwnedBindingMetadata(record?.metadata);
}

export function toPluginConversationBinding(
  record:
    | {
        bindingId: string;
        conversation: ConversationRef;
        boundAt: number;
        metadata?: Record<string, unknown>;
      }
    | null
    | undefined,
): PluginConversationBinding | null {
  if (!record || !isPluginOwnedBindingMetadata(record.metadata)) {
    return null;
  }
  const metadata = record.metadata;
  return {
    bindingId: record.bindingId,
    pluginId: metadata.pluginId,
    pluginName: metadata.pluginName,
    pluginRoot: metadata.pluginRoot,
    channel: record.conversation.channel,
    accountId: record.conversation.accountId,
    conversationId: record.conversation.conversationId,
    parentConversationId: record.conversation.parentConversationId,
    boundAt: record.boundAt,
    summary: metadata.summary,
    detachHint: metadata.detachHint,
  };
}

async function bindConversationNow(params: {
  identity: PluginBindingIdentity;
  conversation: PluginBindingConversation;
  summary?: string;
  detachHint?: string;
}): Promise<PluginConversationBinding> {
  const ref = toConversationRef(params.conversation);
  const targetSessionKey = buildPluginBindingSessionKey({
    pluginId: params.identity.pluginId,
    channel: ref.channel,
    accountId: ref.accountId,
    conversationId: ref.conversationId,
  });
  const record = await createConversationBindingRecord({
    targetSessionKey,
    targetKind: "session",
    conversation: ref,
    placement: "current",
    metadata: buildBindingMetadata({
      pluginId: params.identity.pluginId,
      pluginName: params.identity.pluginName,
      pluginRoot: params.identity.pluginRoot,
      summary: params.summary,
      detachHint: params.detachHint,
    }),
  });
  const binding = toPluginConversationBinding(record);
  if (!binding) {
    throw new Error("plugin binding was created without plugin metadata");
  }
  return {
    ...binding,
    parentConversationId: params.conversation.parentConversationId,
    threadId: params.conversation.threadId,
  };
}

function buildApprovalMessage(request: PendingPluginBindingRequest): string {
  const lines = [
    `Plugin bind approval required`,
    `Plugin: ${request.pluginName ?? request.pluginId}`,
    `Channel: ${request.conversation.channel}`,
    `Account: ${request.conversation.accountId}`,
  ];
  if (request.summary?.trim()) {
    lines.push(`Request: ${request.summary.trim()}`);
  } else {
    lines.push("Request: Bind this conversation so future plain messages route to the plugin.");
  }
  lines.push("Choose whether to allow this plugin to bind the current conversation.");
  return lines.join("\n");
}

function resolvePluginBindingDisplayName(binding: {
  pluginId: string;
  pluginName?: string;
}): string {
  return binding.pluginName?.trim() || binding.pluginId;
}

function buildDetachHintSuffix(detachHint?: string): string {
  const trimmed = detachHint?.trim();
  return trimmed ? ` To detach this conversation, use ${trimmed}.` : "";
}

export function buildPluginBindingUnavailableText(binding: PluginConversationBinding): string {
  return `The bound plugin ${resolvePluginBindingDisplayName(binding)} is not currently loaded. Routing this message to OpenClaw instead.${buildDetachHintSuffix(binding.detachHint)}`;
}

export function buildPluginBindingDeclinedText(binding: PluginConversationBinding): string {
  return `The bound plugin ${resolvePluginBindingDisplayName(binding)} did not handle this message. This conversation is still bound to that plugin.${buildDetachHintSuffix(binding.detachHint)}`;
}

export function buildPluginBindingErrorText(binding: PluginConversationBinding): string {
  return `The bound plugin ${resolvePluginBindingDisplayName(binding)} hit an error handling this message. This conversation is still bound to that plugin.${buildDetachHintSuffix(binding.detachHint)}`;
}

export function hasShownPluginBindingFallbackNotice(bindingId: string): boolean {
  const normalized = bindingId.trim();
  if (!normalized) {
    return false;
  }
  return getPluginBindingGlobalState().fallbackNoticeBindingIds.has(normalized);
}

export function markPluginBindingFallbackNoticeShown(bindingId: string): void {
  const normalized = bindingId.trim();
  if (!normalized) {
    return;
  }
  getPluginBindingGlobalState().fallbackNoticeBindingIds.add(normalized);
}

function buildPendingReply(request: PendingPluginBindingRequest): ReplyPayload {
  return {
    text: buildApprovalMessage(request),
    interactive: buildApprovalInteractiveReply(request.id),
  };
}

function encodeCustomIdValue(value: string): string {
  return encodeURIComponent(value);
}

function decodeCustomIdValue(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function buildPluginBindingApprovalCustomId(
  approvalId: string,
  decision: PluginBindingApprovalDecision,
): string {
  const decisionCode = decision === "allow-once" ? "o" : decision === "allow-always" ? "a" : "d";
  return `${PLUGIN_BINDING_CUSTOM_ID_PREFIX}:${encodeCustomIdValue(approvalId)}:${decisionCode}`;
}

export function parsePluginBindingApprovalCustomId(
  value: string,
): PluginBindingApprovalAction | null {
  const trimmed = value.trim();
  if (!trimmed.startsWith(`${PLUGIN_BINDING_CUSTOM_ID_PREFIX}:`)) {
    return null;
  }
  const body = trimmed.slice(`${PLUGIN_BINDING_CUSTOM_ID_PREFIX}:`.length);
  const separator = body.lastIndexOf(":");
  if (separator <= 0 || separator === body.length - 1) {
    return null;
  }
  const rawId = body.slice(0, separator).trim();
  const rawDecisionCode = body.slice(separator + 1).trim();
  if (!rawId) {
    return null;
  }
  const rawDecision =
    rawDecisionCode === "o"
      ? "allow-once"
      : rawDecisionCode === "a"
        ? "allow-always"
        : rawDecisionCode === "d"
          ? "deny"
          : null;
  if (!rawDecision) {
    return null;
  }
  return {
    approvalId: decodeCustomIdValue(rawId),
    decision: rawDecision,
  };
}

export async function requestPluginConversationBinding(params: {
  pluginId: string;
  pluginName?: string;
  pluginRoot: string;
  conversation: PluginBindingConversation;
  requestedBySenderId?: string;
  binding: PluginConversationBindingRequestParams | undefined;
}): Promise<PluginConversationBindingRequestResult> {
  const conversation = normalizeConversation(params.conversation);
  const ref = toConversationRef(conversation);
  const existing = resolveConversationBindingRecord(ref);
  const existingPluginBinding = toPluginConversationBinding(existing);
  const existingLegacyPluginBinding = isLegacyPluginBindingRecord({
    record: existing,
  });
  if (existing && !existingPluginBinding) {
    if (existingLegacyPluginBinding) {
      log.info(
        `plugin binding migrating legacy record plugin=${params.pluginId} root=${params.pluginRoot} channel=${ref.channel} account=${ref.accountId} conversation=${ref.conversationId}`,
      );
    } else {
      return {
        status: "error",
        message:
          "This conversation is already bound by core routing and cannot be claimed by a plugin.",
      };
    }
  }
  if (existingPluginBinding && existingPluginBinding.pluginRoot !== params.pluginRoot) {
    return {
      status: "error",
      message: `This conversation is already bound by plugin "${existingPluginBinding.pluginName ?? existingPluginBinding.pluginId}".`,
    };
  }

  if (existingPluginBinding && existingPluginBinding.pluginRoot === params.pluginRoot) {
    const rebound = await bindConversationNow({
      identity: {
        pluginId: params.pluginId,
        pluginName: params.pluginName,
        pluginRoot: params.pluginRoot,
      },
      conversation,
      summary: params.binding?.summary,
      detachHint: params.binding?.detachHint,
    });
    log.info(
      `plugin binding auto-refresh plugin=${params.pluginId} root=${params.pluginRoot} channel=${ref.channel} account=${ref.accountId} conversation=${ref.conversationId}`,
    );
    return { status: "bound", binding: rebound };
  }

  if (
    hasPersistentApproval({
      pluginRoot: params.pluginRoot,
      channel: ref.channel,
      accountId: ref.accountId,
    })
  ) {
    const bound = await bindConversationNow({
      identity: {
        pluginId: params.pluginId,
        pluginName: params.pluginName,
        pluginRoot: params.pluginRoot,
      },
      conversation,
      summary: params.binding?.summary,
      detachHint: params.binding?.detachHint,
    });
    log.info(
      `plugin binding auto-approved plugin=${params.pluginId} root=${params.pluginRoot} channel=${ref.channel} account=${ref.accountId} conversation=${ref.conversationId}`,
    );
    return { status: "bound", binding: bound };
  }

  const request: PendingPluginBindingRequest = {
    id: createApprovalRequestId(),
    pluginId: params.pluginId,
    pluginName: params.pluginName,
    pluginRoot: params.pluginRoot,
    conversation,
    requestedAt: Date.now(),
    requestedBySenderId: params.requestedBySenderId?.trim() || undefined,
    summary: params.binding?.summary?.trim() || undefined,
    detachHint: params.binding?.detachHint?.trim() || undefined,
  };
  pendingRequests.set(request.id, request);
  log.info(
    `plugin binding requested plugin=${params.pluginId} root=${params.pluginRoot} channel=${ref.channel} account=${ref.accountId} conversation=${ref.conversationId}`,
  );
  return {
    status: "pending",
    approvalId: request.id,
    reply: buildPendingReply(request),
  };
}

export async function getCurrentPluginConversationBinding(params: {
  pluginRoot: string;
  conversation: PluginBindingConversation;
}): Promise<PluginConversationBinding | null> {
  const record = resolveConversationBindingRecord(toConversationRef(params.conversation));
  const binding = toPluginConversationBinding(record);
  if (!binding || binding.pluginRoot !== params.pluginRoot) {
    return null;
  }
  return {
    ...binding,
    parentConversationId: params.conversation.parentConversationId,
    threadId: params.conversation.threadId,
  };
}

export async function detachPluginConversationBinding(params: {
  pluginRoot: string;
  conversation: PluginBindingConversation;
}): Promise<{ removed: boolean }> {
  const ref = toConversationRef(params.conversation);
  const record = resolveConversationBindingRecord(ref);
  const binding = toPluginConversationBinding(record);
  if (!binding || binding.pluginRoot !== params.pluginRoot) {
    return { removed: false };
  }
  await unbindConversationBindingRecord({
    bindingId: binding.bindingId,
    reason: "plugin-detach",
  });
  log.info(
    `plugin binding detached plugin=${binding.pluginId} root=${binding.pluginRoot} channel=${binding.channel} account=${binding.accountId} conversation=${binding.conversationId}`,
  );
  return { removed: true };
}

export async function resolvePluginConversationBindingApproval(params: {
  approvalId: string;
  decision: PluginBindingApprovalDecision;
  senderId?: string;
}): Promise<PluginBindingResolveResult> {
  const request = pendingRequests.get(params.approvalId);
  if (!request) {
    return { status: "expired" };
  }
  if (
    request.requestedBySenderId &&
    params.senderId?.trim() &&
    request.requestedBySenderId !== params.senderId.trim()
  ) {
    return { status: "expired" };
  }
  pendingRequests.delete(params.approvalId);
  if (params.decision === "deny") {
    dispatchPluginConversationBindingResolved({
      status: "denied",
      decision: "deny",
      request,
    });
    log.info(
      `plugin binding denied plugin=${request.pluginId} root=${request.pluginRoot} channel=${request.conversation.channel} account=${request.conversation.accountId} conversation=${request.conversation.conversationId}`,
    );
    return { status: "denied", request };
  }
  if (params.decision === "allow-always") {
    await addPersistentApproval({
      pluginRoot: request.pluginRoot,
      pluginId: request.pluginId,
      pluginName: request.pluginName,
      channel: request.conversation.channel,
      accountId: request.conversation.accountId,
      approvedAt: Date.now(),
    });
  }
  const binding = await bindConversationNow({
    identity: {
      pluginId: request.pluginId,
      pluginName: request.pluginName,
      pluginRoot: request.pluginRoot,
    },
    conversation: request.conversation,
    summary: request.summary,
    detachHint: request.detachHint,
  });
  log.info(
    `plugin binding approved plugin=${request.pluginId} root=${request.pluginRoot} decision=${params.decision} channel=${request.conversation.channel} account=${request.conversation.accountId} conversation=${request.conversation.conversationId}`,
  );
  dispatchPluginConversationBindingResolved({
    status: "approved",
    binding,
    decision: params.decision,
    request,
  });
  return {
    status: "approved",
    binding,
    request,
    decision: params.decision,
  };
}

function dispatchPluginConversationBindingResolved(params: {
  status: "approved" | "denied";
  binding?: PluginConversationBinding;
  decision: PluginConversationBindingResolutionDecision;
  request: PendingPluginBindingRequest;
}): void {
  // Keep platform interaction acks fast even if the plugin does slow post-bind work.
  queueMicrotask(() => {
    void notifyPluginConversationBindingResolved(params).catch((error) => {
      log.warn(`plugin binding resolved dispatch failed: ${String(error)}`);
    });
  });
}

async function notifyPluginConversationBindingResolved(params: {
  status: "approved" | "denied";
  binding?: PluginConversationBinding;
  decision: PluginConversationBindingResolutionDecision;
  request: PendingPluginBindingRequest;
}): Promise<void> {
  const registrations = getActivePluginRegistry()?.conversationBindingResolvedHandlers ?? [];
  for (const registration of registrations) {
    if (registration.pluginId !== params.request.pluginId) {
      continue;
    }
    const registeredRoot = registration.pluginRoot?.trim();
    if (registeredRoot && registeredRoot !== params.request.pluginRoot) {
      continue;
    }
    try {
      const event: PluginConversationBindingResolvedEvent = {
        status: params.status,
        binding: params.binding,
        decision: params.decision,
        request: {
          summary: params.request.summary,
          detachHint: params.request.detachHint,
          requestedBySenderId: params.request.requestedBySenderId,
          conversation: params.request.conversation,
        },
      };
      await registration.handler(event);
    } catch (error) {
      log.warn(
        `plugin binding resolved callback failed plugin=${registration.pluginId} root=${registration.pluginRoot ?? "<none>"}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

export function buildPluginBindingResolvedText(params: PluginBindingResolveResult): string {
  if (params.status === "expired") {
    return "That plugin bind approval expired. Retry the bind command.";
  }
  if (params.status === "denied") {
    return `Denied plugin bind request for ${params.request.pluginName ?? params.request.pluginId}.`;
  }
  const summarySuffix = params.request.summary?.trim() ? ` ${params.request.summary.trim()}` : "";
  if (params.decision === "allow-always") {
    return `Allowed ${params.request.pluginName ?? params.request.pluginId} to bind this conversation.${summarySuffix}`;
  }
  return `Allowed ${params.request.pluginName ?? params.request.pluginId} to bind this conversation once.${summarySuffix}`;
}

export const __testing = {
  reset() {
    pendingRequests.clear();
    approvalsCache = null;
    approvalsLoaded = false;
    getPluginBindingGlobalState().fallbackNoticeBindingIds.clear();
  },
};
