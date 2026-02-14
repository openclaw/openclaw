import type { Api } from "grammy";
import type { OpenClawConfig } from "../config/config.js";
import type { TelegramExecApprovalConfig } from "../config/types.telegram.js";
import type { EventFrame } from "../gateway/protocol/index.js";
import type { ExecApprovalDecision } from "../infra/exec-approvals.js";
import type { RuntimeEnv } from "../runtime.js";
import { GatewayClient } from "../gateway/client.js";
import { logDebug, logError } from "../logger.js";
import { resolveTelegramInlineButtonsScope } from "./inline-buttons.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";

// Short prefix so callback_data stays under Telegram 64-byte limit
const EXEC_APPROVAL_KEY = "ea";
const ACTION_CODES: Record<ExecApprovalDecision, string> = {
  "allow-once": "o",
  "allow-always": "a",
  deny: "d",
};
const CODE_TO_ACTION: Record<string, ExecApprovalDecision> = {
  o: "allow-once",
  a: "allow-always",
  d: "deny",
};

export type ExecApprovalRequest = {
  id: string;
  request: {
    command: string;
    cwd?: string | null;
    host?: string | null;
    security?: string | null;
    ask?: string | null;
    agentId?: string | null;
    resolvedPath?: string | null;
    sessionKey?: string | null;
  };
  createdAtMs: number;
  expiresAtMs: number;
};

export type ExecApprovalResolved = {
  id: string;
  decision: ExecApprovalDecision;
  resolvedBy?: string | null;
  ts: number;
};

type PendingApproval = {
  messages: Array<{ telegramMessageId: number; telegramChatId: number }>;
  timeoutId: NodeJS.Timeout;
};

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

export function buildExecApprovalCallbackData(
  approvalId: string,
  action: ExecApprovalDecision,
): string {
  // Telegram callback_data max is 64 bytes. Short format: ea:id={id};a={o|a|d}
  return [
    `${EXEC_APPROVAL_KEY}:id=${encodeCustomIdValue(approvalId)}`,
    `a=${ACTION_CODES[action]}`,
  ].join(";");
}

export function parseExecApprovalCallbackData(
  callbackData: string,
): { approvalId: string; action: ExecApprovalDecision } | null {
  if (!callbackData || typeof callbackData !== "string") {
    return null;
  }

  // Format: ea:id={id};a={o|a|d}
  if (!callbackData.startsWith(`${EXEC_APPROVAL_KEY}:`)) {
    return null;
  }

  const parts = callbackData.split(";");
  let rawId = "";
  let rawCode = "";

  for (const part of parts) {
    if (part.startsWith(`${EXEC_APPROVAL_KEY}:id=`)) {
      rawId = part.slice(`${EXEC_APPROVAL_KEY}:id=`.length);
    } else if (part.startsWith("a=")) {
      rawCode = part.slice(2);
    }
  }

  if (!rawId || !rawCode) {
    return null;
  }

  const action = CODE_TO_ACTION[rawCode];
  if (!action) {
    return null;
  }

  return {
    approvalId: decodeCustomIdValue(rawId),
    action,
  };
}

function formatExecApprovalMessage(request: ExecApprovalRequest): string {
  const commandText = request.request.command;
  const commandPreview =
    commandText.length > 1000 ? `${commandText.slice(0, 1000)}...` : commandText;
  const expiresIn = Math.max(0, Math.round((request.expiresAtMs - Date.now()) / 1000));

  let message = "⚠️ **Exec Approval Required**\n\n";
  message += `**Command:**\n\`\`\`\n${commandPreview}\n\`\`\`\n\n`;

  if (request.request.cwd) {
    message += `**Working Directory:** ${request.request.cwd}\n`;
  }

  if (request.request.host) {
    message += `**Host:** ${request.request.host}\n`;
  }

  if (request.request.agentId) {
    message += `**Agent:** ${request.request.agentId}\n`;
  }

  message += `\n⏱ Expires in ${expiresIn}s | ID: \`${request.id}\``;

  return message;
}

function formatResolvedMessage(
  request: ExecApprovalRequest,
  decision: ExecApprovalDecision,
  resolvedBy?: string | null,
): string {
  const commandText = request.request.command;
  const commandPreview = commandText.length > 500 ? `${commandText.slice(0, 500)}...` : commandText;

  const decisionLabel =
    decision === "allow-once"
      ? "✅ Allowed (once)"
      : decision === "allow-always"
        ? "✔️ Allowed (always)"
        : "❌ Denied";

  let message = `**Exec Approval: ${decisionLabel}**\n\n`;

  if (resolvedBy) {
    message += `Resolved by ${resolvedBy}\n\n`;
  }

  message += `**Command:**\n\`\`\`\n${commandPreview}\n\`\`\`\n\n`;
  message += `ID: \`${request.id}\``;

  return message;
}

