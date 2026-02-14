import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { ChannelId, ChannelThreadingToolContext } from "../../channels/plugins/types.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { GatewayClientMode, GatewayClientName } from "../../utils/message-channel.js";
import type { OutboundSendDeps } from "./deliver.js";
import type { MessagePollResult, MessageSendResult } from "./message.js";
import { dispatchChannelMessageAction } from "../../channels/plugins/message-actions.js";
import { appendAssistantMessageToSessionTranscript } from "../../config/sessions.js";
import { throwIfAborted } from "./abort.js";
import { sendMessage, sendPoll } from "./message.js";

export type OutboundGatewayContext = {
  url?: string;
  token?: string;
  timeoutMs?: number;
  clientName: GatewayClientName;
  clientDisplayName?: string;
  mode: GatewayClientMode;
};

export type OutboundSendContext = {
  cfg: OpenClawConfig;
  channel: ChannelId;
  params: Record<string, unknown>;
  accountId?: string | null;
  gateway?: OutboundGatewayContext;
  toolContext?: ChannelThreadingToolContext;
  deps?: OutboundSendDeps;
  dryRun: boolean;
  mirror?: {
    sessionKey: string;
    agentId?: string;
    text?: string;
    mediaUrls?: string[];
  };
  abortSignal?: AbortSignal;
  silent?: boolean;
};

function extractToolPayload(result: AgentToolResult<unknown>): unknown {
  if (result.details !== undefined) {
    return result.details;
  }
  const textBlock = Array.isArray(result.content)
    ? result.content.find(
        (block) =>
          block &&
          typeof block === "object" &&
          (block as { type?: unknown }).type === "text" &&
          typeof (block as { text?: unknown }).text === "string",
      )
    : undefined;
  const text = (textBlock as { text?: string } | undefined)?.text;
  if (text) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return result.content ?? result;
}

export async function executeSendAction(params: {
  ctx: OutboundSendContext;
  to: string;
  message: string;
  mediaUrl?: string;
  mediaUrls?: string[];
  gifPlayback?: boolean;
  bestEffort?: boolean;
  replyToId?: string;
  threadId?: string | number;
}): Promise<{
  handledBy: "plugin" | "core";
  payload: unknown;
  toolResult?: AgentToolResult<unknown>;
  sendResult?: MessageSendResult;
}> {
  throwIfAborted(params.ctx.abortSignal);
  if (!params.ctx.dryRun) {
    const handled = await dispatchChannelMessageAction({
      channel: params.ctx.channel,
      action: "send",
      cfg: params.ctx.cfg,
      params: params.ctx.params,
      accountId: params.ctx.accountId ?? undefined,
      gateway: params.ctx.gateway,
      toolContext: params.ctx.toolContext,
      dryRun: params.ctx.dryRun,
    });
    if (handled) {
      if (params.ctx.mirror) {
        const mirrorText = params.ctx.mirror.text ?? params.message;
        const mirrorMediaUrls =
          params.ctx.mirror.mediaUrls ??
          params.mediaUrls ??
          (params.mediaUrl ? [params.mediaUrl] : undefined);
        await appendAssistantMessageToSessionTranscript({
          agentId: params.ctx.mirror.agentId,
          sessionKey: params.ctx.mirror.sessionKey,
          text: mirrorText,
          mediaUrls: mirrorMediaUrls,
        });
      }
      return {
        handledBy: "plugin",
        payload: extractToolPayload(handled),
        toolResult: handled,
      };
    }
  }

  throwIfAborted(params.ctx.abortSignal);
  const result: MessageSendResult = await sendMessage({
    cfg: params.ctx.cfg,
    to: params.to,
    content: params.message,
    mediaUrl: params.mediaUrl || undefined,
    mediaUrls: params.mediaUrls,
    channel: params.ctx.channel || undefined,
    accountId: params.ctx.accountId ?? undefined,
    replyToId: params.replyToId,
    threadId: params.threadId,
    gifPlayback: params.gifPlayback,
    dryRun: params.ctx.dryRun,
    bestEffort: params.bestEffort ?? undefined,
    deps: params.ctx.deps,
    gateway: params.ctx.gateway,
    mirror: params.ctx.mirror,
    abortSignal: params.ctx.abortSignal,
    silent: params.ctx.silent,
  });

  return {
    handledBy: "core",
    payload: result,
    sendResult: result,
  };
}

export async function executePollAction(params: {
  ctx: OutboundSendContext;
  to: string;
  question: string;
  options: string[];
  maxSelections: number;
  durationSeconds?: number;
  durationHours?: number;
  threadId?: string;
  isAnonymous?: boolean;
}): Promise<{
  handledBy: "plugin" | "core";
  payload: unknown;
  toolResult?: AgentToolResult<unknown>;
  pollResult?: MessagePollResult;
}> {
  if (!params.ctx.dryRun) {
    const handled = await dispatchChannelMessageAction({
      channel: params.ctx.channel,
      action: "poll",
      cfg: params.ctx.cfg,
      params: params.ctx.params,
      accountId: params.ctx.accountId ?? undefined,
      gateway: params.ctx.gateway,
      toolContext: params.ctx.toolContext,
      dryRun: params.ctx.dryRun,
    });
    if (handled) {
      return {
        handledBy: "plugin",
        payload: extractToolPayload(handled),
        toolResult: handled,
      };
    }
  }

  const result: MessagePollResult = await sendPoll({
    cfg: params.ctx.cfg,
    to: params.to,
    question: params.question,
    options: params.options,
    maxSelections: params.maxSelections,
    durationSeconds: params.durationSeconds ?? undefined,
    durationHours: params.durationHours ?? undefined,
    channel: params.ctx.channel,
    accountId: params.ctx.accountId ?? undefined,
    threadId: params.threadId ?? undefined,
    silent: params.ctx.silent ?? undefined,
    isAnonymous: params.isAnonymous ?? undefined,
    dryRun: params.ctx.dryRun,
    gateway: params.ctx.gateway,
  });

  return {
    handledBy: "core",
    payload: result,
    pollResult: result,
  };
}
