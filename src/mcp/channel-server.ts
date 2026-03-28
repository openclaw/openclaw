import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadConfig, type OpenClawConfig } from "../config/config.js";
import { buildGatewayConnectionDetails } from "../gateway/call.js";
import { GatewayClient } from "../gateway/client.js";
import { resolveGatewayConnectionAuth } from "../gateway/connection-auth.js";
import { APPROVALS_SCOPE, READ_SCOPE, WRITE_SCOPE } from "../gateway/method-scopes.js";
import type { EventFrame } from "../gateway/protocol/index.js";
import { extractFirstTextBlock } from "../shared/chat-message-content.js";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
  normalizeMessageChannel,
} from "../utils/message-channel.js";
import { VERSION } from "../version.js";

type ClaudeChannelMode = "off" | "on" | "auto";

export type OpenClawMcpServeOptions = {
  gatewayUrl?: string;
  gatewayToken?: string;
  gatewayPassword?: string;
  config?: OpenClawConfig;
  claudeChannelMode?: ClaudeChannelMode;
  verbose?: boolean;
};

type ConversationDescriptor = {
  sessionKey: string;
  channel: string;
  to: string;
  accountId?: string;
  threadId?: string | number;
  label?: string;
  displayName?: string;
  derivedTitle?: string;
  lastMessagePreview?: string;
  updatedAt?: number | null;
};

type SessionRow = {
  key: string;
  channel?: string;
  lastChannel?: string;
  lastTo?: string;
  lastAccountId?: string;
  lastThreadId?: string | number;
  deliveryContext?: {
    channel?: string;
    to?: string;
    accountId?: string;
    threadId?: string | number;
  };
  origin?: {
    provider?: string;
    accountId?: string;
    threadId?: string | number;
  };
  label?: string;
  displayName?: string;
  derivedTitle?: string;
  lastMessagePreview?: string;
  updatedAt?: number | null;
};

type SessionListResult = {
  sessions?: SessionRow[];
};

type ChatHistoryResult = {
  messages?: Array<{ id?: string; role?: string; content?: unknown; [key: string]: unknown }>;
};

type SessionMessagePayload = {
  sessionKey?: string;
  messageId?: string;
  messageSeq?: number;
  message?: { role?: string; content?: unknown; [key: string]: unknown };
  lastChannel?: string;
  lastTo?: string;
  lastAccountId?: string;
  lastThreadId?: string | number;
  [key: string]: unknown;
};

type ApprovalKind = "exec" | "plugin";
type ApprovalDecision = "allow-once" | "allow-always" | "deny";

type PendingApproval = {
  kind: ApprovalKind;
  id: string;
  request?: Record<string, unknown>;
  createdAtMs?: number;
  expiresAtMs?: number;
};

type QueueEvent =
  | {
      cursor: number;
      type: "message";
      sessionKey: string;
      conversation?: ConversationDescriptor;
      messageId?: string;
      messageSeq?: number;
      role?: string;
      text?: string;
      raw: SessionMessagePayload;
    }
  | {
      cursor: number;
      type: "claude_permission_request";
      requestId: string;
      toolName: string;
      description: string;
      inputPreview: string;
    }
  | {
      cursor: number;
      type: "exec_approval_requested" | "exec_approval_resolved";
      raw: Record<string, unknown>;
    }
  | {
      cursor: number;
      type: "plugin_approval_requested" | "plugin_approval_resolved";
      raw: Record<string, unknown>;
    };

type ClaudePermissionRequest = {
  toolName: string;
  description: string;
  inputPreview: string;
};

type ServerNotification = {
  method: string;
  params?: Record<string, unknown>;
};

type WaitFilter = {
  afterCursor: number;
  sessionKey?: string;
};

type PendingWaiter = {
  filter: WaitFilter;
  resolve: (value: QueueEvent | null) => void;
  timeout: NodeJS.Timeout | null;
};

const CLAUDE_PERMISSION_REPLY_RE = /^(yes|no)\s+([a-km-z]{5})$/i;
const QUEUE_LIMIT = 1_000;

