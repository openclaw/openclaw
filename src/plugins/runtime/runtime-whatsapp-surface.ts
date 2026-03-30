import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { AnyMessageContent, makeWASocket } from "@whiskeysockets/baileys";
import type { NormalizedLocation } from "../../channels/location.js";
import type { ChannelAgentTool } from "../../channels/plugins/types.core.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { PollInput } from "../../polls.js";
import type { RuntimeEnv } from "../../runtime.js";
import type { WebChannel } from "../../utils.js";

export type ActiveWebSendOptions = {
  gifPlayback?: boolean;
  accountId?: string;
  fileName?: string;
};

export type ActiveWebListener = {
  sendMessage: (
    to: string,
    text: string,
    mediaBuffer?: Buffer,
    mediaType?: string,
    options?: ActiveWebSendOptions,
  ) => Promise<{ messageId: string }>;
  sendPoll: (to: string, poll: PollInput) => Promise<{ messageId: string }>;
  sendReaction: (
    chatJid: string,
    messageId: string,
    emoji: string,
    fromMe: boolean,
    participant?: string,
  ) => Promise<void>;
  sendComposingTo: (to: string) => Promise<void>;
  close?: () => Promise<void>;
};

export type WebListenerCloseReason = {
  status?: number;
  isLoggedOut: boolean;
  error?: unknown;
};

export type WebInboundMessage = {
  id?: string;
  from: string;
  conversationId: string;
  to: string;
  accountId: string;
  body: string;
  pushName?: string;
  timestamp?: number;
  chatType: "direct" | "group";
  chatId: string;
  sender?: unknown;
  senderJid?: string;
  senderE164?: string;
  senderName?: string;
  replyTo?: unknown;
  replyToId?: string;
  replyToBody?: string;
  replyToSender?: string;
  replyToSenderJid?: string;
  replyToSenderE164?: string;
  groupSubject?: string;
  groupParticipants?: string[];
  mentions?: string[];
  mentionedJids?: string[];
  self?: unknown;
  selfJid?: string | null;
  selfLid?: string | null;
  selfE164?: string | null;
  fromMe?: boolean;
  location?: NormalizedLocation;
  sendComposing: () => Promise<void>;
  reply: (text: string) => Promise<void>;
  sendMedia: (payload: AnyMessageContent) => Promise<void>;
  mediaPath?: string;
  mediaType?: string;
  mediaFileName?: string;
  mediaUrl?: string;
  wasMentioned?: boolean;
};

export type WebChannelHealthState =
  | "starting"
  | "healthy"
  | "stale"
  | "reconnecting"
  | "conflict"
  | "logged-out"
  | "stopped";

export type WebChannelStatus = {
  running: boolean;
  connected: boolean;
  reconnectAttempts: number;
  lastConnectedAt?: number | null;
  lastDisconnect?: {
    at: number;
    status?: number;
    error?: string;
    loggedOut?: boolean;
  } | null;
  lastInboundAt?: number | null;
  lastMessageAt?: number | null;
  lastEventAt?: number | null;
  lastError?: string | null;
  healthState?: WebChannelHealthState;
};

export type WebMonitorTuning = {
  reconnect?: Partial<{
    enabled: boolean;
    maxAttempts: number;
    baseDelayMs: number;
    maxDelayMs: number;
  }>;
  heartbeatSeconds?: number;
  messageTimeoutMs?: number;
  watchdogCheckMs?: number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  statusSink?: (status: WebChannelStatus) => void;
  accountId?: string;
  debounceMs?: number;
};

export type MonitorWebInboxFactory = (options: {
  verbose: boolean;
  accountId: string;
  authDir: string;
  onMessage: (msg: WebInboundMessage) => Promise<void>;
  mediaMaxMb?: number;
  sendReadReceipts?: boolean;
  debounceMs?: number;
  shouldDebounce?: (msg: WebInboundMessage) => boolean;
}) => Promise<{
  closeReason: Promise<WebListenerCloseReason>;
  stop: () => Promise<void>;
}>;

export type ReplyResolver = (...args: unknown[]) => Promise<unknown>;

