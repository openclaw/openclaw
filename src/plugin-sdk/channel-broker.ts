export const BROKER_PROTOCOL_VERSION = 1 as const;
export const CHANNEL_BROKER_CHANNEL_ID = "channel-broker" as const;

export type BrokerProtocolVersion = typeof BROKER_PROTOCOL_VERSION;

export type BrokerConversationType = "direct" | "group" | "channel" | "thread";

export type BrokerOutboundMode =
  | "final"
  | "preview_update"
  | "finalize_preview"
  | "delete_preview"
  | "typing"
  | "reaction";

export type BrokerReceiptStatus = "sent" | "suppressed" | "failed" | "retryable" | "unsupported";

export type BrokerDeliveryRequirements = Partial<
  Record<
    | "text"
    | "media"
    | "payload"
    | "silent"
    | "replyTo"
    | "thread"
    | "nativeQuote"
    | "previewFinalization"
    | "progressUpdates"
    | "nativeStreaming"
    | "reconcileUnknownSend",
    boolean
  >
>;

export type BrokerConversationRef = {
  id: string;
  type: BrokerConversationType;
  parentId?: string;
  threadId?: string;
  title?: string;
};

export type BrokerMessageActor = {
  id: string;
  displayName?: string;
  handle?: string;
  isBot?: boolean;
  raw?: unknown;
};

export type BrokerMessageAttachment = {
  id?: string;
  mediaType?: string;
  mimeType?: string;
  name?: string;
  url?: string;
  contentBase64?: string;
  sizeBytes?: number;
  raw?: unknown;
};

export type BrokerInboundEventV1 = {
  version: BrokerProtocolVersion;
  eventId: string;
  providerId: string;
  platform: string;
  accountId?: string;
  conversation: BrokerConversationRef;
  sender: BrokerMessageActor;
  message: {
    id: string;
    text?: string;
    attachments?: BrokerMessageAttachment[];
    timestamp?: string;
    replyToId?: string;
    nativeIds?: Record<string, string>;
    rawRef?: string;
    raw?: unknown;
  };
  capabilities?: BrokerProviderCapabilities;
  raw?: unknown;
};

export type BrokerOutboundPayload = {
  text?: string;
  attachments?: BrokerMessageAttachment[];
  channelData?: Record<string, unknown>;
};

export type BrokerOutboundRequestV1 = {
  version: BrokerProtocolVersion;
  requestId: string;
  providerId: string;
  platform: string;
  accountId?: string;
  conversation: BrokerConversationRef;
  mode: BrokerOutboundMode;
  payloads: BrokerOutboundPayload[];
  relation?: {
    replyToId?: string;
    silent?: boolean;
    nativeQuoteId?: string;
  };
  requirements?: BrokerDeliveryRequirements;
  raw?: unknown;
};

export type BrokerReceiptV1 = {
  version: BrokerProtocolVersion;
  requestId: string;
  providerId: string;
  platform: string;
  status: BrokerReceiptStatus;
  messageIds: string[];
  timestamp?: number;
  editToken?: string;
  deleteToken?: string;
  retryAfterMs?: number;
  error?: {
    code?: string;
    message: string;
    retryable?: boolean;
  };
  native?: unknown;
  raw?: unknown;
};

export type BrokerPlatformCapabilities = {
  platform: string;
  delivery?: BrokerDeliveryRequirements;
  live?: Partial<Record<"draftPreview" | "previewFinalization" | "progressUpdates", boolean>>;
  receive?: Partial<Record<"webhook" | "polling" | "ackAfterDurableSend" | "manualAck", boolean>>;
  native?: Record<string, boolean>;
};

export type BrokerProviderCapabilities = {
  providerId?: string;
  platforms: BrokerPlatformCapabilities[];
  delivery?: BrokerDeliveryRequirements;
  live?: Partial<Record<"draftPreview" | "previewFinalization" | "progressUpdates", boolean>>;
  receive?: Partial<Record<"webhook" | "polling" | "ackAfterDurableSend" | "manualAck", boolean>>;
};

export type BrokerCapabilityRequirements = {
  delivery?: BrokerDeliveryRequirements;
  live?: Partial<Record<"draftPreview" | "previewFinalization" | "progressUpdates", boolean>>;
  receive?: Partial<Record<"webhook" | "polling" | "ackAfterDurableSend" | "manualAck", boolean>>;
  native?: Record<string, boolean>;
};