function formatExpiredMessage(request: ExecApprovalRequest): string {
  const commandText = request.request.command;
  const commandPreview = commandText.length > 500 ? `${commandText.slice(0, 500)}...` : commandText;

  let message = "⏱ **Exec Approval: Expired**\n\n";
  message += "This approval request has expired.\n\n";
  message += `**Command:**\n\`\`\`\n${commandPreview}\n\`\`\`\n\n`;
  message += `ID: \`${request.id}\``;

  return message;
}

export type TelegramExecApprovalHandlerOpts = {
  api: Api;
  accountId: string;
  config: TelegramExecApprovalConfig;
  gatewayUrl?: string;
  cfg: OpenClawConfig;
  runtime?: RuntimeEnv;
};

export class TelegramExecApprovalHandler {
  private gatewayClient: GatewayClient | null = null;
  private pending = new Map<string, PendingApproval>();
  private requestCache = new Map<string, ExecApprovalRequest>();
  private opts: TelegramExecApprovalHandlerOpts;
  private started = false;

  constructor(opts: TelegramExecApprovalHandlerOpts) {
    this.opts = opts;
  }

  shouldHandle(request: ExecApprovalRequest): boolean {
    const config = this.opts.config;
    if (!config.enabled) {
      return false;
    }
    if (!config.approvers || config.approvers.length === 0) {
      return false;
    }

    // Fallback: when inlineButtons is "off", do not send button UI (forwarder will send plain text)
    const inlineButtonsScope = resolveTelegramInlineButtonsScope({
      cfg: this.opts.cfg,
      accountId: this.opts.accountId,
    });
    if (inlineButtonsScope === "off") {
      return false;
    }

    // Check agent filter
    if (config.agentFilter?.length) {
      if (!request.request.agentId) {
        return false;
      }
      if (!config.agentFilter.includes(request.request.agentId)) {
        return false;
      }
    }

    // Check session filter (substring match)
    if (config.sessionFilter?.length) {
      const session = request.request.sessionKey;
      if (!session) {
        return false;
      }
      const matches = config.sessionFilter.some((p) => {
        try {
          return session.includes(p) || new RegExp(p).test(session);
        } catch {
          return session.includes(p);
        }
      });
      if (!matches) {
        return false;
      }
    }

    return true;
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }
    this.started = true;

    const config = this.opts.config;
    if (!config.enabled) {
      logDebug("telegram exec approvals: disabled");
      return;
    }

    if (!config.approvers || config.approvers.length === 0) {
      logDebug("telegram exec approvals: no approvers configured");
      return;
    }

    logDebug("telegram exec approvals: starting handler");

    this.gatewayClient = new GatewayClient({
      url: this.opts.gatewayUrl ?? "ws://127.0.0.1:18789",
      clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
      clientDisplayName: "Telegram Exec Approvals",
      mode: GATEWAY_CLIENT_MODES.BACKEND,
      scopes: ["operator.approvals"],
      onEvent: (evt) => this.handleGatewayEvent(evt),
      onHelloOk: () => {
        logDebug("telegram exec approvals: connected to gateway");
      },
      onConnectError: (err) => {
        logError(`telegram exec approvals: connect error: ${err.message}`);
      },
      onClose: (code, reason) => {
        logDebug(`telegram exec approvals: gateway closed: ${code} ${reason}`);
      },
    });