export type WhatsAppWaSocket = ReturnType<typeof makeWASocket>;

export type WhatsAppLightRuntimeModule = {
  getActiveWebListener: (accountId?: string | null) => ActiveWebListener | null;
  getWebAuthAgeMs: (authDir?: string) => number | null;
  logWebSelfId: (authDir?: string, runtime?: RuntimeEnv, includeChannelPrefix?: boolean) => void;
  logoutWeb: (params: {
    authDir?: string;
    isLegacyAuthDir?: boolean;
    runtime?: RuntimeEnv;
  }) => Promise<boolean>;
  readWebSelfId: (authDir?: string) => {
    e164: string | null;
    jid: string | null;
    lid: string | null;
  };
  webAuthExists: (authDir?: string) => Promise<boolean>;
  createWhatsAppLoginTool: () => ChannelAgentTool;
  formatError: (err: unknown) => string;
  getStatusCode: (err: unknown) => number | undefined;
  pickWebChannel: (pref: WebChannel | "auto", authDir?: string) => Promise<WebChannel>;
  WA_WEB_AUTH_DIR: string;
};

export type WhatsAppHeavyRuntimeModule = {
  loginWeb: (
    verbose: boolean,
    waitForConnection?: (sock: WhatsAppWaSocket) => Promise<void>,
    runtime?: RuntimeEnv,
    accountId?: string,
  ) => Promise<void>;
  sendMessageWhatsApp: (
    to: string,
    body: string,
    options: {
      verbose: boolean;
      cfg?: OpenClawConfig;
      mediaUrl?: string;
      mediaLocalRoots?: readonly string[];
      gifPlayback?: boolean;
      accountId?: string;
    },
  ) => Promise<{ messageId: string; toJid: string }>;
  sendPollWhatsApp: (
    to: string,
    poll: PollInput,
    options: { verbose: boolean; accountId?: string; cfg?: OpenClawConfig },
  ) => Promise<{ messageId: string; toJid: string }>;
  sendReactionWhatsApp: (
    chatJid: string,
    messageId: string,
    emoji: string,
    options: {
      verbose: boolean;
      fromMe?: boolean;
      participant?: string;
      accountId?: string;
    },
  ) => Promise<void>;
  createWaSocket: (
    printQr: boolean,
    verbose: boolean,
    opts?: { authDir?: string; onQr?: (qr: string) => void },
  ) => Promise<WhatsAppWaSocket>;
  handleWhatsAppAction: (
    params: Record<string, unknown>,
    cfg: OpenClawConfig,
  ) => Promise<AgentToolResult<unknown>>;
  monitorWebChannel: (
    verbose: boolean,
    listenerFactory?: MonitorWebInboxFactory,
    keepAlive?: boolean,
    replyResolver?: ReplyResolver,
    runtime?: RuntimeEnv,
    abortSignal?: AbortSignal,
    tuning?: WebMonitorTuning,
  ) => Promise<void>;
  monitorWebInbox: MonitorWebInboxFactory;
  runWebHeartbeatOnce: (opts: {
    cfg?: OpenClawConfig;
    to: string;
    verbose?: boolean;
    replyResolver?: ReplyResolver;
    sender?: WhatsAppHeavyRuntimeModule["sendMessageWhatsApp"];
    sessionId?: string;
    overrideBody?: string;
    dryRun?: boolean;
  }) => Promise<void>;
  startWebLoginWithQr: (opts?: {
    verbose?: boolean;
    timeoutMs?: number;
    force?: boolean;
    accountId?: string;
    runtime?: RuntimeEnv;
  }) => Promise<{ qrDataUrl?: string; message: string }>;
  waitForWaConnection: (sock: WhatsAppWaSocket) => Promise<void>;
  waitForWebLogin: (opts?: {
    timeoutMs?: number;
    runtime?: RuntimeEnv;
    accountId?: string;
  }) => Promise<{ connected: boolean; message: string }>;
  extractMediaPlaceholder: (
    message: unknown,
    mediaDir: string,
    verbose?: boolean,
  ) => Promise<string | null>;
  extractText: (message: unknown) => string;
};
