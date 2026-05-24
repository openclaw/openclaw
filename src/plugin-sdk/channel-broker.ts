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