    this.gatewayClient.start();
  }

  async stop(): Promise<void> {
    if (!this.started) {
      return;
    }
    this.started = false;

    // Clear all pending timeouts
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeoutId);
    }
    this.pending.clear();
    this.requestCache.clear();

    this.gatewayClient?.stop();
    this.gatewayClient = null;

    logDebug("telegram exec approvals: stopped");
  }

  private handleGatewayEvent(evt: EventFrame): void {
    if (evt.event === "exec.approval.requested") {
      const request = evt.payload as ExecApprovalRequest;
      void this.handleApprovalRequested(request);
    } else if (evt.event === "exec.approval.resolved") {
      const resolved = evt.payload as ExecApprovalResolved;
      void this.handleApprovalResolved(resolved);
    }
  }

  private async handleApprovalRequested(request: ExecApprovalRequest): Promise<void> {
    if (!this.shouldHandle(request)) {
      return;
    }

    logDebug(`telegram exec approvals: received request ${request.id}`);

    // Idempotency: if we already have this request (e.g. duplicate gateway event), do not send again
    if (this.pending.has(request.id)) {
      logDebug(`telegram exec approvals: skipping duplicate request ${request.id}`);
      return;
    }

    this.requestCache.set(request.id, request);

    const message = formatExecApprovalMessage(request);

    // Build inline keyboard with 3 buttons
    const keyboard = {
      inline_keyboard: [
        [
          {
            text: "✅ Allow once",
            callback_data: buildExecApprovalCallbackData(request.id, "allow-once"),
          },
          {
            text: "✔️ Always",
            callback_data: buildExecApprovalCallbackData(request.id, "allow-always"),
          },
          {
            text: "❌ Deny",
            callback_data: buildExecApprovalCallbackData(request.id, "deny"),
          },
        ],
      ],
    };

    // Deduplicate by chat ID so we send at most one message per chat (avoids duplicate blocks for same ID)
    const rawApprovers = this.opts.config.approvers ?? [];
    const seenChatIds = new Set<number>();
    const approvers: number[] = [];
    for (const approver of rawApprovers) {
      const chatId = Number(approver);
      if (Number.isNaN(chatId)) {
        logError(`telegram exec approvals: invalid approver ID ${approver}`);
        continue;
      }
      if (seenChatIds.has(chatId)) {
        continue;
      }
      seenChatIds.add(chatId);
      approvers.push(chatId);
    }

    const timeoutMs = Math.max(0, request.expiresAtMs - Date.now());
    const timeoutId = setTimeout(() => {
      void this.handleApprovalTimeout(request.id);
    }, timeoutMs);
    const messages: Array<{ telegramMessageId: number; telegramChatId: number }> = [];

    for (const chatId of approvers) {
      try {
        // Send message with inline keyboard to approver
        const sentMessage = await this.opts.api.sendMessage(chatId, message, {
          reply_markup: keyboard,
          parse_mode: "Markdown",
        });

        if (!sentMessage || !sentMessage.message_id) {
          logError(`telegram exec approvals: failed to send message to ${chatId}`);
          continue;
        }

        messages.push({
          telegramMessageId: sentMessage.message_id,
          telegramChatId: chatId,
        });

        logDebug(`telegram exec approvals: sent approval ${request.id} to ${chatId}`);
      } catch (err) {
        logError(`telegram exec approvals: failed to notify ${chatId}: ${String(err)}`);
      }
    }

    if (messages.length > 0) {
      this.pending.set(request.id, { messages, timeoutId });
    } else {
      clearTimeout(timeoutId);
    }
  }

  private async handleApprovalResolved(resolved: ExecApprovalResolved): Promise<void> {
    const pending = this.pending.get(resolved.id);
    if (!pending) {
      return;
    }

    clearTimeout(pending.timeoutId);
    this.pending.delete(resolved.id);

    const request = this.requestCache.get(resolved.id);
    this.requestCache.delete(resolved.id);

    if (!request) {
      return;
    }

    logDebug(`telegram exec approvals: resolved ${resolved.id} with ${resolved.decision}`);

    const text = formatResolvedMessage(request, resolved.decision, resolved.resolvedBy);
    for (const { telegramChatId, telegramMessageId } of pending.messages) {
      await this.updateMessage(telegramChatId, telegramMessageId, text);
    }
  }

  private async handleApprovalTimeout(approvalId: string): Promise<void> {
    const pending = this.pending.get(approvalId);
    if (!pending) {
      return;
    }

    this.pending.delete(approvalId);

    const request = this.requestCache.get(approvalId);
    this.requestCache.delete(approvalId);

    if (!request) {
      return;
    }

    logDebug(`telegram exec approvals: timeout for ${approvalId}`);

    const text = formatExpiredMessage(request);
    for (const { telegramChatId, telegramMessageId } of pending.messages) {
      await this.updateMessage(telegramChatId, telegramMessageId, text);
    }
  }

  private async updateMessage(chatId: number, messageId: number, text: string): Promise<void> {
    try {
      await this.opts.api.editMessageText(chatId, messageId, text, {
        parse_mode: "Markdown",
        // Remove buttons by not including reply_markup
      });
    } catch (err) {
      logError(`telegram exec approvals: failed to update message: ${String(err)}`);
    }
  }

  async resolveApproval(approvalId: string, decision: ExecApprovalDecision): Promise<boolean> {
    if (!this.gatewayClient) {
      logError("telegram exec approvals: gateway client not connected");
      return false;
    }

    logDebug(`telegram exec approvals: resolving ${approvalId} with ${decision}`);

    try {
      await this.gatewayClient.request("exec.approval.resolve", {
        id: approvalId,
        decision,
      });
      logDebug(`telegram exec approvals: resolved ${approvalId} successfully`);
      return true;
    } catch (err) {
      logError(`telegram exec approvals: resolve failed: ${String(err)}`);
      return false;
    }
  }
}
