import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { OpenClawConfig } from "../config/config.js";
import { buildGatewayConnectionDetails } from "../gateway/call.js";
import { GatewayClient } from "../gateway/client.js";
import { resolveGatewayConnectionAuth } from "../gateway/connection-auth.js";
import { APPROVALS_SCOPE, READ_SCOPE, WRITE_SCOPE } from "../gateway/method-scopes.js";
import type { EventFrame } from "../gateway/protocol/index.js";
import { extractFirstTextBlock } from "../shared/chat-message-content.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { VERSION } from "../version.js";
import type {
  ApprovalDecision,
  ApprovalKind,
  ChatHistoryResult,
  ClaudeChannelMode,
  ClaudePermissionRequest,
  ConversationDescriptor,
  PendingApproval,
  QueueEvent,
  SessionListResult,
  SessionMessagePayload,
  WaitFilter,
} from "./channel-shared.js";
import { matchEventFilter, normalizeApprovalId, toConversation, toText } from "./channel-shared.js";

type PendingWaiter = {
  filter: WaitFilter;
  resolve: (value: QueueEvent | null) => void;
  timeout: NodeJS.Timeout | null;
};

type ReadyWaiter = {
  resolve: (value: boolean) => void;
  timeout: NodeJS.Timeout | null;
};

type ServerNotification = {
  method: string;
  params?: Record<string, unknown>;
};

export type OpenClawChannelBridgeState = "idle" | "connecting" | "ready" | "degraded" | "closed";

export type OpenClawChannelBridgeDiagnostics = {
  state: OpenClawChannelBridgeState;
  lastError: {
    name: string;
    message: string;
  } | null;
  lastConnectAttemptAt: string | null;
  lastReadyAt: string | null;
  nextRetryAt: string | null;
  connectionSource: {
    gatewayMode?: "local" | "remote";
    gatewayUrlSource?: string;
    gatewayProtocol?: string;
    gatewayHost?: string;
    hasExplicitToken?: boolean;
    hasExplicitPassword?: boolean;
    hasResolvedToken?: boolean;
    hasResolvedPassword?: boolean;
  } | null;
};

export class GatewayUnavailableError extends Error {
  constructor(
    readonly diagnostics: OpenClawChannelBridgeDiagnostics,
    message = "OpenClaw gateway bridge is unavailable",
  ) {
    super(message);
    this.name = "GatewayUnavailableError";
  }
}

const CLAUDE_PERMISSION_REPLY_RE = /^(yes|no)\s+([a-km-z]{5})$/i;
const QUEUE_LIMIT = 1_000;
const RETRY_BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000];

function nowIso(): string {
  return new Date().toISOString();
}

function sanitizeGatewayTarget(url: string): Pick<
  NonNullable<OpenClawChannelBridgeDiagnostics["connectionSource"]>,
  "gatewayProtocol" | "gatewayHost"
> {
  try {
    const parsed = new URL(url);
    return {
      gatewayProtocol: parsed.protocol.replace(/:$/, ""),
      gatewayHost: parsed.hostname,
    };
  } catch {
    return {};
  }
}

function normalizeError(error: unknown): { name: string; message: string } {
  if (error instanceof Error) {
    return {
      name: error.name || "Error",
      message: error.message || String(error),
    };
  }
  return {
    name: "Error",
    message: String(error),
  };
}

export class OpenClawChannelBridge {
  private gateway: GatewayClient | null = null;
  private readonly verbose: boolean;
  private readonly claudeChannelMode: ClaudeChannelMode;
  private readonly queue: QueueEvent[] = [];
  private readonly pendingWaiters = new Set<PendingWaiter>();
  private readonly readyWaiters = new Set<ReadyWaiter>();
  private readonly pendingClaudePermissions = new Map<string, ClaudePermissionRequest>();
  private readonly pendingApprovals = new Map<string, PendingApproval>();
  private server: McpServer | null = null;
  private cursor = 0;
  private closed = false;
  private ready = false;
  private started = false;
  private state: OpenClawChannelBridgeState = "idle";
  private lastError: OpenClawChannelBridgeDiagnostics["lastError"] = null;
  private lastConnectAttemptAt: string | null = null;
  private lastReadyAt: string | null = null;
  private nextRetryAt: string | null = null;
  private connectionSource: OpenClawChannelBridgeDiagnostics["connectionSource"] = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private retryAttempt = 0;
  private bootstrapPromise: Promise<void> | null = null;
  private resolveReady: () => void = () => {
    this.ready = true;
    this.resolveReadyWaiters(true);
  };
  private readySettled = false;

  constructor(
    private readonly configSource: OpenClawConfig | (() => OpenClawConfig),
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
    this.resolveReady = () => {
      this.ready = true;
      if (!this.readySettled) {
        this.readySettled = true;
      }
      this.resolveReadyWaiters(true);
    };
  }

