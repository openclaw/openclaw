/** Linq Blue V3 webhook event envelope. */
export type LinqWebhookEvent = {
  api_version: "v3";
  event_id: string;
  created_at: string;
  trace_id: string;
  partner_id: string;
  event_type: string;
  data: unknown;
};

export type LinqMessageReceivedData = {
  chat_id: string;
  from: string;
  recipient_phone: string;
  received_at: string;
  is_from_me: boolean;
  service: "iMessage" | "SMS" | "RCS";
  message: LinqIncomingMessage;
};

export type LinqIncomingMessage = {
  id: string;
  parts: LinqMessagePart[];
  effect?: { type: "screen" | "bubble"; name: string };
  reply_to?: { message_id: string; part_index?: number };
};

export type LinqTextPart = { type: "text"; value: string };
export type LinqMediaPart = {
  type: "media";
  url?: string;
  attachment_id?: string;
  filename?: string;
  mime_type?: string;
  size?: number;
};
export type LinqMessagePart = LinqTextPart | LinqMediaPart;

export type LinqSendResult = {
  messageId: string;
  chatId: string;
};

export type LinqProbe = {
  ok: boolean;
  error?: string | null;
  phoneNumbers?: string[];
};

/** Per-account config for the Linq channel (mirrors the Zod schema shape). */
export type LinqAccountConfig = {
  name?: string;
  enabled?: boolean;
  /** Linq API bearer token. */
  apiToken?: string;
  /** Read token from file instead of config (mutual exclusive with apiToken). */
  tokenFile?: string;
  /** Phone number this account sends from (E.164). */
  fromPhone?: string;
  /** DM security policy. */
  dmPolicy?: "pairing" | "open" | "disabled";
  /** Allowed sender IDs (phone numbers or "*"). */
  allowFrom?: Array<string | number>;
  /** Group chat security policy. */
  groupPolicy?: "open" | "allowlist" | "disabled";
  /** Allowed group sender IDs. */
  groupAllowFrom?: Array<string | number>;
  /** Max media size in MB (default: 10). */
  mediaMaxMb?: number;
  /** Max text chunk length (default: 4000). */
  textChunkLimit?: number;
  /** Webhook URL for inbound messages from Linq. */
  webhookUrl?: string;
  /** Webhook HMAC signing secret. */
  webhookSecret?: string;
  /** Local HTTP path prefix for the webhook listener (default: /linq-webhook). */
  webhookPath?: string;
  /** Local HTTP host to bind the webhook listener on. */
  webhookHost?: string;
  /** History limit for group chats. */
  historyLimit?: number;
  /** Block streaming responses. */
  blockStreaming?: boolean;
  /** Group configs keyed by chat_id. */
  groups?: Record<string, unknown>;
  /** Per-account sub-accounts. */
  accounts?: Record<string, LinqAccountConfig>;
};
