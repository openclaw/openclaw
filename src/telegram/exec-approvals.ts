import type { Bot } from "grammy";
import type { OpenClawConfig } from "../config/config.js";
import { loadSessionStore, resolveStorePath } from "../config/sessions.js";
import type { TelegramExecApprovalConfig } from "../config/types.telegram.js";
import { buildGatewayConnectionDetails } from "../gateway/call.js";
import { GatewayClient } from "../gateway/client.js";
import type { EventFrame } from "../gateway/protocol/index.js";
import type {
  ExecApprovalDecision,
  ExecApprovalRequest,
  ExecApprovalResolved,
} from "../infra/exec-approvals.js";
import { logDebug, logError } from "../logger.js";
import { normalizeAccountId, resolveAgentIdFromSessionKey } from "../routing/session-key.js";
import type { RuntimeEnv } from "../runtime.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { normalizeMessageChannel } from "../utils/message-channel.js";
import { buildInlineKeyboard } from "./send.js";

export type { ExecApprovalRequest, ExecApprovalResolved };

// --- callback_data encoding ---
// Format: ea:<uuid>:<decision-code>
// Decision codes: ao = allow-once, aa = allow-always, dn = deny
// Max length with a standard UUID (36 chars): 3+36+1+2 = 42 bytes, well under Telegram's 64-byte limit.

const DECISION_CODE_MAP: Record<string, ExecApprovalDecision> = {
  ao: "allow-once",
  aa: "allow-always",
  dn: "deny",
};

const DECISION_TO_CODE: Record<ExecApprovalDecision, string> = {
  "allow-once": "ao",
  "allow-always": "aa",
  deny: "dn",
};

export function buildExecApprovalCallbackData(
  approvalId: string,
  decision: ExecApprovalDecision,
): string {
  return `ea:${approvalId}:${DECISION_TO_CODE[decision]}`;
}

export function parseExecApprovalCallbackData(
  data: string,
): { approvalId: string; action: ExecApprovalDecision } | null {
  if (!data.startsWith("ea:")) {
    return null;
  }
  const lastColon = data.lastIndexOf(":");
  if (lastColon <= 3) {
    return null;
  }
  const code = data.slice(lastColon + 1);
  const decision = DECISION_CODE_MAP[code];
  if (!decision) {
    return null;
  }
  const approvalId = data.slice(3, lastColon);
  if (!approvalId) {
    return null;
  }
  return { approvalId, action: decision };
}

/** Extract Telegram chat ID from a session key like "agent:main:telegram:dm:123456789". */
export function extractTelegramChatId(sessionKey?: string | null): string | null {
  if (!sessionKey) {
    return null;
  }
  const match = sessionKey.match(/telegram:(?:dm|group|channel):(-?\d+)/);
  return match ? match[1] : null;
}

/** Resolve accountId from exec approval request by looking up session store. */
function resolveExecApprovalAccountId(params: {
  cfg: OpenClawConfig;
  request: ExecApprovalRequest;
}): string | null {
  const sessionKey = params.request.request.sessionKey?.trim();
  if (!sessionKey) {
    return null;
  }
  try {
    const agentId = resolveAgentIdFromSessionKey(sessionKey);
    const storePath = resolveStorePath(params.cfg.session?.store, { agentId });
    const store = loadSessionStore(storePath);
    const entry = store[sessionKey];
    const channel = normalizeMessageChannel(entry?.origin?.provider ?? entry?.lastChannel);
    if (channel && channel !== "telegram") {
      return null;
    }
    const accountId = entry?.origin?.accountId ?? entry?.lastAccountId;
    return accountId?.trim() || null;
  } catch {
    return null;
  }
}

// --- Pending approval tracking ---

type PendingMessage = {
  chatId: string | number;
  messageId: number;
};

type PendingApproval = {
  messages: PendingMessage[];
  timeoutId: NodeJS.Timeout;
};

// --- Handler result for callback queries ---

export type HandleCallbackResult = {
  handled: boolean;
  text?: string;
};

// --- Handler options ---