  setServer(server: McpServer): void {
    this.server = server;
  }

  async start(): Promise<void> {
    if (this.started || this.closed) {
      return;
    }
    this.started = true;
    this.ensureBootstrap();
  }

  async waitUntilReady(timeoutMs = 0): Promise<boolean> {
    if (this.ready) {
      return true;
    }
    if (this.closed) {
      return false;
    }
    if (timeoutMs <= 0) {
      return false;
    }
    return await new Promise<boolean>((resolve) => {
      const waiter: ReadyWaiter = {
        resolve: (value) => {
          this.readyWaiters.delete(waiter);
          resolve(value);
        },
        timeout: null,
      };
      waiter.timeout = setTimeout(() => {
        waiter.resolve(false);
      }, timeoutMs);
      waiter.timeout.unref?.();
      this.readyWaiters.add(waiter);
    });
  }

  async requireReady(timeoutMs = 2_000): Promise<void> {
    const ready = await this.waitUntilReady(timeoutMs);
    if (ready) {
      return;
    }
    throw new GatewayUnavailableError(this.getDiagnostics());
  }

  getDiagnostics(): OpenClawChannelBridgeDiagnostics {
    return {
      state: this.state,
      lastError: this.lastError,
      lastConnectAttemptAt: this.lastConnectAttemptAt,
      lastReadyAt: this.lastReadyAt,
      nextRetryAt: this.nextRetryAt,
      connectionSource: this.connectionSource,
    };
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.state = "closed";
    this.ready = false;
    this.nextRetryAt = null;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.resolveReadyWaiters(false);
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
    await this.requireReady();
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
    await this.requireReady();
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
    await this.requireReady();
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
    await this.requireReady();
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
    await this.requireReady();
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
        waiter.timeout.unref?.();
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

  private ensureBootstrap(): void {
    if (this.closed || this.bootstrapPromise) {
      return;
    }
    this.bootstrapPromise = this.bootstrap().finally(() => {
      this.bootstrapPromise = null;
    });
  }

  private async bootstrap(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.state = "connecting";
    this.ready = false;
    this.lastConnectAttemptAt = nowIso();
    this.nextRetryAt = null;

    let cfg: OpenClawConfig;
    try {
      cfg =
        typeof this.configSource === "function" ? this.configSource() : (this.configSource ?? {});
    } catch (error) {
      this.connectionSource = {
        hasExplicitToken: Boolean(this.params.gatewayToken),
        hasExplicitPassword: Boolean(this.params.gatewayPassword),
      };
      this.markDegraded(error, { scheduleRetry: true });
      return;
    }

    let connection: ReturnType<typeof buildGatewayConnectionDetails>;
    try {
      connection = buildGatewayConnectionDetails({
        config: cfg,
        url: this.params.gatewayUrl,
      });
    } catch (error) {
      this.connectionSource = {
        gatewayMode: cfg.gateway?.mode === "remote" ? "remote" : "local",
        hasExplicitToken: Boolean(this.params.gatewayToken),
        hasExplicitPassword: Boolean(this.params.gatewayPassword),
      };
      this.markDegraded(error, { scheduleRetry: true });
      return;
    }

    const gatewayUrlOverrideSource =
      connection.urlSource === "cli --url"
        ? "cli"
        : connection.urlSource === "env OPENCLAW_GATEWAY_URL"
          ? "env"
          : undefined;

    this.connectionSource = {
      gatewayMode: cfg.gateway?.mode === "remote" ? "remote" : "local",
      gatewayUrlSource: connection.urlSource,
      hasExplicitToken: Boolean(this.params.gatewayToken),
      hasExplicitPassword: Boolean(this.params.gatewayPassword),
      ...sanitizeGatewayTarget(connection.url),
    };

    let creds: { token?: string; password?: string };
    try {
      creds = await resolveGatewayConnectionAuth({
        config: cfg,
        explicitAuth: {
          token: this.params.gatewayToken,
          password: this.params.gatewayPassword,
        },
        env: process.env,
        urlOverride: gatewayUrlOverrideSource ? connection.url : undefined,
        urlOverrideSource: gatewayUrlOverrideSource,
      });
    } catch (error) {
      this.connectionSource = {
        ...this.connectionSource,
        hasResolvedToken: false,
        hasResolvedPassword: false,
      };
      this.markDegraded(error, { scheduleRetry: true });
      return;
    }

    if (this.closed) {
      return;
    }

    this.connectionSource = {
      ...this.connectionSource,
      hasResolvedToken: Boolean(creds.token),
      hasResolvedPassword: Boolean(creds.password),
    };

    const gateway = new GatewayClient({
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
        void this.handleHelloOk(gateway);
      },
      onConnectError: (error) => {
        this.handleGatewayConnectError(gateway, error);
      },
      onClose: (code, reason) => {
        void this.handleGatewayClose(gateway, code, reason);
      },
    });
    this.gateway = gateway;

    try {
      gateway.start();
    } catch (error) {
      if (this.gateway === gateway) {
        this.gateway = null;
      }
      await gateway.stopAndWait().catch(() => undefined);
      this.markDegraded(error, { scheduleRetry: true });
    }
  }

