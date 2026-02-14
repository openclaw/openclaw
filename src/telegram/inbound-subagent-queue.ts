import type { Bot } from "grammy";
import crypto from "node:crypto";
import type { RuntimeEnv } from "../runtime.js";
import { AGENT_LANE_SUBAGENT } from "../agents/lanes.js";
import { extractAssistantText, stripToolMessages } from "../agents/tools/sessions-helpers.js";
import { callGateway } from "../gateway/call.js";
import { danger, logVerbose } from "../globals.js";
import { withTelegramApiErrorLogging } from "./api-logging.js";
import { buildTelegramThreadParams, type TelegramThreadSpec } from "./bot/helpers.js";
import {
  appendTelegramQueueTurn,
  buildTelegramChatKey,
  buildTelegramChatMemoryPrompt,
  loadTelegramQueueMemory,
} from "./inbound-subagent-history.js";

const MAX_GLOBAL_INFLIGHT = 3;
const MAX_PER_CHAT_INFLIGHT = 3;
const WAIT_STEP_TIMEOUT_MS = 1200;
const STREAM_POLL_INTERVAL_MS = 850;
const STREAM_TEXT_MAX_CHARS = 3800;

type GatewayHistory = { messages?: unknown[] };

type TelegramInboundTask = {
  storePath: string;
  sessionKey: string;
  chatId: number;
  accountId?: string;
  agentId: string;
  messageId: number;
  threadSpec?: TelegramThreadSpec;
  bodyForAgent: string;
  senderLabel?: string;
  messageSid?: string;
  chatKey: string;
};

type TelegramInboundQueueDeps = {
  bot: Bot;
  runtime: RuntimeEnv;
};

function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clampText(text: string): string {
  if (text.length <= STREAM_TEXT_MAX_CHARS) {
    return text;
  }
  return `${text.slice(0, STREAM_TEXT_MAX_CHARS - 1)}…`;
}

function sanitizeMessageText(text: string): string {
  const cleaned = text.split("\u0000").join("").trim();
  if (!cleaned) {
    return "(no response)";
  }
  return clampText(cleaned);
}

function toInt(value: string | number | undefined): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const parsed = Number.parseInt(value.trim(), 10);
  if (!Number.isFinite(parsed)) {
    return undefined;
  }
  return parsed;
}

async function readLatestAssistantReply(sessionKey: string): Promise<string | undefined> {
  const history = await callGateway<GatewayHistory>({
    method: "chat.history",
    params: { sessionKey, limit: 80 },
    timeoutMs: 10_000,
  });
  const filtered = stripToolMessages(Array.isArray(history?.messages) ? history.messages : []);
  const last = filtered.length > 0 ? filtered[filtered.length - 1] : undefined;
  const text = last ? extractAssistantText(last) : undefined;
  return typeof text === "string" && text.trim() ? text.trim() : undefined;
}

function buildSubagentPrompt(params: {
  memoryPrompt: string;
  userMessage: string;
  senderLabel?: string;
}): string {
  const parts = [
    "You are handling one Telegram inbound message from a queued worker.",
    params.memoryPrompt ? params.memoryPrompt : "",
    `[Current user message${params.senderLabel ? ` from ${params.senderLabel}` : ""}]`,
    params.userMessage,
    "Reply to the current message directly. Keep context from memory concise and relevant.",
  ].filter(Boolean);
  return parts.join("\n\n");
}

export class TelegramInboundSubagentQueue {
  private readonly bot: Bot;
  private readonly runtime: RuntimeEnv;
  private readonly queueByChat = new Map<string, TelegramInboundTask[]>();
  private readonly inFlightByChat = new Map<string, number>();
  private globalInFlight = 0;
  private pumping = false;
  private gatewayReachable = false;
  private gatewayCheckedAt = 0;

  constructor(deps: TelegramInboundQueueDeps) {
    this.bot = deps.bot;
    this.runtime = deps.runtime;
  }

  private async ensureGatewayReachable(): Promise<boolean> {
    const now = Date.now();
    // Cache probe result briefly to avoid probing on every incoming message.
    if (now - this.gatewayCheckedAt < 3000) {
      return this.gatewayReachable;
    }
    this.gatewayCheckedAt = now;
    try {
      await callGateway({
        method: "node.list",
        params: {},
        timeoutMs: 800,
      });
      this.gatewayReachable = true;
    } catch {
      this.gatewayReachable = false;
    }
    return this.gatewayReachable;
  }

