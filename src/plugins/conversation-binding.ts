import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Button, Row, type TopLevelComponents } from "@buape/carbon";
import { ButtonStyle } from "discord-api-types/v10";
import type { ReplyPayload } from "../auto-reply/types.js";
import { expandHomePrefix } from "../infra/home-dir.js";
import { writeJsonAtomic } from "../infra/json-files.js";
import {
  getSessionBindingService,
  type ConversationRef,
} from "../infra/outbound/session-binding-service.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type {
  PluginConversationBinding,
  PluginConversationBindingRequestParams,
  PluginConversationBindingRequestResult,
} from "./types.js";

const log = createSubsystemLogger("plugins/binding");

const APPROVALS_PATH = "~/.openclaw/plugin-binding-approvals.json";
const PLUGIN_BINDING_CUSTOM_ID_PREFIX = "pluginbind";
const PLUGIN_BINDING_OWNER = "plugin";
const PLUGIN_BINDING_SESSION_PREFIX = "plugin-binding";

type PluginBindingApprovalDecision = "allow-once" | "allow-always" | "deny";

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
};

type PluginBindingResolveResult =
  | {
      status: "approved";
      binding: PluginConversationBinding;
      request: PendingPluginBindingRequest;
      decision: PluginBindingApprovalDecision;
    }
  | {
      status: "denied";
      request: PendingPluginBindingRequest;
    }
  | {
      status: "expired";
    };

const pendingRequests = new Map<string, PendingPluginBindingRequest>();

let approvalsCache: PluginBindingApprovalsFile | null = null;
let approvalsLoaded = false;

class PluginBindingApprovalButton extends Button {
  customId: string;
  label: string;
  style: ButtonStyle;

  constructor(params: {
    approvalId: string;
    decision: PluginBindingApprovalDecision;
    label: string;
    style: ButtonStyle;
  }) {
    super();
    this.customId = buildPluginBindingApprovalCustomId(params.approvalId, params.decision);
    this.label = params.label;
    this.style = params.style;
  }
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
  pluginId: string;
}): boolean {
  if (!params.record || isPluginOwnedBindingMetadata(params.record.metadata)) {
    return false;
  }
  const targetSessionKey = params.record.targetSessionKey.trim();
  return targetSessionKey.startsWith(`${PLUGIN_BINDING_SESSION_PREFIX}:${params.pluginId}:`);
}

function buildDiscordButtonRow(
  approvalId: string,
  labels?: { once?: string; always?: string; deny?: string },
): TopLevelComponents[] {
  return [
    new Row([
      new PluginBindingApprovalButton({
        approvalId,
        decision: "allow-once",
        label: labels?.once ?? "Allow once",
        style: ButtonStyle.Success,
      }),
      new PluginBindingApprovalButton({
        approvalId,
        decision: "allow-always",
        label: labels?.always ?? "Always allow",
        style: ButtonStyle.Primary,
      }),
      new PluginBindingApprovalButton({
        approvalId,
        decision: "deny",
        label: labels?.deny ?? "Deny",
        style: ButtonStyle.Danger,
      }),
    ]),
  ];
}

function buildTelegramButtons(approvalId: string) {
  return [
    [
      {
        text: "Allow once",
        callback_data: buildPluginBindingApprovalCustomId(approvalId, "allow-once"),
        style: "success" as const,
      },
      {
        text: "Always allow",
        callback_data: buildPluginBindingApprovalCustomId(approvalId, "allow-always"),
        style: "primary" as const,
      },
      {
        text: "Deny",
        callback_data: buildPluginBindingApprovalCustomId(approvalId, "deny"),
        style: "danger" as const,
      },
    ],
  ];
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
}): PluginBindingMetadata {
  return {
    pluginBindingOwner: PLUGIN_BINDING_OWNER,
    pluginId: params.pluginId,
    pluginName: params.pluginName,
    pluginRoot: params.pluginRoot,
    summary: params.summary?.trim() || undefined,
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
  };
}

async function bindConversationNow(params: {
  identity: PluginBindingIdentity;
  conversation: PluginBindingConversation;
  summary?: string;
}): Promise<PluginConversationBinding> {
  const ref = toConversationRef(params.conversation);
  const targetSessionKey = buildPluginBindingSessionKey({
    pluginId: params.identity.pluginId,
    channel: ref.channel,
    accountId: ref.accountId,
    conversationId: ref.conversationId,
  });
  const record = await getSessionBindingService().bind({
    targetSessionKey,
    targetKind: "session",
    conversation: ref,
    placement: "current",
    metadata: buildBindingMetadata({
      pluginId: params.identity.pluginId,
      pluginName: params.identity.pluginName,
      pluginRoot: params.identity.pluginRoot,
      summary: params.summary,
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

function buildPendingReply(request: PendingPluginBindingRequest): ReplyPayload {
  return {
    text: buildApprovalMessage(request),
    channelData: {
      telegram: {
        buttons: buildTelegramButtons(request.id),
      },
      discord: {
        components: buildDiscordButtonRow(request.id),
      },
    },
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
  return [
    `${PLUGIN_BINDING_CUSTOM_ID_PREFIX}:id=${encodeCustomIdValue(approvalId)}`,
    `decision=${decision}`,
  ].join(";");
}

export function parsePluginBindingApprovalCustomId(
  value: string,
): PluginBindingApprovalAction | null {
  const trimmed = value.trim();
  if (!trimmed.startsWith(`${PLUGIN_BINDING_CUSTOM_ID_PREFIX}:`)) {
    return null;
  }
  const body = trimmed.slice(`${PLUGIN_BINDING_CUSTOM_ID_PREFIX}:`.length);
  const params = new URLSearchParams(body.replaceAll(";", "&"));
  const rawId = params.get("id")?.trim() ?? "";
  const rawDecision = params.get("decision")?.trim() ?? "";
  if (!rawId) {
    return null;
  }
  if (rawDecision !== "allow-once" && rawDecision !== "allow-always" && rawDecision !== "deny") {
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
  const existing = getSessionBindingService().resolveByConversation(ref);
  const existingPluginBinding = toPluginConversationBinding(existing);
  const existingLegacyPluginBinding = isLegacyPluginBindingRecord({
    record: existing,
    pluginId: params.pluginId,
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
    });
    log.info(
      `plugin binding auto-approved plugin=${params.pluginId} root=${params.pluginRoot} channel=${ref.channel} account=${ref.accountId} conversation=${ref.conversationId}`,
    );
    return { status: "bound", binding: bound };
  }

  const request: PendingPluginBindingRequest = {
    id: crypto.randomUUID(),
    pluginId: params.pluginId,
    pluginName: params.pluginName,
    pluginRoot: params.pluginRoot,
    conversation,
    requestedAt: Date.now(),
    requestedBySenderId: params.requestedBySenderId?.trim() || undefined,
    summary: params.binding?.summary?.trim() || undefined,
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
  const record = getSessionBindingService().resolveByConversation(
    toConversationRef(params.conversation),
  );
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
  const record = getSessionBindingService().resolveByConversation(ref);
  const binding = toPluginConversationBinding(record);
  if (!binding || binding.pluginRoot !== params.pluginRoot) {
    return { removed: false };
  }
  await getSessionBindingService().unbind({
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
  });
  log.info(
    `plugin binding approved plugin=${request.pluginId} root=${request.pluginRoot} decision=${params.decision} channel=${request.conversation.channel} account=${request.conversation.accountId} conversation=${request.conversation.conversationId}`,
  );
  return {
    status: "approved",
    binding,
    request,
    decision: params.decision,
  };
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
  },
};