  private markDegraded(
    error: unknown,
    opts: {
      scheduleRetry: boolean;
    },
  ): void {
    if (this.closed) {
      return;
    }
    this.ready = false;
    this.state = "degraded";
    this.lastError = normalizeError(error);
    if (this.verbose) {
      process.stderr.write(`openclaw mcp: bridge degraded: ${this.lastError.message}\n`);
    }
    if (opts.scheduleRetry) {
      this.scheduleRetry();
    }
  }

  private scheduleRetry(): void {
    if (this.closed || this.state === "closed" || this.retryTimer) {
      return;
    }
    const delayMs =
      RETRY_BACKOFF_MS[Math.min(this.retryAttempt, RETRY_BACKOFF_MS.length - 1)] ??
      RETRY_BACKOFF_MS.at(-1) ??
      30_000;
    this.retryAttempt += 1;
    this.nextRetryAt = new Date(Date.now() + delayMs).toISOString();
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.nextRetryAt = null;
      void this.recycleAndBootstrap();
    }, delayMs);
    this.retryTimer.unref?.();
  }

  private async recycleAndBootstrap(): Promise<void> {
    if (this.closed || this.state === "ready") {
      return;
    }
    const gateway = this.gateway;
    this.gateway = null;
    await gateway?.stopAndWait().catch(() => undefined);
    this.ensureBootstrap();
  }

  private resolveReadyWaiters(value: boolean): void {
    for (const waiter of this.readyWaiters) {
      if (waiter.timeout) {
        clearTimeout(waiter.timeout);
      }
      waiter.resolve(value);
    }
    this.readyWaiters.clear();
  }

  private async requestGateway<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown>,
  ): Promise<T> {
    if (!this.gateway || !this.ready) {
      throw new GatewayUnavailableError(this.getDiagnostics());
    }
    return await this.gateway.request<T>(method, params);
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

  private async handleHelloOk(gateway: GatewayClient): Promise<void> {
    if (this.gateway !== gateway || this.closed) {
      return;
    }
    try {
      await gateway.request("sessions.subscribe", {});
      this.state = "ready";
      this.ready = true;
      this.lastError = null;
      this.lastReadyAt = nowIso();
      this.nextRetryAt = null;
      this.retryAttempt = 0;
      this.resolveReady();
    } catch (error) {
      this.markDegraded(error, { scheduleRetry: true });
    }
  }

  private handleGatewayConnectError(gateway: GatewayClient, error: unknown): void {
    if (this.gateway !== gateway || this.closed) {
      return;
    }
    this.markDegraded(error, { scheduleRetry: true });
  }

  private async handleGatewayClose(
    gateway: GatewayClient,
    code: number,
    reason: string,
  ): Promise<void> {
    if (this.gateway !== gateway || this.closed) {
      return;
    }
    this.ready = false;
    this.state = "degraded";
    this.lastError = {
      name: "GatewayClosedError",
      message: `gateway closed (${code}): ${reason}`,
    };
    this.scheduleRetry();
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
    switch (event.event) {
      case "session.message":
        await this.handleSessionMessageEvent(event.payload as SessionMessagePayload);
        return;
      case "exec.approval.requested": {
        const raw = (event.payload ?? {}) as Record<string, unknown>;
        this.trackApproval("exec", raw);
        this.enqueue({
          cursor: this.nextCursor(),
          type: "exec_approval_requested",
          raw,
        });
        return;
      }
      case "exec.approval.resolved": {
        const raw = (event.payload ?? {}) as Record<string, unknown>;
        this.resolveTrackedApproval(raw);
        this.enqueue({
          cursor: this.nextCursor(),
          type: "exec_approval_resolved",
          raw,
        });
        return;
      }
      case "plugin.approval.requested": {
        const raw = (event.payload ?? {}) as Record<string, unknown>;
        this.trackApproval("plugin", raw);
        this.enqueue({
          cursor: this.nextCursor(),
          type: "plugin_approval_requested",
          raw,
        });
        return;
      }
      case "plugin.approval.resolved": {
        const raw = (event.payload ?? {}) as Record<string, unknown>;
        this.resolveTrackedApproval(raw);
        this.enqueue({
          cursor: this.nextCursor(),
          type: "plugin_approval_resolved",
          raw,
        });
      }
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
