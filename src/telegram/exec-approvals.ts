import type { OpenClawConfig } from "../config/config.js";
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
import { compileSafeRegex } from "../security/safe-regex.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import type { TelegramInlineButtons } from "./button-types.js";
import { editMessageTelegram, sendMessageTelegram } from "./send.js";

// --- Callback data encoding ---
// Telegram limits callback_data to 64 bytes.
// Format: ea:<approvalId>:<actionCode>
// Action codes: 1 = allow-once, 2 = allow-always, 3 = deny

const ACTION_TO_CODE: Record<ExecApprovalDecision, string> = {
  "allow-once": "1",
  "allow-always": "2",
  deny: "3",
};

const CODE_TO_ACTION: Record<string, ExecApprovalDecision> = {
  "1": "allow-once",
  "2": "allow-always",
  "3": "deny",
};

export function buildExecApprovalCallbackData(
  approvalId: string,
  action: ExecApprovalDecision,
): string {
  return `ea:${approvalId}:${ACTION_TO_CODE[action]}`;
}

export function parseExecApprovalCallbackData(
  data: string,
): { approvalId: string; action: ExecApprovalDecision } | null {
  if (!data.startsWith("ea:")) {
    return null;
  }
  const parts = data.split(":");
  if (parts.length !== 3) {
    return null;
  }
  const approvalId = parts[1];
  const action = CODE_TO_ACTION[parts[2]];
  if (!approvalId || !action) {
    return null;
  }
  return { approvalId, action };
}

// --- Button builder ---

export function buildExecApprovalButtons(approvalId: string): TelegramInlineButtons {
  return [
    [
      {
        text: "\u2705 Allow once",
        callback_data: buildExecApprovalCallbackData(approvalId, "allow-once"),
        style: "success",
      },
      {
        text: "\u{1F504} Always allow",
        callback_data: buildExecApprovalCallbackData(approvalId, "allow-always"),
        style: "primary",
      },
      {
        text: "\u274C Deny",
        callback_data: buildExecApprovalCallbackData(approvalId, "deny"),
        style: "danger",
      },
    ],
  ];
}

// --- Message formatting ---

function formatCommandPreview(command: string, maxChars = 200): string {
  if (command.length > maxChars) {
    return `${command.slice(0, maxChars)}...`;
  }
  return command;
}

function describeCommand(command: string): string {
  const trimmed = command.trim();
  const binary = trimmed.split(/\s+/)[0] ?? trimmed;
  const base = binary.split("/").pop() ?? binary;

  // Provide human-readable descriptions for common commands
  if (base === "rm" || base === "rmdir") {
    return "Delete files or directories";
  }
  if (base === "mv") {
    return "Move or rename files";
  }
  if (base === "cp") {
    return "Copy files";
  }
  if (base === "chmod") {
    return "Change file permissions";
  }
  if (base === "chown") {
    return "Change file ownership";
  }
  if (base === "curl" || base === "wget") {
    return "Download from the internet";
  }
  if (base === "pip" || base === "pip3") {
    return "Install Python packages";
  }
  if (
    base === "npm" ||
    base === "npx" ||
    base === "pnpm" ||
    base === "yarn" ||
    base === "bun" ||
    base === "bunx"
  ) {
    return "Run a Node.js package manager command";
  }
  if (base === "git") {
    return "Run a git version control command";
  }
  if (base === "docker" || base === "podman") {
    return "Run a container command";
  }
  if (base === "ssh" || base === "scp") {
    return "Connect to or transfer files with a remote host";
  }
  if (base === "sudo") {
    return "Run a command with elevated privileges";
  }
  if (
    base === "apt" ||
    base === "apt-get" ||
    base === "brew" ||
    base === "dnf" ||
    base === "yum" ||
    base === "pacman"
  ) {
    return "Install or manage system packages";
  }
  if (base === "kill" || base === "pkill" || base === "killall") {
    return "Terminate a running process";
  }
  if (base === "cat" || base === "less" || base === "head" || base === "tail") {
    return "Read file contents";
  }
  if (base === "sed" || base === "awk") {
    return "Transform text or file contents";
  }
  if (
    base === "python" ||
    base === "python3" ||
    base === "node" ||
    base === "ruby" ||
    base === "perl"
  ) {
    return `Execute a ${base} script`;
  }
  if (base === "bash" || base === "sh" || base === "zsh") {
    return "Run a shell script";
  }
  return `Run "${base}"`;
}

