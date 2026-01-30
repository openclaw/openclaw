/**
 * Feishu Bot Message Handler
 *
 * Processes incoming messages and generates responses using the agent system.
 */

import type { OpenClawConfig } from "../config/config.js";
import { loadConfig } from "../config/config.js";
import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import { DEFAULT_GROUP_HISTORY_LIMIT, type HistoryEntry } from "../auto-reply/reply/history.js";
import {
  resolveChannelGroupPolicy,
  resolveChannelGroupRequireMention,
} from "../config/group-policy.js";
import { danger, logVerbose } from "../globals.js";
import { formatUncaughtError } from "../infra/errors.js";
import type { RuntimeEnv } from "../runtime.js";
import { resolveFeishuAccount, type ResolvedFeishuAccount } from "./accounts.js";
import { createFeishuClient, type FeishuClient } from "./client.js";
import type { FeishuMessageContext } from "./monitor.js";

export type FeishuBotOptions = {
  accountId?: string;
  runtime?: RuntimeEnv;
  config?: OpenClawConfig;
  /** Whether to require @mention in group chats */
  requireMention?: boolean;
  /** Allowlist for DM senders */
  allowFrom?: string[];
  /** Allowlist for group senders */
  groupAllowFrom?: string[];
};

export type FeishuBotContext = {
  bot: FeishuBot;
  ctx: FeishuMessageContext;
};

/**
 * Feishu Bot class for handling messages
 */
export class FeishuBot {
  readonly account: ResolvedFeishuAccount;
  readonly client: FeishuClient;
  readonly cfg: OpenClawConfig;
  readonly runtime: RuntimeEnv;

  private readonly historyLimit: number;
  private readonly groupHistories = new Map<string, HistoryEntry[]>();
  private readonly opts: FeishuBotOptions;
  private botOpenId?: string;

  constructor(opts: FeishuBotOptions) {
    this.cfg = opts.config ?? loadConfig();
    this.runtime = opts.runtime ?? {
      log: console.log,
      error: console.error,
      exit: (code: number): never => {
        throw new Error(`exit ${code}`);
      },
    };
    this.opts = opts;

    this.account = resolveFeishuAccount({
      cfg: this.cfg,
      accountId: opts.accountId,
    });

    if (this.account.credentials.source === "none") {
      throw new Error(`Feishu credentials missing for account "${this.account.accountId}".`);
    }

    this.client = createFeishuClient(this.account.credentials, {
      timeoutMs: (this.account.config.timeoutSeconds ?? 30) * 1000,
    });

    this.historyLimit = Math.max(
      0,
      this.account.config.historyLimit ??
        this.cfg.messages?.groupChat?.historyLimit ??
        DEFAULT_GROUP_HISTORY_LIMIT,
    );
  }

  /**
   * Initialize the bot (fetch bot info)
   */
  async init(): Promise<void> {
    try {
      const botInfo = await this.client.getBotInfo();
      this.botOpenId = botInfo.open_id;
      this.runtime.log?.(`feishu: initialized as "${botInfo.app_name}" (${botInfo.open_id})`);
    } catch (err) {
      throw new Error(`Feishu bot init failed: ${formatUncaughtError(err)}`);
    }
  }

  /**
   * Check if sender is allowed based on allowlist
   */
  private isAllowed(ctx: FeishuMessageContext): boolean {
    const isGroup = ctx.chatType === "group";
    const senderId = ctx.senderId;

    // Check group policy
    if (isGroup) {
      const groupPolicy = resolveChannelGroupPolicy({
        cfg: this.cfg,
        channel: "feishu",
        accountId: this.account.accountId,
        groupId: ctx.chatId,
      });

      // Check if the group is allowed based on allowlist
      if (groupPolicy.allowlistEnabled && !groupPolicy.allowed) {
        logVerbose(`feishu: group ${ctx.chatId} not in allowlist`);
        return false;
      }

      // Check groupAllowFrom for sender filtering
      const groupAllowFrom = this.opts.groupAllowFrom ?? this.account.config.groupAllowFrom ?? [];
      if (groupAllowFrom.length > 0 && !groupAllowFrom.includes(senderId)) {
        logVerbose(`feishu: sender ${senderId} not in group allowlist`);
        return false;
      }
    } else {
      // DM policy
      const dmPolicy = this.account.config.dmPolicy ?? "pairing";
      if (dmPolicy === "disabled") {
        logVerbose(`feishu: DMs disabled`);
        return false;
      }

      if (dmPolicy === "allowlist") {
        const allowFrom = this.opts.allowFrom ?? this.account.config.allowFrom ?? [];
        if (allowFrom.length > 0 && !allowFrom.includes(senderId)) {
          logVerbose(`feishu: sender ${senderId} not in allowlist`);
          return false;
        }
      }
    }

    return true;
  }