  async enqueue(params: {
    storePath: string;
    sessionKey: string;
    chatId: number;
    accountId?: string;
    agentId: string;
    messageId: number | string;
    messageSid?: string;
    bodyForAgent: string;
    senderLabel?: string;
    threadSpec?: TelegramThreadSpec;
  }): Promise<boolean> {
    if (!(await this.ensureGatewayReachable())) {
      return false;
    }
    const messageId = toInt(params.messageId);
    const bodyForAgent = params.bodyForAgent.trim();
    if (!messageId || !bodyForAgent) {
      return false;
    }
    const chatKey = buildTelegramChatKey({
      accountId: params.accountId,
      chatId: params.chatId,
      threadId: params.threadSpec?.id,
    });
    await appendTelegramQueueTurn({
      storePath: params.storePath,
      sessionKey: params.sessionKey,
      chatKey,
      turn: {
        role: "user",
        text: bodyForAgent,
        messageId: params.messageSid ?? String(messageId),
        ts: Date.now(),
      },
    });

    const task: TelegramInboundTask = {
      storePath: params.storePath,
      sessionKey: params.sessionKey,
      chatId: params.chatId,
      accountId: params.accountId,
      agentId: params.agentId,
      messageId,
      threadSpec: params.threadSpec,
      bodyForAgent,
      senderLabel: params.senderLabel,
      messageSid: params.messageSid,
      chatKey,
    };
    const queue = this.queueByChat.get(chatKey) ?? [];
    queue.push(task);
    this.queueByChat.set(chatKey, queue);
    this.pump();
    return true;
  }

  private getInFlight(chatKey: string): number {
    return this.inFlightByChat.get(chatKey) ?? 0;
  }

  private setInFlight(chatKey: string, count: number): void {
    if (count <= 0) {
      this.inFlightByChat.delete(chatKey);
      return;
    }
    this.inFlightByChat.set(chatKey, count);
  }

  private tryTakeTask(): TelegramInboundTask | null {
    if (this.globalInFlight >= MAX_GLOBAL_INFLIGHT) {
      return null;
    }
    for (const [chatKey, queue] of this.queueByChat) {
      if (queue.length === 0) {
        this.queueByChat.delete(chatKey);
        continue;
      }
      if (this.getInFlight(chatKey) >= MAX_PER_CHAT_INFLIGHT) {
        continue;
      }
      const task = queue.shift();
      if (!task) {
        continue;
      }
      if (queue.length === 0) {
        this.queueByChat.delete(chatKey);
      }
      this.globalInFlight += 1;
      this.setInFlight(chatKey, this.getInFlight(chatKey) + 1);
      return task;
    }
    return null;
  }

  private pump(): void {
    if (this.pumping) {
      return;
    }
    this.pumping = true;
    void (async () => {
      try {
        while (true) {
          const task = this.tryTakeTask();
          if (!task) {
            break;
          }
          void this.runTask(task).finally(() => {
            this.globalInFlight = Math.max(0, this.globalInFlight - 1);
            this.setInFlight(task.chatKey, this.getInFlight(task.chatKey) - 1);
            this.pump();
          });
        }
      } finally {
        this.pumping = false;
      }
    })();
  }

  private async setReaction(task: TelegramInboundTask, emoji: string): Promise<void> {
    const api = this.bot.api as unknown as {
      setMessageReaction?: (
        chatId: number | string,
        messageId: number,
        reactions: Array<{ type: "emoji"; emoji: string }>,
      ) => Promise<void>;
    };
    const reactionApi =
      typeof api.setMessageReaction === "function" ? api.setMessageReaction.bind(api) : null;
    if (!reactionApi) {
      return;
    }
    await withTelegramApiErrorLogging({
      operation: "setMessageReaction",
      runtime: this.runtime,
      fn: async () => {
        await reactionApi(task.chatId, task.messageId, [{ type: "emoji", emoji }]);
      },
    }).catch(() => undefined);
  }