const ClaudePermissionRequestSchema = z.object({
  method: z.literal("notifications/claude/channel/permission_request"),
  params: z.object({
    request_id: z.string(),
    tool_name: z.string(),
    description: z.string(),
    input_preview: z.string(),
  }),
});

function toText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function summarizeResult(
  label: string,
  count: number,
): { content: Array<{ type: "text"; text: string }> } {
  return {
    content: [{ type: "text", text: `${label}: ${count}` }],
  };
}

function resolveConversationChannel(row: SessionRow): string | undefined {
  return normalizeMessageChannel(
    toText(row.deliveryContext?.channel) ??
      toText(row.lastChannel) ??
      toText(row.channel) ??
      toText(row.origin?.provider),
  );
}

function toConversation(row: SessionRow): ConversationDescriptor | null {
  const channel = resolveConversationChannel(row);
  const to = toText(row.deliveryContext?.to) ?? toText(row.lastTo);
  if (!channel || !to) {
    return null;
  }
  return {
    sessionKey: row.key,
    channel,
    to,
    accountId:
      toText(row.deliveryContext?.accountId) ??
      toText(row.lastAccountId) ??
      toText(row.origin?.accountId),
    threadId: row.deliveryContext?.threadId ?? row.lastThreadId ?? row.origin?.threadId,
    label: toText(row.label),
    displayName: toText(row.displayName),
    derivedTitle: toText(row.derivedTitle),
    lastMessagePreview: toText(row.lastMessagePreview),
    updatedAt: typeof row.updatedAt === "number" ? row.updatedAt : null,
  };
}

function matchEventFilter(event: QueueEvent, filter: WaitFilter): boolean {
  if (event.cursor <= filter.afterCursor) {
    return false;
  }
  if (!filter.sessionKey) {
    return true;
  }
  return "sessionKey" in event && event.sessionKey === filter.sessionKey;
}

function extractAttachmentsFromMessage(message: unknown): unknown[] {
  if (!message || typeof message !== "object") {
    return [];
  }
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return [];
  }
  return content.filter((entry) => {
    if (!entry || typeof entry !== "object") {
      return false;
    }
    return toText((entry as { type?: unknown }).type) !== "text";
  });
}

function normalizeApprovalId(value: unknown): string | undefined {
  const id = toText(value);
  return id ? id.trim() : undefined;
}

export class OpenClawChannelBridge {
  private gateway: GatewayClient | null = null;
  private readonly verbose: boolean;
  private readonly claudeChannelMode: ClaudeChannelMode;
  private readonly queue: QueueEvent[] = [];
  private readonly pendingWaiters = new Set<PendingWaiter>();
  private readonly pendingClaudePermissions = new Map<string, ClaudePermissionRequest>();
  private readonly pendingApprovals = new Map<string, PendingApproval>();
  private server: McpServer | null = null;
  private cursor = 0;
  private closed = false;
  private ready = false;
  private started = false;
  private readonly readyPromise: Promise<void>;
  private resolveReady!: () => void;
  private rejectReady!: (error: Error) => void;
  private readySettled = false;

  constructor(
    private readonly cfg: OpenClawConfig,
    private readonly params: {
      gatewayUrl?: string;
      gatewayToken?: string;
      gatewayPassword?: string;
      claudeChannelMode: ClaudeChannelMode;
      verbose: boolean;
    },
  ) {
    this.verbose = params.verbose;
    this.claudeChannelMode = params.claudeChannelMode;
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
  }

  setServer(server: McpServer): void {
    this.server = server;
  }

