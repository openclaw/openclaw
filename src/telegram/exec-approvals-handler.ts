import type { OpenClawConfig } from "../config/config.js";
import { loadSessionStore, resolveStorePath } from "../config/sessions.js";
import { buildGatewayConnectionDetails } from "../gateway/call.js";
import { GatewayClient } from "../gateway/client.js";
import { resolveGatewayConnectionAuth } from "../gateway/connection-auth.js";
import type { EventFrame } from "../gateway/protocol/index.js";
import {
  buildExecApprovalPendingReplyPayload,
  type ExecApprovalPendingReplyParams,
} from "../infra/exec-approval-reply.js";
import type { ExecApprovalRequest, ExecApprovalResolved } from "../infra/exec-approvals.js";
import { resolveSessionDeliveryTarget } from "../infra/outbound/targets.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { normalizeAccountId, parseAgentSessionKey } from "../routing/session-key.js";
import type { RuntimeEnv } from "../runtime.js";
import { compileSafeRegex, testRegexWithBoundedInput } from "../security/safe-regex.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { buildTelegramExecApprovalButtons } from "./approval-buttons.js";
import {
  getTelegramExecApprovalApprovers,
  resolveTelegramExecApprovalConfig,
  resolveTelegramExecApprovalTarget,
} from "./exec-approvals.js";
import { editMessageReplyMarkupTelegram, sendMessageTelegram, sendTypingTelegram } from "./send.js";

const log = createSubsystemLogger("telegram/exec-approvals");

type PendingMessage = {
  chatId: string;
  messageId: string;
};

type PendingApproval = {
  timeoutId: NodeJS.Timeout;
  messages: PendingMessage[];
};

type TelegramApprovalTarget = {
  to: string;
  threadId?: number;
};

export type TelegramExecApprovalHandlerOpts = {
  token: string;
  accountId: string;
  cfg: OpenClawConfig;
  gatewayUrl?: string;
  runtime?: RuntimeEnv;
};

export type TelegramExecApprovalHandlerDeps = {
  nowMs?: () => number;
  sendTyping?: typeof sendTypingTelegram;
  sendMessage?: typeof sendMessageTelegram;
  editReplyMarkup?: typeof editMessageReplyMarkupTelegram;
};

function matchesFilters(params: {
  cfg: OpenClawConfig;
  accountId: string;
  request: ExecApprovalRequest;
}): boolean {
  const config = resolveTelegramExecApprovalConfig({
    cfg: params.cfg,
    accountId: params.accountId,
  });
  if (!config?.enabled) {
    return false;
  }
  const approvers = getTelegramExecApprovalApprovers({
    cfg: params.cfg,
    accountId: params.accountId,
  });
  if (approvers.length === 0) {
    return false;
  }
  if (config.agentFilter?.length) {
    const agentId =
      params.request.request.agentId ??
      parseAgentSessionKey(params.request.request.sessionKey)?.agentId;
    if (!agentId || !config.agentFilter.includes(agentId)) {
      return false;
    }
  }
  if (config.sessionFilter?.length) {
    const sessionKey = params.request.request.sessionKey;
    if (!sessionKey) {
      return false;
    }
    const matches = config.sessionFilter.some((pattern) => {
      if (sessionKey.includes(pattern)) {
        return true;
      }
      const regex = compileSafeRegex(pattern);
      return regex ? testRegexWithBoundedInput(regex, sessionKey) : false;
    });
    if (!matches) {
      return false;
    }
  }
  return true;
}

function isHandlerConfigured(params: { cfg: OpenClawConfig; accountId: string }): boolean {
  const config = resolveTelegramExecApprovalConfig({
    cfg: params.cfg,
    accountId: params.accountId,
  });
  if (!config?.enabled) {
    return false;
  }
  return (
    getTelegramExecApprovalApprovers({
      cfg: params.cfg,
      accountId: params.accountId,
    }).length > 0
  );
}