  private async runTask(task: TelegramInboundTask): Promise<void> {
    const threadParams = buildTelegramThreadParams(task.threadSpec);
    await this.setReaction(task, "⏳");

    let streamMessageId: number | undefined;
    const sendStreamSeed = async () => {
      const sent = await withTelegramApiErrorLogging({
        operation: "sendMessage",
        runtime: this.runtime,
        fn: async () =>
          await this.bot.api.sendMessage(task.chatId, "⏳ Processing…", {
            ...threadParams,
            reply_to_message_id: task.messageId,
          }),
      });
      streamMessageId = sent?.message_id;
    };

    try {
      await sendStreamSeed();
      await this.setReaction(task, "👀");
      const memory = await loadTelegramQueueMemory({
        storePath: task.storePath,
        sessionKey: task.sessionKey,
        chatKey: task.chatKey,
      });
      const memoryPrompt = memory ? buildTelegramChatMemoryPrompt(memory) : "";
      const childSessionKey = `agent:${task.agentId}:subagent:${crypto.randomUUID()}`;
      const idempotencyKey = crypto.randomUUID();
      const prompt = buildSubagentPrompt({
        memoryPrompt,
        userMessage: task.bodyForAgent,
        senderLabel: task.senderLabel,
      });
      const response = await callGateway<{ runId?: string }>({
        method: "agent",
        params: {
          message: prompt,
          sessionKey: childSessionKey,
          idempotencyKey,
          deliver: false,
          lane: AGENT_LANE_SUBAGENT,
          channel: "telegram",
          to: `telegram:${task.chatId}`,
          accountId: task.accountId,
          threadId: task.threadSpec?.id != null ? String(task.threadSpec.id) : undefined,
          spawnedBy: task.sessionKey,
        },
        timeoutMs: 10_000,
      });
      const runId =
        typeof response?.runId === "string" && response.runId.trim()
          ? response.runId
          : idempotencyKey;

      let done = false;
      let failed = false;
      let finalText = "";
      while (!done) {
        const latest = await readLatestAssistantReply(childSessionKey).catch(() => undefined);
        if (latest && latest !== finalText && streamMessageId != null) {
          finalText = latest;
          const rendered = sanitizeMessageText(latest);
          await withTelegramApiErrorLogging({
            operation: "editMessageText",
            runtime: this.runtime,
            fn: async () =>
              await this.bot.api.editMessageText(task.chatId, streamMessageId!, rendered),
          }).catch(() => undefined);
        }

        const waited = await callGateway<{ status?: string; error?: string }>({
          method: "agent.wait",
          params: { runId, timeoutMs: WAIT_STEP_TIMEOUT_MS },
          timeoutMs: WAIT_STEP_TIMEOUT_MS + 1500,
        });
        if (waited?.status === "ok") {
          done = true;
          break;
        }
        if (waited?.status === "error") {
          done = true;
          failed = true;
          finalText = waited.error?.trim() || "Subagent failed.";
          break;
        }
        await waitMs(STREAM_POLL_INTERVAL_MS);
      }

      if (!finalText) {
        finalText = (await readLatestAssistantReply(childSessionKey).catch(() => undefined)) ?? "";
      }
      if (!finalText) {
        finalText = failed ? "Subagent failed." : "(no response)";
      }
      const renderedFinal = sanitizeMessageText(finalText);

      if (streamMessageId != null) {
        await withTelegramApiErrorLogging({
          operation: "editMessageText",
          runtime: this.runtime,
          fn: async () =>
            await this.bot.api.editMessageText(task.chatId, streamMessageId!, renderedFinal),
        }).catch(async () => {
          await withTelegramApiErrorLogging({
            operation: "sendMessage",
            runtime: this.runtime,
            fn: async () =>
              await this.bot.api.sendMessage(task.chatId, renderedFinal, {
                ...threadParams,
                reply_to_message_id: task.messageId,
              }),
          }).catch(() => undefined);
        });
      } else {
        await withTelegramApiErrorLogging({
          operation: "sendMessage",
          runtime: this.runtime,
          fn: async () =>
            await this.bot.api.sendMessage(task.chatId, renderedFinal, {
              ...threadParams,
              reply_to_message_id: task.messageId,
            }),
        }).catch(() => undefined);
      }

      await appendTelegramQueueTurn({
        storePath: task.storePath,
        sessionKey: task.sessionKey,
        chatKey: task.chatKey,
        turn: {
          role: "assistant",
          text: renderedFinal,
          messageId: streamMessageId != null ? String(streamMessageId) : undefined,
          ts: Date.now(),
        },
      });
      await this.setReaction(task, failed ? "⚠️" : "👌");
    } catch (err) {
      this.runtime.error?.(
        danger(
          `telegram queue worker failed: chatId=${task.chatId} messageId=${task.messageId} error=${String(err)}`,
        ),
      );
      const fallbackText = "⚠️ Failed to process queued message. Please try again.";
      if (streamMessageId != null) {
        await withTelegramApiErrorLogging({
          operation: "editMessageText",
          runtime: this.runtime,
          fn: async () =>
            await this.bot.api.editMessageText(task.chatId, streamMessageId!, fallbackText),
        }).catch(() => undefined);
      } else {
        await withTelegramApiErrorLogging({
          operation: "sendMessage",
          runtime: this.runtime,
          fn: async () =>
            await this.bot.api.sendMessage(task.chatId, fallbackText, {
              ...threadParams,
              reply_to_message_id: task.messageId,
            }),
        }).catch(() => undefined);
      }
      await this.setReaction(task, "⚠️");
    }
  }
}

export function logTelegramQueueEnqueued(chatId: number, messageId: number): void {
  logVerbose(
    `telegram inbound queued (builtin): chatId=${String(chatId)} messageId=${String(messageId)}`,
  );
}