  async start(): Promise<void> {
    if (this.started) {
      await this.readyPromise;
      return;
    }
    this.started = true;
    const connection = buildGatewayConnectionDetails({
      config: this.cfg,
      url: this.params.gatewayUrl,
    });
    const gatewayUrlOverrideSource =
      connection.urlSource === "cli --url"
        ? "cli"
        : connection.urlSource === "env OPENCLAW_GATEWAY_URL"
          ? "env"
          : undefined;
    const creds = await resolveGatewayConnectionAuth({
      config: this.cfg,
      explicitAuth: {
        token: this.params.gatewayToken,
        password: this.params.gatewayPassword,
      },
      env: process.env,
      urlOverride: gatewayUrlOverrideSource ? connection.url : undefined,
      urlOverrideSource: gatewayUrlOverrideSource,
    });
    if (this.closed) {
      this.resolveReadyOnce();
      return;
    }

    this.gateway = new GatewayClient({
      url: connection.url,
      token: creds.token,
      password: creds.password,
      clientName: GATEWAY_CLIENT_NAMES.CLI,
      clientDisplayName: "OpenClaw MCP",
      clientVersion: VERSION,
      mode: GATEWAY_CLIENT_MODES.CLI,
      scopes: [READ_SCOPE, WRITE_SCOPE, APPROVALS_SCOPE],
      onEvent: (event) => {
        void this.handleGatewayEvent(event);
      },
      onHelloOk: () => {
        void this.handleHelloOk();
      },
      onConnectError: (error) => {
        this.rejectReadyOnce(error instanceof Error ? error : new Error(String(error)));
      },
      onClose: (code, reason) => {
        if (!this.ready && !this.closed) {
          this.rejectReadyOnce(new Error(`gateway closed before ready (${code}): ${reason}`));
        }
      },
    });
    this.gateway.start();
    await this.readyPromise;
  }

  async waitUntilReady(): Promise<void> {
    await this.readyPromise;
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.resolveReadyOnce();
    for (const waiter of this.pendingWaiters) {
      if (waiter.timeout) {
        clearTimeout(waiter.timeout);
      }
      waiter.resolve(null);
    }
    this.pendingWaiters.clear();
    const gateway = this.gateway;
    this.gateway = null;
    await gateway?.stopAndWait().catch(() => undefined);
  }

  async listConversations(params?: {
    limit?: number;
    search?: string;
    channel?: string;
    includeDerivedTitles?: boolean;
    includeLastMessage?: boolean;
  }): Promise<ConversationDescriptor[]> {
    await this.waitUntilReady();
    const response = await this.requestGateway<SessionListResult>("sessions.list", {
      limit: params?.limit ?? 50,
      search: params?.search,
      includeDerivedTitles: params?.includeDerivedTitles ?? true,
      includeLastMessage: params?.includeLastMessage ?? true,
    });
    const requestedChannel = toText(params?.channel)?.toLowerCase();
    return (response.sessions ?? [])
      .map(toConversation)
      .filter((conversation): conversation is ConversationDescriptor => Boolean(conversation))
      .filter((conversation) =>
        requestedChannel ? conversation.channel.toLowerCase() === requestedChannel : true,
      );
  }

  async getConversation(sessionKey: string): Promise<ConversationDescriptor | null> {
    const normalizedSessionKey = sessionKey.trim();
    if (!normalizedSessionKey) {
      return null;
    }
    const conversations = await this.listConversations({ limit: 500, includeLastMessage: true });
    return (
      conversations.find((conversation) => conversation.sessionKey === normalizedSessionKey) ?? null
    );
  }

  async readMessages(
    sessionKey: string,
    limit = 20,
  ): Promise<NonNullable<ChatHistoryResult["messages"]>> {
    await this.waitUntilReady();
    const response = await this.requestGateway<ChatHistoryResult>("chat.history", {
      sessionKey,
      limit,
    });
    return response.messages ?? [];
  }

  async sendMessage(params: {
    sessionKey: string;
    text: string;
  }): Promise<Record<string, unknown>> {
    const conversation = await this.getConversation(params.sessionKey);
    if (!conversation) {
      throw new Error(`Conversation not found for session ${params.sessionKey}`);
    }
    return await this.requestGateway("send", {
      to: conversation.to,
      channel: conversation.channel,
      accountId: conversation.accountId,
      threadId: conversation.threadId == null ? undefined : String(conversation.threadId),
      message: params.text,
      sessionKey: conversation.sessionKey,
      idempotencyKey: randomUUID(),
    });
  }