function resolveRequestSessionTarget(params: {
  cfg: OpenClawConfig;
  request: ExecApprovalRequest;
}): { to: string; accountId?: string; threadId?: number; channel?: string } | null {
  const sessionKey = params.request.request.sessionKey?.trim();
  if (!sessionKey) {
    return null;
  }
  const parsed = parseAgentSessionKey(sessionKey);
  const agentId = parsed?.agentId ?? params.request.request.agentId ?? "main";
  const storePath = resolveStorePath(params.cfg.session?.store, { agentId });
  const store = loadSessionStore(storePath);
  const entry = store[sessionKey];
  if (!entry) {
    return null;
  }
  const target = resolveSessionDeliveryTarget({
    entry,
    requestedChannel: "last",
    turnSourceChannel: params.request.request.turnSourceChannel ?? undefined,
    turnSourceTo: params.request.request.turnSourceTo ?? undefined,
    turnSourceAccountId: params.request.request.turnSourceAccountId ?? undefined,
    turnSourceThreadId: params.request.request.turnSourceThreadId ?? undefined,
  });
  if (!target.to) {
    return null;
  }
  return {
    channel: target.channel ?? undefined,
    to: target.to,
    accountId: target.accountId ?? undefined,
    threadId:
      typeof target.threadId === "number"
        ? target.threadId
        : typeof target.threadId === "string"
          ? Number.parseInt(target.threadId, 10)
          : undefined,
  };
}

function resolveTelegramSourceTarget(params: {
  cfg: OpenClawConfig;
  accountId: string;
  request: ExecApprovalRequest;
}): TelegramApprovalTarget | null {
  const turnSourceChannel = params.request.request.turnSourceChannel?.trim().toLowerCase() || "";
  const turnSourceTo = params.request.request.turnSourceTo?.trim() || "";
  const turnSourceAccountId = params.request.request.turnSourceAccountId?.trim() || "";
  if (turnSourceChannel === "telegram" && turnSourceTo) {
    if (
      turnSourceAccountId &&
      normalizeAccountId(turnSourceAccountId) !== normalizeAccountId(params.accountId)
    ) {
      return null;
    }
    const threadId =
      typeof params.request.request.turnSourceThreadId === "number"
        ? params.request.request.turnSourceThreadId
        : typeof params.request.request.turnSourceThreadId === "string"
          ? Number.parseInt(params.request.request.turnSourceThreadId, 10)
          : undefined;
    return { to: turnSourceTo, threadId: Number.isFinite(threadId) ? threadId : undefined };
  }

  const sessionTarget = resolveRequestSessionTarget(params);
  if (!sessionTarget || sessionTarget.channel !== "telegram") {
    return null;
  }
  if (
    sessionTarget.accountId &&
    normalizeAccountId(sessionTarget.accountId) !== normalizeAccountId(params.accountId)
  ) {
    return null;
  }
  return {
    to: sessionTarget.to,
    threadId: sessionTarget.threadId,
  };
}