  /**
   * Check if mention is required in this chat
   */
  private requiresMention(ctx: FeishuMessageContext): boolean {
    if (ctx.chatType !== "group") return false;

    // Check explicit requireMention option
    if (this.opts.requireMention !== undefined) {
      return this.opts.requireMention;
    }

    // Check config-based mention requirement
    return resolveChannelGroupRequireMention({
      cfg: this.cfg,
      channel: "feishu",
      accountId: this.account.accountId,
      groupId: ctx.chatId,
    });
  }

  /**
   * Process a message and determine if a response should be generated
   */
  shouldRespond(ctx: FeishuMessageContext): boolean {
    // Skip if sender is not allowed
    if (!this.isAllowed(ctx)) {
      return false;
    }

    // Check mention requirement for groups
    if (this.requiresMention(ctx) && !ctx.wasMentioned) {
      logVerbose(`feishu: mention required but not mentioned in group ${ctx.chatId}`);
      return false;
    }

    // Skip empty messages
    if (!ctx.text.trim()) {
      return false;
    }

    return true;
  }

  /**
   * Add message to group history
   */
  recordHistory(ctx: FeishuMessageContext, response?: string): void {
    if (this.historyLimit === 0) return;
    if (ctx.chatType !== "group") return;

    const key = ctx.chatId;
    let history = this.groupHistories.get(key);
    if (!history) {
      history = [];
      this.groupHistories.set(key, history);
    }

    // Add user message
    history.push({
      sender: ctx.senderId,
      body: ctx.text,
      timestamp: Date.now(),
      messageId: ctx.messageId,
    });

    // Add assistant response if provided
    if (response) {
      history.push({
        sender: "assistant",
        body: response,
        timestamp: Date.now(),
      });
    }

    // Trim to limit
    while (history.length > this.historyLimit * 2) {
      history.shift();
    }
  }

  /**
   * Get group history for context
   */
  getHistory(chatId: string): HistoryEntry[] {
    return this.groupHistories.get(chatId) ?? [];
  }

  /**
   * Handle an incoming message
   * This is called by the monitor when a message is received
   */
  async handleMessage(ctx: FeishuMessageContext): Promise<void> {
    try {
      if (!this.shouldRespond(ctx)) {
        return;
      }

      // Record the incoming message
      this.recordHistory(ctx);

      // Log the message
      logVerbose(
        `feishu: received message from ${ctx.senderId} in ${ctx.chatType} ${ctx.chatId}: ${ctx.text.substring(0, 100)}`,
      );

      // Here you would integrate with the agent system to generate a response
      // For now, we'll just echo back the message as a placeholder
      // In production, this would be replaced with actual agent logic

      // Example response (placeholder)
      // const response = await generateAgentResponse(ctx);
      // await ctx.reply(response);
      // this.recordHistory(ctx, response);
    } catch (err) {
      this.runtime.error?.(danger(`feishu: message handler error: ${formatUncaughtError(err)}`));
    }
  }
}

/**
 * Create a Feishu bot instance
 */
export function createFeishuBot(opts: FeishuBotOptions): FeishuBot {
  return new FeishuBot(opts);
}

/**
 * Build session key for a Feishu chat
 */
export function buildFeishuSessionKey(params: {
  agentId?: string;
  chatId: string;
  chatType: "p2p" | "group";
  cfg?: OpenClawConfig;
}): string {
  const cfg = params.cfg ?? loadConfig();
  const agentId = params.agentId ?? resolveDefaultAgentId(cfg);
  const chatKind = params.chatType === "group" ? "group" : "dm";
  return `agent:${agentId}:feishu:${chatKind}:${params.chatId}`;
}

/**
 * Build peer ID for a Feishu chat
 */
export function buildFeishuPeerId(chatId: string, threadId?: string): string {
  return threadId ? `${chatId}:${threadId}` : chatId;
}