export type TelegramExecApprovalHandlerOpts = {
  bot: Bot;
  accountId: string;
  config: TelegramExecApprovalConfig;
  cfg: OpenClawConfig;
  runtime?: RuntimeEnv;
  gatewayUrl?: string;
};

// --- Main handler class ---

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

    // Check accountId isolation
    const requestAccountId = resolveExecApprovalAccountId({
      cfg: this.opts.cfg,
      request,
    });
    if (requestAccountId) {
      const handlerAccountId = normalizeAccountId(this.opts.accountId);
      if (normalizeAccountId(requestAccountId) !== handlerAccountId) {
        return false;
      }
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

    // Check session filter (substring or regex match)
    if (config.sessionFilter?.length) {
      const session = request.request.sessionKey;
      if (!session) {
        return false;
      }
      const matches = config.sessionFilter.some((p) => {
        if (session.includes(p)) {
          return true;
        }
        try {
          return new RegExp(p).test(session);
        } catch {
          return false;
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

    const { url: gatewayUrl } = buildGatewayConnectionDetails({
      config: this.opts.cfg,
      url: this.opts.gatewayUrl,
    });

    this.gatewayClient = new GatewayClient({
      url: gatewayUrl,
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

    for (const entry of this.pending.values()) {
      clearTimeout(entry.timeoutId);
    }
    this.pending.clear();
    this.requestCache.clear();

    this.gatewayClient?.stop();
    this.gatewayClient = null;

    logDebug("telegram exec approvals: stopped");
  }

  /** Handle an inline callback query with ea: prefix. Returns whether it was handled. */
  async handleCallbackQuery(data: string, fromUserId: string): Promise<HandleCallbackResult> {
    const parsed = parseExecApprovalCallbackData(data);
    if (!parsed) {
      return { handled: false };
    }

    // Verify the user is an authorized approver
    const approvers = this.opts.config.approvers ?? [];
    if (!approvers.some((id) => String(id) === fromUserId)) {
      return {
        handled: true,
        text: "⛔ You are not authorized to approve exec requests.",
      };
    }

    const decisionLabel =
      parsed.action === "allow-once"
        ? "Allowed (once)"
        : parsed.action === "allow-always"
          ? "Allowed (always)"
          : "Denied";

    const ok = await this.resolveApproval(parsed.approvalId, parsed.action);
    if (!ok) {
      return {
        handled: true,
        text: `❌ Failed to submit decision. The request may have expired or already been resolved.\nID: ${parsed.approvalId}`,
      };
    }

    return {
      handled: true,
      text: `✅ <b>${decisionLabel}</b>\nID: ${parsed.approvalId}`,
    };
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

  /** Return the list of configured approver IDs. */
  getApprovers(): string[] {
    return (this.opts.config.approvers ?? []).map(String);
  }

  // --- private gateway event handling ---

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
    this.requestCache.set(request.id, request);

    const bot = this.opts.bot;
    const approvers = this.opts.config.approvers ?? [];

    // Build the message content
    const commandText = request.request.command;
    const commandPreview = commandText.length > 800 ? `${commandText.slice(0, 800)}…` : commandText;
    const expiresAtSeconds = Math.max(0, Math.floor(request.expiresAtMs / 1000));

    const lines: string[] = [
      "🔒 <b>Exec approval required</b>",
      `<code>${escapeHtml(commandPreview)}</code>`,
    ];
    if (request.request.agentId) {
      lines.push(`Agent: ${escapeHtml(request.request.agentId)}`);
    }
    if (request.request.cwd) {
      lines.push(`CWD: ${escapeHtml(request.request.cwd)}`);
    }
    if (request.request.host) {
      lines.push(`Host: ${escapeHtml(request.request.host)}`);
    }
    lines.push(`Expires: <i>${expiresAtSeconds}s (unix)</i>`);
    lines.push(`ID: <code>${escapeHtml(request.id)}</code>`);
    const text = lines.join("\n");

    // Build inline keyboard
    const keyboard = buildInlineKeyboard([
      [
        {
          text: "✅ Allow once",
          callback_data: buildExecApprovalCallbackData(request.id, "allow-once"),
        },
        {
          text: "🔓 Always allow",
          callback_data: buildExecApprovalCallbackData(request.id, "allow-always"),
        },
        {
          text: "❌ Deny",
          callback_data: buildExecApprovalCallbackData(request.id, "deny"),
        },
      ],
    ]);

    const messages: PendingMessage[] = [];

    // Send to each approver's DM
    for (const approver of approvers) {
      const chatId = String(approver);
      try {
        const result = await bot.api.sendMessage(chatId, text, {
          parse_mode: "HTML",
          ...(keyboard ? { reply_markup: keyboard } : {}),
        });
        if (result?.message_id) {
          messages.push({ chatId, messageId: result.message_id });
          logDebug(`telegram exec approvals: sent approval ${request.id} to user ${chatId}`);
        }
      } catch (err) {
        logError(`telegram exec approvals: failed to notify user ${chatId}: ${String(err)}`);
      }
    }

    if (messages.length === 0) {
      // Clean up cache to avoid memory leak when no messages were delivered
      this.requestCache.delete(request.id);
      return;
    }

    // Set up expiry timeout
    const timeoutMs = Math.max(0, request.expiresAtMs - Date.now());
    const timeoutId = setTimeout(() => {
      void this.handleApprovalTimeout(request.id);
    }, timeoutMs);

    this.pending.set(request.id, { messages, timeoutId });
  }

  private async handleApprovalResolved(resolved: ExecApprovalResolved): Promise<void> {
    const request = this.requestCache.get(resolved.id);
    this.requestCache.delete(resolved.id);

    const entry = this.pending.get(resolved.id);
    if (entry) {
      clearTimeout(entry.timeoutId);
      this.pending.delete(resolved.id);
    }

    if (!entry) {
      return;
    }

    logDebug(`telegram exec approvals: resolved ${resolved.id} with ${resolved.decision}`);

    const decisionLabel =
      resolved.decision === "allow-once"
        ? "Allowed (once)"
        : resolved.decision === "allow-always"
          ? "Allowed (always)"
          : "Denied";

    const resolvedBy = resolved.resolvedBy ? ` by ${escapeHtml(resolved.resolvedBy)}` : "";
    const commandPreview = request
      ? `\n<code>${escapeHtml(request.request.command.length > 300 ? `${request.request.command.slice(0, 300)}…` : request.request.command)}</code>`
      : "";

    const text = `✅ <b>Exec Approval: ${decisionLabel}</b>${resolvedBy}${commandPreview}\nID: <code>${escapeHtml(resolved.id)}</code>`;

    await this.updateOrDeleteMessages(entry.messages, text);
  }

  private async handleApprovalTimeout(approvalId: string): Promise<void> {
    const entry = this.pending.get(approvalId);
    if (!entry) {
      return;
    }
    this.pending.delete(approvalId);

    const request = this.requestCache.get(approvalId);
    this.requestCache.delete(approvalId);

    logDebug(`telegram exec approvals: timeout for ${approvalId}`);

    const commandPreview = request
      ? `\n<code>${escapeHtml(request.request.command.length > 300 ? `${request.request.command.slice(0, 300)}…` : request.request.command)}</code>`
      : "";

    const text = `⏱️ <b>Exec Approval: Expired</b>${commandPreview}\nID: <code>${escapeHtml(approvalId)}</code>`;

    await this.updateOrDeleteMessages(entry.messages, text);
  }

  private async updateOrDeleteMessages(messages: PendingMessage[], text: string): Promise<void> {
    const bot = this.opts.bot;
    const shouldDelete = this.opts.config.cleanupAfterResolve === true;

    for (const msg of messages) {
      try {
        if (shouldDelete) {
          await bot.api.deleteMessage(msg.chatId, msg.messageId);
        } else {
          await bot.api.editMessageText(msg.chatId, msg.messageId, text, {
            parse_mode: "HTML",
            reply_markup: { inline_keyboard: [] }, // Clear keyboard to prevent stale clicks
          });
        }
      } catch (err) {
        logError(
          `telegram exec approvals: failed to ${shouldDelete ? "delete" : "update"} message: ${String(err)}`,
        );
      }
    }
  }
}

/** Escape HTML special characters for Telegram's HTML parse mode. */
function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