  listPendingApprovals(): PendingApproval[] {
    return [...this.pendingApprovals.values()].toSorted((a, b) => {
      return (a.createdAtMs ?? 0) - (b.createdAtMs ?? 0);
    });
  }

  async respondToApproval(params: {
    kind: ApprovalKind;
    id: string;
    decision: ApprovalDecision;
  }): Promise<Record<string, unknown>> {
    if (params.kind === "exec") {
      return await this.requestGateway("exec.approval.resolve", {
        id: params.id,
        decision: params.decision,
      });
    }
    return await this.requestGateway("plugin.approval.resolve", {
      id: params.id,
      decision: params.decision,
    });
  }

  pollEvents(filter: WaitFilter, limit = 20): { events: QueueEvent[]; nextCursor: number } {
    const events = this.queue.filter((event) => matchEventFilter(event, filter)).slice(0, limit);
    const nextCursor = events.at(-1)?.cursor ?? filter.afterCursor;
    return { events, nextCursor };
  }

  async waitForEvent(filter: WaitFilter, timeoutMs = 30_000): Promise<QueueEvent | null> {
    const existing = this.queue.find((event) => matchEventFilter(event, filter));
    if (existing) {
      return existing;
    }
    return await new Promise<QueueEvent | null>((resolve) => {
      const waiter: PendingWaiter = {
        filter,
        resolve: (value) => {
          this.pendingWaiters.delete(waiter);
          resolve(value);
        },
        timeout: null,
      };
      if (timeoutMs > 0) {
        waiter.timeout = setTimeout(() => {
          waiter.resolve(null);
        }, timeoutMs);
      }
      this.pendingWaiters.add(waiter);
    });
  }

  async handleClaudePermissionRequest(params: {
    requestId: string;
    toolName: string;
    description: string;
    inputPreview: string;
  }): Promise<void> {
    this.pendingClaudePermissions.set(params.requestId, {
      toolName: params.toolName,
      description: params.description,
      inputPreview: params.inputPreview,
    });
    this.enqueue({
      cursor: this.nextCursor(),
      type: "claude_permission_request",
      requestId: params.requestId,
      toolName: params.toolName,
      description: params.description,
      inputPreview: params.inputPreview,
    });
    if (this.verbose) {
      process.stderr.write(`openclaw mcp: pending Claude permission ${params.requestId}\n`);
    }
  }