function buildRequestMessageText(request: ExecApprovalRequest, nowMs: number): string {
  const command = request.request.command;
  const description = describeCommand(command);
  const preview = formatCommandPreview(command, 300);
  const expiresIn = Math.max(0, Math.round((request.expiresAtMs - nowMs) / 1000));

  const lines: string[] = [
    `\u{1F512} <b>Exec Approval Required</b>`,
    "",
    `<b>What:</b> ${description}`,
    `<b>Command:</b> <code>${escapeHtml(preview)}</code>`,
  ];
  if (request.request.cwd) {
    lines.push(`<b>Directory:</b> <code>${escapeHtml(request.request.cwd)}</code>`);
  }
  if (request.request.host) {
    lines.push(`<b>Host:</b> ${escapeHtml(request.request.host)}`);
  }
  if (request.request.agentId) {
    lines.push(`<b>Agent:</b> ${escapeHtml(request.request.agentId)}`);
  }
  if (Array.isArray(request.request.envKeys) && request.request.envKeys.length > 0) {
    lines.push(`<b>Env overrides:</b> ${escapeHtml(request.request.envKeys.join(", "))}`);
  }
  lines.push("");
  lines.push(
    `\u26A0\uFE0F <i>Allow once</i> = run this command once. ` +
      `<i>Always allow</i> = add to allowlist. ` +
      `<i>Deny</i> = block execution.`,
  );
  lines.push(`\u23F3 Expires in ${expiresIn}s \u2022 ID: ${request.id}`);
  return lines.join("\n");
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function decisionLabel(decision: ExecApprovalDecision): string {
  if (decision === "allow-once") {
    return "allowed once";
  }
  if (decision === "allow-always") {
    return "allowed always";
  }
  return "denied";
}

function resolvedEmoji(decision: ExecApprovalDecision): string {
  if (decision === "deny") {
    return "\u274C";
  }
  return "\u2705";
}

function buildResolvedMessageText(
  resolved: ExecApprovalResolved,
  request?: ExecApprovalRequest,
): string {
  const emoji = resolvedEmoji(resolved.decision);
  const label = decisionLabel(resolved.decision);
  const by = resolved.resolvedBy ? ` by ${resolved.resolvedBy}` : "";
  const commandInfo = request?.request.command
    ? `\n<b>Command:</b> <code>${escapeHtml(formatCommandPreview(request.request.command, 200))}</code>`
    : "";
  return `${emoji} <b>Exec approval ${label}</b>${by}.${commandInfo}\nID: ${resolved.id}`;
}

function buildExpiredMessageText(request: ExecApprovalRequest): string {
  const preview = formatCommandPreview(request.request.command, 200);
  return `\u23F1\uFE0F <b>Exec approval expired</b>\n<b>Command:</b> <code>${escapeHtml(preview)}</code>\nID: ${request.id}`;
}

// --- Chat ID extraction ---

export function extractTelegramChatId(sessionKey?: string | null): string | null {
  if (!sessionKey) {
    return null;
  }
  // Session key format: agent:<id>:telegram:dm:<chatId> or agent:<id>:telegram:group:<chatId>
  const match = sessionKey.match(/telegram:(?:dm|group):(-?\d+)/);
  return match ? match[1] : null;
}

// --- Pending approval tracking ---

type PendingApproval = {
  request: ExecApprovalRequest;
  /** Map of target key -> { chatId, messageId } */
  messages: Map<string, { chatId: string; messageId: string }>;
  timeoutId: NodeJS.Timeout;
};

// --- Handler class ---

export type TelegramExecApprovalHandlerOpts = {
  accountId: string;
  config: TelegramExecApprovalConfig;
  gatewayUrl?: string;
  cfg: OpenClawConfig;
};

export class TelegramExecApprovalHandler {
  private gatewayClient: GatewayClient | null = null;
  private pending = new Map<string, PendingApproval>();
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
        const regex = compileSafeRegex(p);
        return regex ? regex.test(session) : false;
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

    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeoutId);
    }
    this.pending.clear();

    this.gatewayClient?.stop();
    this.gatewayClient = null;

    logDebug("telegram exec approvals: stopped");
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

  getApprovers(): Array<string | number> {
    return this.opts.config.approvers ?? [];
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

    const buttons = buildExecApprovalButtons(request.id);
    const text = buildRequestMessageText(request, Date.now());

    const target = this.opts.config.target ?? "dm";
    const sendToDm = target === "dm" || target === "both";
    const sendToChannel = target === "channel" || target === "both";

    const messages = new Map<string, { chatId: string; messageId: string }>();

    // Send to originating channel if configured
    if (sendToChannel) {
      const chatId = extractTelegramChatId(request.request.sessionKey);
      if (chatId) {
        try {
          const result = await sendMessageTelegram(chatId, text, {
            accountId: this.opts.accountId,
            buttons,
            textMode: "html",
          });
          messages.set(`channel:${chatId}`, {
            chatId,
            messageId: result.messageId,
          });
          logDebug(`telegram exec approvals: sent approval ${request.id} to chat ${chatId}`);
        } catch (err) {
          logError(`telegram exec approvals: failed to send to channel: ${String(err)}`);
        }
      } else if (!sendToDm) {
        logError(
          `telegram exec approvals: target is "channel" but could not extract chat id from session key "${request.request.sessionKey ?? "(none)"}" — falling back to DM`,
        );
        // Fall through to DM below
      }
    }

    // Send to approver DMs if configured
    if (sendToDm || (sendToChannel && messages.size === 0)) {
      const approvers = this.opts.config.approvers ?? [];
      for (const approver of approvers) {
        const userId = String(approver);
        try {
          const result = await sendMessageTelegram(userId, text, {
            accountId: this.opts.accountId,
            buttons,
            textMode: "html",
          });
          messages.set(`dm:${userId}`, {
            chatId: userId,
            messageId: result.messageId,
          });
          logDebug(`telegram exec approvals: sent approval ${request.id} to user ${userId}`);
        } catch (err) {
          logError(`telegram exec approvals: failed to notify user ${userId}: ${String(err)}`);
        }
      }
    }

    if (messages.size === 0) {
      return;
    }

    const timeoutMs = Math.max(0, request.expiresAtMs - Date.now());
    const timeoutId = setTimeout(() => {
      void this.handleApprovalTimeout(request.id);
    }, timeoutMs);
    timeoutId.unref?.();

    this.pending.set(request.id, { request, messages, timeoutId });
  }

  private async handleApprovalResolved(resolved: ExecApprovalResolved): Promise<void> {
    const entry = this.pending.get(resolved.id);
    if (!entry) {
      return;
    }

    clearTimeout(entry.timeoutId);
    this.pending.delete(resolved.id);

    logDebug(`telegram exec approvals: resolved ${resolved.id} with ${resolved.decision}`);

    const text = buildResolvedMessageText(resolved, entry.request);
    await this.updateOrDeleteMessages(entry, text);
  }

  private async handleApprovalTimeout(approvalId: string): Promise<void> {
    const entry = this.pending.get(approvalId);
    if (!entry) {
      return;
    }

    this.pending.delete(approvalId);

    logDebug(`telegram exec approvals: timeout for ${approvalId}`);

    const text = buildExpiredMessageText(entry.request);
    await this.updateOrDeleteMessages(entry, text);
  }

  private async updateOrDeleteMessages(entry: PendingApproval, text: string): Promise<void> {
    const cleanup = this.opts.config.cleanupAfterResolve === true;

    for (const { chatId, messageId } of entry.messages.values()) {
      try {
        if (cleanup) {
          const { deleteMessageTelegram } = await import("./send.js");
          await deleteMessageTelegram(chatId, messageId, {
            accountId: this.opts.accountId,
          });
        } else {
          await editMessageTelegram(chatId, messageId, text, {
            accountId: this.opts.accountId,
            buttons: [], // Remove inline keyboard
            textMode: "html",
          });
        }
      } catch (err) {
        logError(
          `telegram exec approvals: failed to update message ${messageId} in ${chatId}: ${String(err)}`,
        );
      }
    }
  }
}