function dedupeTargets(targets: TelegramApprovalTarget[]): TelegramApprovalTarget[] {
  const seen = new Set<string>();
  const deduped: TelegramApprovalTarget[] = [];
  for (const target of targets) {
    const key = `${target.to}:${target.threadId ?? ""}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(target);
  }
  return deduped;
}

export class TelegramExecApprovalHandler {
  private gatewayClient: GatewayClient | null = null;
  private pending = new Map<string, PendingApproval>();
  private started = false;
  private readonly nowMs: () => number;
  private readonly sendTyping: typeof sendTypingTelegram;
  private readonly sendMessage: typeof sendMessageTelegram;
  private readonly editReplyMarkup: typeof editMessageReplyMarkupTelegram;

  constructor(
    private readonly opts: TelegramExecApprovalHandlerOpts,
    deps: TelegramExecApprovalHandlerDeps = {},
  ) {
    this.nowMs = deps.nowMs ?? Date.now;
    this.sendTyping = deps.sendTyping ?? sendTypingTelegram;
    this.sendMessage = deps.sendMessage ?? sendMessageTelegram;
    this.editReplyMarkup = deps.editReplyMarkup ?? editMessageReplyMarkupTelegram;
  }

  shouldHandle(request: ExecApprovalRequest): boolean {
    return matchesFilters({
      cfg: this.opts.cfg,
      accountId: this.opts.accountId,
      request,
    });
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }
    this.started = true;

    if (!isHandlerConfigured({ cfg: this.opts.cfg, accountId: this.opts.accountId })) {
      return;
    }

    const { url: gatewayUrl, urlSource } = buildGatewayConnectionDetails({
      config: this.opts.cfg,
      url: this.opts.gatewayUrl,
    });
    const gatewayUrlOverrideSource =
      urlSource === "cli --url"
        ? "cli"
        : urlSource === "env OPENCLAW_GATEWAY_URL"
          ? "env"
          : undefined;
    const auth = await resolveGatewayConnectionAuth({
      config: this.opts.cfg,
      env: process.env,
      urlOverride: gatewayUrlOverrideSource ? gatewayUrl : undefined,
      urlOverrideSource: gatewayUrlOverrideSource,
    });

    this.gatewayClient = new GatewayClient({
      url: gatewayUrl,
      token: auth.token,
      password: auth.password,
      clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
      clientDisplayName: `Telegram Exec Approvals (${this.opts.accountId})`,
      mode: GATEWAY_CLIENT_MODES.BACKEND,
      scopes: ["operator.approvals"],
      onEvent: (evt) => this.handleGatewayEvent(evt),
      onConnectError: (err) => {
        log.error(`telegram exec approvals: connect error: ${err.message}`);
      },
    });
    this.gatewayClient.start();
  }

  async stop(): Promise<void> {
    if (!this.started) {
      return;
    }
    this.started = false;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeoutId);
    }
    this.pending.clear();
    this.gatewayClient?.stop();
    this.gatewayClient = null;
  }

  async handleRequested(request: ExecApprovalRequest): Promise<void> {
    if (!this.shouldHandle(request)) {
      return;
    }

    const targetMode = resolveTelegramExecApprovalTarget({
      cfg: this.opts.cfg,
      accountId: this.opts.accountId,
    });
    const targets: TelegramApprovalTarget[] = [];
    const sourceTarget = resolveTelegramSourceTarget({
      cfg: this.opts.cfg,
      accountId: this.opts.accountId,
      request,
    });
    let fallbackToDm = false;
    if (targetMode === "channel" || targetMode === "both") {
      if (sourceTarget) {
        targets.push(sourceTarget);
      } else {
        fallbackToDm = true;
      }
    }
    if (targetMode === "dm" || targetMode === "both" || fallbackToDm) {
      for (const approver of getTelegramExecApprovalApprovers({
        cfg: this.opts.cfg,
        accountId: this.opts.accountId,
      })) {
        targets.push({ to: approver });
      }
    }

    const resolvedTargets = dedupeTargets(targets);
    if (resolvedTargets.length === 0) {
      return;
    }

    const payloadParams: ExecApprovalPendingReplyParams = {
      approvalId: request.id,
      approvalSlug: request.id.slice(0, 8),
      approvalCommandId: request.id,
      command: request.request.command,
      cwd: request.request.cwd ?? undefined,
      host: request.request.host === "node" ? "node" : "gateway",
      nodeId: request.request.nodeId ?? undefined,
      expiresAtMs: request.expiresAtMs,
      nowMs: this.nowMs(),
    };
    const payload = buildExecApprovalPendingReplyPayload(payloadParams);
    const buttons = buildTelegramExecApprovalButtons(request.id);
    const sentMessages: PendingMessage[] = [];

    for (const target of resolvedTargets) {
      try {
        await this.sendTyping(target.to, {
          cfg: this.opts.cfg,
          token: this.opts.token,
          accountId: this.opts.accountId,
          ...(typeof target.threadId === "number" ? { messageThreadId: target.threadId } : {}),
        }).catch(() => {});

        const result = await this.sendMessage(target.to, payload.text ?? "", {
          cfg: this.opts.cfg,
          token: this.opts.token,
          accountId: this.opts.accountId,
          buttons,
          ...(typeof target.threadId === "number" ? { messageThreadId: target.threadId } : {}),
        });
        sentMessages.push({
          chatId: result.chatId,
          messageId: result.messageId,
        });
      } catch (err) {
        log.error(`telegram exec approvals: failed to send request ${request.id}: ${String(err)}`);
      }
    }

    if (sentMessages.length === 0) {
      return;
    }

    const timeoutMs = Math.max(0, request.expiresAtMs - this.nowMs());
    const timeoutId = setTimeout(() => {
      void this.handleResolved({ id: request.id, decision: "deny", ts: Date.now() });
    }, timeoutMs);
    timeoutId.unref?.();

    this.pending.set(request.id, {
      timeoutId,
      messages: sentMessages,
    });
  }

  async handleResolved(resolved: ExecApprovalResolved): Promise<void> {
    const pending = this.pending.get(resolved.id);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timeoutId);
    this.pending.delete(resolved.id);

    await Promise.allSettled(
      pending.messages.map(async (message) => {
        await this.editReplyMarkup(message.chatId, message.messageId, [], {
          cfg: this.opts.cfg,
          token: this.opts.token,
          accountId: this.opts.accountId,
        });
      }),
    );
  }

  private handleGatewayEvent(evt: EventFrame): void {
    if (evt.event === "exec.approval.requested") {
      void this.handleRequested(evt.payload as ExecApprovalRequest);
      return;
    }
    if (evt.event === "exec.approval.resolved") {
      void this.handleResolved(evt.payload as ExecApprovalResolved);
    }
  }
}