  private async requestGateway<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown>,
  ): Promise<T> {
    if (!this.gateway) {
      throw new Error("Gateway client is not ready");
    }
    return await this.gateway.request<T>(method, params);
  }

  private async requestNoThrow(method: string, params: Record<string, unknown>): Promise<void> {
    try {
      await this.requestGateway(method, params);
    } catch (error) {
      if (this.verbose) {
        process.stderr.write(`openclaw mcp: ${method} failed: ${String(error)}\n`);
      }
    }
  }

  private async sendNotification(notification: ServerNotification): Promise<void> {
    if (!this.server || this.closed) {
      return;
    }
    try {
      await this.server.server.notification(notification);
    } catch (error) {
      if (this.verbose && !this.closed) {
        process.stderr.write(
          `openclaw mcp: notification ${notification.method} failed: ${String(error)}\n`,
        );
      }
    }
  }

  private async handleHelloOk(): Promise<void> {
    try {
      await this.requestGateway("sessions.subscribe", {});
      this.ready = true;
      this.resolveReadyOnce();
    } catch (error) {
      this.rejectReadyOnce(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private resolveReadyOnce(): void {
    if (this.readySettled) {
      return;
    }
    this.readySettled = true;
    this.resolveReady();
  }

  private rejectReadyOnce(error: Error): void {
    if (this.readySettled) {
      return;
    }
    this.readySettled = true;
    this.rejectReady(error);
  }

  private nextCursor(): number {
    this.cursor += 1;
    return this.cursor;
  }

  private enqueue(event: QueueEvent): void {
    this.queue.push(event);
    while (this.queue.length > QUEUE_LIMIT) {
      this.queue.shift();
    }
    for (const waiter of this.pendingWaiters) {
      if (!matchEventFilter(event, waiter.filter)) {
        continue;
      }
      if (waiter.timeout) {
        clearTimeout(waiter.timeout);
      }
      waiter.resolve(event);
    }
  }

  private trackApproval(kind: ApprovalKind, payload: Record<string, unknown>): void {
    const id = normalizeApprovalId(payload.id);
    if (!id) {
      return;
    }
    this.pendingApprovals.set(id, {
      kind,
      id,
      request:
        payload.request && typeof payload.request === "object"
          ? (payload.request as Record<string, unknown>)
          : undefined,
      createdAtMs: typeof payload.createdAtMs === "number" ? payload.createdAtMs : undefined,
      expiresAtMs: typeof payload.expiresAtMs === "number" ? payload.expiresAtMs : undefined,
    });
  }

  private resolveTrackedApproval(payload: Record<string, unknown>): void {
    const id = normalizeApprovalId(payload.id);
    if (id) {
      this.pendingApprovals.delete(id);
    }
  }

  private async handleGatewayEvent(event: EventFrame): Promise<void> {
    if (event.event === "session.message") {
      await this.handleSessionMessageEvent(event.payload as SessionMessagePayload);
      return;
    }
    if (event.event === "exec.approval.requested") {
      const raw = (event.payload ?? {}) as Record<string, unknown>;
      this.trackApproval("exec", raw);
      this.enqueue({
        cursor: this.nextCursor(),
        type: "exec_approval_requested",
        raw,
      });
      return;
    }
    if (event.event === "exec.approval.resolved") {
      const raw = (event.payload ?? {}) as Record<string, unknown>;
      this.resolveTrackedApproval(raw);
      this.enqueue({
        cursor: this.nextCursor(),
        type: "exec_approval_resolved",
        raw,
      });
      return;
    }
    if (event.event === "plugin.approval.requested") {
      const raw = (event.payload ?? {}) as Record<string, unknown>;
      this.trackApproval("plugin", raw);
      this.enqueue({
        cursor: this.nextCursor(),
        type: "plugin_approval_requested",
        raw,
      });
      return;
    }
    if (event.event === "plugin.approval.resolved") {
      const raw = (event.payload ?? {}) as Record<string, unknown>;
      this.resolveTrackedApproval(raw);
      this.enqueue({
        cursor: this.nextCursor(),
        type: "plugin_approval_resolved",
        raw,
      });
    }
  }

  private async handleSessionMessageEvent(payload: SessionMessagePayload): Promise<void> {
    const sessionKey = toText(payload.sessionKey);
    if (!sessionKey) {
      return;
    }
    const conversation =
      toConversation({
        key: sessionKey,
        lastChannel: toText(payload.lastChannel),
        lastTo: toText(payload.lastTo),
        lastAccountId: toText(payload.lastAccountId),
        lastThreadId: payload.lastThreadId,
      }) ?? undefined;
    const role = toText(payload.message?.role);
    const text = extractFirstTextBlock(payload.message);
    const permissionMatch = text ? CLAUDE_PERMISSION_REPLY_RE.exec(text) : null;
    if (permissionMatch) {
      const requestId = permissionMatch[2]?.toLowerCase();
      if (requestId && this.pendingClaudePermissions.has(requestId)) {
        this.pendingClaudePermissions.delete(requestId);
        await this.sendNotification({
          method: "notifications/claude/channel/permission",
          params: {
            request_id: requestId,
            behavior: permissionMatch[1]?.toLowerCase().startsWith("y") ? "allow" : "deny",
          },
        });
        return;
      }
    }

    this.enqueue({
      cursor: this.nextCursor(),
      type: "message",
      sessionKey,
      conversation,
      messageId: toText(payload.messageId),
      messageSeq: typeof payload.messageSeq === "number" ? payload.messageSeq : undefined,
      role,
      text,
      raw: payload,
    });

    if (!this.shouldEmitClaudeChannel(role, conversation)) {
      return;
    }
    await this.sendNotification({
      method: "notifications/claude/channel",
      params: {
        content: text ?? "[non-text message]",
        meta: {
          session_key: sessionKey,
          channel: conversation?.channel ?? "",
          to: conversation?.to ?? "",
          account_id: conversation?.accountId ?? "",
          thread_id: conversation?.threadId == null ? "" : String(conversation.threadId),
          message_id: toText(payload.messageId) ?? "",
        },
      },
    });
  }

  private shouldEmitClaudeChannel(
    role: string | undefined,
    conversation: ConversationDescriptor | undefined,
  ): boolean {
    if (this.claudeChannelMode === "off") {
      return false;
    }
    if (role !== "user") {
      return false;
    }
    return Boolean(conversation);
  }
}

export async function createOpenClawChannelMcpServer(opts: OpenClawMcpServeOptions = {}): Promise<{
  server: McpServer;
  bridge: OpenClawChannelBridge;
  start: () => Promise<void>;
  close: () => Promise<void>;
}> {
  const cfg = opts.config ?? loadConfig();
  const claudeChannelMode = opts.claudeChannelMode ?? "auto";
  const capabilities =
    claudeChannelMode === "off"
      ? undefined
      : {
          experimental: {
            "claude/channel": {},
            "claude/channel/permission": {},
          },
        };

  const server = new McpServer(
    { name: "openclaw", version: VERSION },
    capabilities ? { capabilities } : undefined,
  );
  const bridge = new OpenClawChannelBridge(cfg, {
    gatewayUrl: opts.gatewayUrl,
    gatewayToken: opts.gatewayToken,
    gatewayPassword: opts.gatewayPassword,
    claudeChannelMode,
    verbose: opts.verbose ?? false,
  });
  bridge.setServer(server);

  server.server.setNotificationHandler(ClaudePermissionRequestSchema, async ({ params }) => {
    await bridge.handleClaudePermissionRequest({
      requestId: params.request_id,
      toolName: params.tool_name,
      description: params.description,
      inputPreview: params.input_preview,
    });
  });

  server.tool(
    "conversations_list",
    "List OpenClaw channel-backed conversations available through session routes.",
    {
      limit: z.number().int().min(1).max(500).optional(),
      search: z.string().optional(),
      channel: z.string().optional(),
      includeDerivedTitles: z.boolean().optional(),
      includeLastMessage: z.boolean().optional(),
    },
    async (args) => {
      const conversations = await bridge.listConversations(args);
      return {
        ...summarizeResult("conversations", conversations.length),
        structuredContent: { conversations },
      };
    },
  );

  server.tool(
    "conversation_get",
    "Get one OpenClaw conversation by session key.",
    { session_key: z.string().min(1) },
    async ({ session_key }) => {
      const conversation = await bridge.getConversation(session_key);
      if (!conversation) {
        return {
          content: [{ type: "text", text: `conversation not found: ${session_key}` }],
          isError: true,
        };
      }
      return {
        content: [{ type: "text", text: `conversation ${conversation.sessionKey}` }],
        structuredContent: { conversation },
      };
    },
  );

  server.tool(
    "messages_read",
    "Read recent messages for one OpenClaw conversation.",
    {
      session_key: z.string().min(1),
      limit: z.number().int().min(1).max(200).optional(),
    },
    async ({ session_key, limit }) => {
      const messages = await bridge.readMessages(session_key, limit ?? 20);
      return {
        ...summarizeResult("messages", messages.length),
        structuredContent: { messages },
      };
    },
  );

  server.tool(
    "attachments_fetch",
    "List non-text attachments for a message in one OpenClaw conversation.",
    {
      session_key: z.string().min(1),
      message_id: z.string().min(1),
      limit: z.number().int().min(1).max(200).optional(),
    },
    async ({ session_key, message_id, limit }) => {
      const messages = await bridge.readMessages(session_key, limit ?? 100);
      const message = messages.find((entry) => toText(entry.id) === message_id);
      if (!message) {
        return {
          content: [{ type: "text", text: `message not found: ${message_id}` }],
          isError: true,
        };
      }
      const attachments = extractAttachmentsFromMessage(message);
      return {
        ...summarizeResult("attachments", attachments.length),
        structuredContent: { attachments, message },
      };
    },
  );

  server.tool(
    "events_poll",
    "Poll queued OpenClaw conversation events since a cursor.",
    {
      after_cursor: z.number().int().min(0).optional(),
      session_key: z.string().optional(),
      limit: z.number().int().min(1).max(200).optional(),
    },
    async ({ after_cursor, session_key, limit }) => {
      const { events, nextCursor } = bridge.pollEvents(
        { afterCursor: after_cursor ?? 0, sessionKey: toText(session_key) },
        limit ?? 20,
      );
      return {
        ...summarizeResult("events", events.length),
        structuredContent: { events, next_cursor: nextCursor },
      };
    },
  );

  server.tool(
    "events_wait",
    "Wait for the next queued OpenClaw conversation event.",
    {
      after_cursor: z.number().int().min(0).optional(),
      session_key: z.string().optional(),
      timeout_ms: z.number().int().min(1).max(300_000).optional(),
    },
    async ({ after_cursor, session_key, timeout_ms }) => {
      const event = await bridge.waitForEvent(
        { afterCursor: after_cursor ?? 0, sessionKey: toText(session_key) },
        timeout_ms ?? 30_000,
      );
      return {
        content: [{ type: "text", text: event ? `event ${event.cursor}` : "timeout" }],
        structuredContent: { event },
      };
    },
  );

  server.tool(
    "messages_send",
    "Send a message back through the same OpenClaw conversation route.",
    {
      session_key: z.string().min(1),
      text: z.string().min(1),
    },
    async ({ session_key, text }) => {
      const result = await bridge.sendMessage({ sessionKey: session_key, text });
      return {
        content: [{ type: "text", text: "sent" }],
        structuredContent: { result },
      };
    },
  );

  server.tool(
    "permissions_list_open",
    "List open OpenClaw exec or plugin approval requests visible through the Gateway.",
    {},
    async () => {
      const approvals = bridge.listPendingApprovals();
      return {
        ...summarizeResult("approvals", approvals.length),
        structuredContent: { approvals },
      };
    },
  );

  server.tool(
    "permissions_respond",
    "Allow or deny one pending OpenClaw exec or plugin approval request.",
    {
      kind: z.enum(["exec", "plugin"]),
      id: z.string().min(1),
      decision: z.enum(["allow-once", "allow-always", "deny"]),
    },
    async ({ kind, id, decision }) => {
      const result = await bridge.respondToApproval({ kind, id, decision });
      return {
        content: [{ type: "text", text: "approval resolved" }],
        structuredContent: { result },
      };
    },
  );

  return {
    server,
    bridge,
    start: async () => {
      await bridge.start();
    },
    close: async () => {
      await bridge.close();
      await server.close();
    },
  };
}

export async function serveOpenClawChannelMcp(opts: OpenClawMcpServeOptions = {}): Promise<void> {
  const { server, start, close } = await createOpenClawChannelMcpServer(opts);
  const transport = new StdioServerTransport();

  let shuttingDown = false;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });

  const shutdown = () => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    process.stdin.off("end", shutdown);
    process.stdin.off("close", shutdown);
    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
    transport["onclose"] = undefined;
    void close().finally(resolveClosed);
  };

  transport["onclose"] = shutdown;
  process.stdin.once("end", shutdown);
  process.stdin.once("close", shutdown);
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  try {
    await server.connect(transport);
    await start();
    await closed;
  } finally {
    shutdown();
    await closed;
  }
}
