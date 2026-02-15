export const GRAPH_API_BASE = "https://graph.facebook.com/v21.0";

export type MessengerTokenSource = "config" | "env" | "file" | "none";

export interface MessengerConfig {
  enabled?: boolean;
  pageAccessToken?: string;
  appSecret?: string;
  verifyToken?: string;
  tokenFile?: string;
  secretFile?: string;
  name?: string;
  allowFrom?: Array<string | number>;
  dmPolicy?: "open" | "allowlist" | "pairing" | "disabled";
  /** Outbound response prefix override for this channel/account. */
  responsePrefix?: string;
  webhookPath?: string;
  accounts?: Record<string, MessengerAccountConfig>;
}

export interface MessengerAccountConfig {
  enabled?: boolean;
  pageAccessToken?: string;
  appSecret?: string;
  verifyToken?: string;
  tokenFile?: string;
  secretFile?: string;
  name?: string;
  allowFrom?: Array<string | number>;
  dmPolicy?: "open" | "allowlist" | "pairing" | "disabled";
  /** Outbound response prefix override for this account. */
  responsePrefix?: string;
  webhookPath?: string;
}

export interface ResolvedMessengerAccount {
  accountId: string;
  name?: string;
  enabled: boolean;
  pageAccessToken: string;
  appSecret: string;
  verifyToken: string;
  tokenSource: MessengerTokenSource;
  config: MessengerConfig & MessengerAccountConfig;
}

export interface MessengerSendResult {
  messageId: string;
  chatId: string;
}

export interface MessengerProbeResult {
  ok: boolean;
  page?: {
    name?: string;
    id?: string;
  };
  error?: string;
}

// Webhook payload types from Meta Graph API
export interface MessengerWebhookBody {
  object: string;
  entry: MessengerWebhookEntry[];
}

export interface MessengerWebhookEntry {
  id: string;
  time: number;
  messaging: MessengerMessagingEvent[];
}

export interface MessengerMessagingEvent {
  sender: { id: string };
  recipient: { id: string };
  timestamp: number;
  message?: MessengerInboundMessage;
  postback?: MessengerPostback;
  read?: { watermark: number };
  delivery?: { watermark: number };
}

export interface MessengerInboundMessage {
  mid: string;
  text?: string;
  attachments?: MessengerAttachment[];
  /** True when this message is an echo of a message sent by the page itself. */
  is_echo?: boolean;
  app_id?: number;
}

export interface MessengerAttachment {
  type: "image" | "video" | "audio" | "file" | "location" | "fallback";
  payload: {
    url?: string;
    coordinates?: { lat: number; long: number };
    title?: string;
  };
}

export interface MessengerPostback {
  title: string;
  payload: string;
}