export type BrokerProviderHealth = {
  providerId: string;
  state: "ok" | "degraded" | "down" | "unknown";
  checkedAt: string;
  platforms?: Array<{
    platform: string;
    state: "ok" | "degraded" | "down" | "unknown";
    message?: string;
  }>;
  message?: string;
  details?: Record<string, unknown>;
};

export type BrokerConversationTarget = {
  platform: string;
  conversationId: string;
  conversationType?: BrokerConversationType;
  threadId?: string;
};

export const BROKER_KNOWN_PLATFORM_IDS = [
  "slack",
  "discord",
  "telegram",
  "whatsapp",
  "signal",
  "imessage",
  "matrix",
  "microsoft-teams",
  "google-chat",
  "line",
  "wechat",
  "qqbot",
  "feishu",
  "zalo",
  "irc",
  "mattermost",
  "nextcloud-talk",
  "nostr",
  "tlon",
  "synology-chat",
  "twitch",
] as const;

export type BrokerKnownPlatformId = (typeof BROKER_KNOWN_PLATFORM_IDS)[number];

export const BROKER_PLATFORM_ALIASES = {
  googlechat: "google-chat",
  msteams: "microsoft-teams",
  teams: "microsoft-teams",
  qq: "qqbot",
} as const satisfies Record<string, BrokerKnownPlatformId>;

export function normalizeBrokerPlatformId(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replaceAll(/[\s_]+/gu, "-");
  if (!normalized) {
    throw new Error("broker platform id is required");
  }
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(normalized)) {
    throw new Error(`invalid broker platform id: ${value}`);
  }
  return normalized;
}

export function normalizeBrokerKnownPlatformId(value: string): string {
  const normalized = normalizeBrokerPlatformId(value);
  return BROKER_PLATFORM_ALIASES[normalized as keyof typeof BROKER_PLATFORM_ALIASES] ?? normalized;
}

export function buildBrokerConversationTarget(target: BrokerConversationTarget): string {
  const platform = normalizeBrokerPlatformId(target.platform);
  const conversationId = target.conversationId.trim();
  if (!conversationId) {
    throw new Error("broker conversation id is required");
  }
  const base = `${platform}:${encodeURIComponent(conversationId)}`;
  const threadId = target.threadId?.trim();
  if (!threadId) {
    return base;
  }
  const search = new URLSearchParams({ threadId });
  return `${base}?${search.toString()}`;
}

export function parseBrokerConversationTarget(value: string): BrokerConversationTarget {
  const [head, query = ""] = value.trim().split("?", 2);
  const separatorIndex = head.indexOf(":");
  if (separatorIndex <= 0) {
    throw new Error(`invalid broker conversation target: ${value}`);
  }
  const platform = normalizeBrokerPlatformId(head.slice(0, separatorIndex));
  const encodedConversationId = head.slice(separatorIndex + 1);
  if (!encodedConversationId) {
    throw new Error(`invalid broker conversation target: ${value}`);
  }
  const conversationId = decodeURIComponent(encodedConversationId);
  const threadId = new URLSearchParams(query).get("threadId") ?? undefined;
  return {
    platform,
    conversationId,
    ...(threadId ? { threadId } : {}),
  };
}

function requireBrokerString(value: string | undefined, field: string): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new Error(`${field} is required`);
  }
  return trimmed;
}

function normalizeOptionalBrokerString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function normalizeBrokerConversationType(value: BrokerConversationType): BrokerConversationType {
  if (value === "direct" || value === "group" || value === "channel" || value === "thread") {
    return value;
  }
  throw new Error(`invalid broker conversation type: ${String(value)}`);
}

function normalizeBrokerAttachments(
  attachments: BrokerMessageAttachment[] | undefined,
): BrokerMessageAttachment[] | undefined {
  if (!attachments?.length) {
    return undefined;
  }
  return attachments.map((attachment) => ({
    ...(normalizeOptionalBrokerString(attachment.id) ? { id: attachment.id?.trim() } : {}),
    ...(normalizeOptionalBrokerString(attachment.mediaType)
      ? { mediaType: attachment.mediaType?.trim() }
      : {}),
    ...(normalizeOptionalBrokerString(attachment.mimeType)
      ? { mimeType: attachment.mimeType?.trim() }
      : {}),
    ...(normalizeOptionalBrokerString(attachment.name) ? { name: attachment.name?.trim() } : {}),
    ...(normalizeOptionalBrokerString(attachment.url) ? { url: attachment.url?.trim() } : {}),
    ...(attachment.contentBase64 !== undefined ? { contentBase64: attachment.contentBase64 } : {}),
    ...(attachment.sizeBytes !== undefined ? { sizeBytes: attachment.sizeBytes } : {}),
    ...(attachment.raw !== undefined ? { raw: attachment.raw } : {}),
  }));
}

function normalizeNativeIds(
  nativeIds: Record<string, string> | undefined,
): Record<string, string> | undefined {
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(nativeIds ?? {})) {
    const normalizedKey = key.trim();
    const normalizedValue = value.trim();
    if (normalizedKey && normalizedValue) {
      normalized[normalizedKey] = normalizedValue;
    }
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function normalizeBrokerPlatformCapabilities(
  capabilities: BrokerPlatformCapabilities,
): BrokerPlatformCapabilities {
  return {
    platform: normalizeBrokerPlatformId(capabilities.platform),
    ...(capabilities.delivery ? { delivery: { ...capabilities.delivery } } : {}),
    ...(capabilities.live ? { live: { ...capabilities.live } } : {}),
    ...(capabilities.receive ? { receive: { ...capabilities.receive } } : {}),
    ...(capabilities.native ? { native: { ...capabilities.native } } : {}),
  };
}

export function normalizeBrokerProviderCapabilities(
  capabilities: BrokerProviderCapabilities,
): BrokerProviderCapabilities {
  return {
    ...(normalizeOptionalBrokerString(capabilities.providerId)
      ? { providerId: capabilities.providerId?.trim() }
      : {}),
    platforms: capabilities.platforms.map(normalizeBrokerPlatformCapabilities),
    ...(capabilities.delivery ? { delivery: { ...capabilities.delivery } } : {}),
    ...(capabilities.live ? { live: { ...capabilities.live } } : {}),
    ...(capabilities.receive ? { receive: { ...capabilities.receive } } : {}),
  };
}

export function createBrokerInboundEvent(
  event: Omit<BrokerInboundEventV1, "version" | "platform"> & { platform: string },
): BrokerInboundEventV1 {
  return normalizeBrokerInboundEvent({
    ...event,
    version: BROKER_PROTOCOL_VERSION,
  });
}

export function normalizeBrokerInboundEvent(event: BrokerInboundEventV1): BrokerInboundEventV1 {
  if (event.version !== BROKER_PROTOCOL_VERSION) {
    throw new Error(`unsupported broker inbound event version: ${String(event.version)}`);
  }
  const attachments = normalizeBrokerAttachments(event.message.attachments);
  const nativeIds = normalizeNativeIds(event.message.nativeIds);
  return {
    version: BROKER_PROTOCOL_VERSION,
    eventId: requireBrokerString(event.eventId, "broker inbound event id"),
    providerId: requireBrokerString(event.providerId, "broker provider id"),
    platform: normalizeBrokerPlatformId(event.platform),
    ...(normalizeOptionalBrokerString(event.accountId)
      ? { accountId: event.accountId?.trim() }
      : {}),
    conversation: {
      id: requireBrokerString(event.conversation.id, "broker conversation id"),
      type: normalizeBrokerConversationType(event.conversation.type),
      ...(normalizeOptionalBrokerString(event.conversation.parentId)
        ? { parentId: event.conversation.parentId?.trim() }
        : {}),
      ...(normalizeOptionalBrokerString(event.conversation.threadId)
        ? { threadId: event.conversation.threadId?.trim() }
        : {}),
      ...(normalizeOptionalBrokerString(event.conversation.title)
        ? { title: event.conversation.title?.trim() }
        : {}),
    },
    sender: {
      id: requireBrokerString(event.sender.id, "broker sender id"),
      ...(normalizeOptionalBrokerString(event.sender.displayName)
        ? { displayName: event.sender.displayName?.trim() }
        : {}),
      ...(normalizeOptionalBrokerString(event.sender.handle)
        ? { handle: event.sender.handle?.trim() }
        : {}),
      ...(event.sender.isBot !== undefined ? { isBot: event.sender.isBot } : {}),
      ...(event.sender.raw !== undefined ? { raw: event.sender.raw } : {}),
    },
    message: {
      id: requireBrokerString(event.message.id, "broker message id"),
      ...(normalizeOptionalBrokerString(event.message.text)
        ? { text: event.message.text?.trim() }
        : {}),
      ...(attachments ? { attachments } : {}),
      ...(normalizeOptionalBrokerString(event.message.timestamp)
        ? { timestamp: event.message.timestamp?.trim() }
        : {}),
      ...(normalizeOptionalBrokerString(event.message.replyToId)
        ? { replyToId: event.message.replyToId?.trim() }
        : {}),
      ...(nativeIds ? { nativeIds } : {}),
      ...(normalizeOptionalBrokerString(event.message.rawRef)
        ? { rawRef: event.message.rawRef?.trim() }
        : {}),
      ...(event.message.raw !== undefined ? { raw: event.message.raw } : {}),
    },
    ...(event.capabilities
      ? { capabilities: normalizeBrokerProviderCapabilities(event.capabilities) }
      : {}),
    ...(event.raw !== undefined ? { raw: event.raw } : {}),
  };
}

export function buildBrokerInboundDedupeKey(event: BrokerInboundEventV1): string {
  const normalized = normalizeBrokerInboundEvent(event);
  return [
    normalized.providerId,
    normalized.accountId ?? "",
    normalized.platform,
    normalized.eventId,
  ]
    .map((part) => encodeURIComponent(part))
    .join(":");
}

export function resolveBrokerPlatformCapabilities(params: {
  capabilities: BrokerProviderCapabilities;
  platform: string;
}): BrokerPlatformCapabilities | undefined {
  const normalized = normalizeBrokerProviderCapabilities(params.capabilities);
  const platform = normalizeBrokerPlatformId(params.platform);
  const platformCapabilities = normalized.platforms.find((entry) => entry.platform === platform);
  if (!platformCapabilities) {
    return undefined;
  }
  return {
    platform,
    delivery: Object.assign({}, normalized.delivery, platformCapabilities.delivery),
    live: Object.assign({}, normalized.live, platformCapabilities.live),
    receive: Object.assign({}, normalized.receive, platformCapabilities.receive),
    ...(platformCapabilities.native ? { native: { ...platformCapabilities.native } } : {}),
  };
}

function supportsRequiredFlags(
  supported: Record<string, boolean> | undefined,
  required: Record<string, boolean> | undefined,
): boolean {
  for (const [key, value] of Object.entries(required ?? {})) {
    if (value === true && supported?.[key] !== true) {
      return false;
    }
  }
  return true;
}

export function brokerPlatformSupports(params: {
  capabilities: BrokerProviderCapabilities;
  platform: string;
  requirements: BrokerCapabilityRequirements;
}): boolean {
  const platformCapabilities = resolveBrokerPlatformCapabilities({
    capabilities: params.capabilities,
    platform: params.platform,
  });
  if (!platformCapabilities) {
    return false;
  }
  return (
    supportsRequiredFlags(platformCapabilities.delivery, params.requirements.delivery) &&
    supportsRequiredFlags(platformCapabilities.live, params.requirements.live) &&
    supportsRequiredFlags(platformCapabilities.receive, params.requirements.receive) &&
    supportsRequiredFlags(platformCapabilities.native, params.requirements.native)
  );
}

export function createBrokerOutboundRequest(
  request: Omit<BrokerOutboundRequestV1, "version" | "platform"> & { platform: string },
): BrokerOutboundRequestV1 {
  return {
    ...request,
    version: BROKER_PROTOCOL_VERSION,
    platform: normalizeBrokerPlatformId(request.platform),
  };
}

export function createBrokerReceipt(
  receipt: Omit<BrokerReceiptV1, "version" | "platform"> & { platform: string },
): BrokerReceiptV1 {
  return {
    ...receipt,
    version: BROKER_PROTOCOL_VERSION,
    platform: normalizeBrokerPlatformId(receipt.platform),
  };
}
