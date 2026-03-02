import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import {
  canDispatchChannelMessageAction,
  dispatchChannelMessageAction,
} from "../../channels/plugins/message-actions.js";
import type { ChannelId, ChannelThreadingToolContext } from "../../channels/plugins/types.js";
import type { OpenClawConfig } from "../../config/config.js";
import { appendAssistantMessageToSessionTranscript } from "../../config/sessions.js";
import { getAgentScopedMediaLocalRoots } from "../../media/local-roots.js";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import type { GatewayClientMode, GatewayClientName } from "../../utils/message-channel.js";
import { throwIfAborted } from "./abort.js";
import type { OutboundSendDeps } from "./deliver.js";
import type { MessagePollResult, MessageSendResult } from "./message.js";
import { sendMessage, sendPoll } from "./message.js";
import { extractToolPayload } from "./tool-payload.js";

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
  /** Active agent id for per-agent outbound media root scoping. */
  agentId?: string;
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

type PluginHandledResult = {
  handledBy: "plugin";
  payload: unknown;
  toolResult: AgentToolResult<unknown>;
};

type PluginSendAttempt = {
  to: string;
  content: string;
  mediaUrl?: string;
  mediaUrls?: string[];
};

function applyHookContentToActionParams(params: Record<string, unknown>, content: string): void {
  if (typeof params.message === "string" || !("caption" in params)) {
    params.message = content;
  }
  if (typeof params.caption === "string") {
    params.caption = content;
  }
  if (typeof params.content === "string") {
    params.content = content;
  }
}

function buildCancelledToolResult(): AgentToolResult<unknown> {
  const details = { ok: true, cancelled: true };
  return {
    content: [{ type: "text", text: JSON.stringify(details, null, 2) }],
    details,
  };
}

async function runMessageSendingHook(params: {
  ctx: OutboundSendContext;
  send: PluginSendAttempt;
}): Promise<{ cancelled: boolean; content: string }> {
  const hookRunner = getGlobalHookRunner();
  if (!hookRunner?.hasHooks("message_sending")) {
    return { cancelled: false, content: params.send.content };
  }
  try {
    const mediaUrls = params.send.mediaUrls ?? (params.send.mediaUrl ? [params.send.mediaUrl] : []);
    const hookResult = await hookRunner.runMessageSending(
      {
        to: params.send.to,
        content: params.send.content,
        metadata: {
          channel: params.ctx.channel,
          accountId: params.ctx.accountId ?? undefined,
          mediaUrls,
        },
      },
      {
        channelId: params.ctx.channel,
        accountId: params.ctx.accountId ?? undefined,
        conversationId: params.send.to,
      },
    );
    if (hookResult?.cancel) {
      return { cancelled: true, content: params.send.content };
    }
    return { cancelled: false, content: hookResult?.content ?? params.send.content };
  } catch {
    return { cancelled: false, content: params.send.content };
  }
}

async function tryHandleWithPluginAction(params: {
  ctx: OutboundSendContext;
  action: "send" | "poll";
  send?: PluginSendAttempt;
  onHandled?: () => Promise<void> | void;
}): Promise<PluginHandledResult | null> {
  if (params.ctx.dryRun) {
    return null;
  }
  if (!canDispatchChannelMessageAction({ channel: params.ctx.channel, action: params.action })) {
    return null;
  }
  if (params.action === "send" && params.send) {
    const hookResult = await runMessageSendingHook({
      ctx: params.ctx,
      send: params.send,
    });
    if (hookResult.cancelled) {
      const toolResult = buildCancelledToolResult();
      return {
        handledBy: "plugin",
        payload: extractToolPayload(toolResult),
        toolResult,
      };
    }
    params.send.content = hookResult.content;
    applyHookContentToActionParams(params.ctx.params, hookResult.content);
  }
  const mediaLocalRoots = getAgentScopedMediaLocalRoots(
    params.ctx.cfg,
    params.ctx.agentId ?? params.ctx.mirror?.agentId,
  );
  const handled = await dispatchChannelMessageAction({
    channel: params.ctx.channel,
    action: params.action,
    cfg: params.ctx.cfg,
    params: params.ctx.params,
    mediaLocalRoots,
    accountId: params.ctx.accountId ?? undefined,
    gateway: params.ctx.gateway,
    toolContext: params.ctx.toolContext,
    dryRun: params.ctx.dryRun,
  });
  if (!handled) {
    return null;
  }
  await params.onHandled?.();
  return {
    handledBy: "plugin",
    payload: extractToolPayload(handled),
    toolResult: handled,
  };
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
  const pluginSendAttempt: PluginSendAttempt = {
    to: params.to,
    content: params.message,
    mediaUrl: params.mediaUrl,
    mediaUrls: params.mediaUrls,
  };
  const pluginHandled = await tryHandleWithPluginAction({
    ctx: params.ctx,
    action: "send",
    send: pluginSendAttempt,
    onHandled: async () => {
      if (!params.ctx.mirror) {
        return;
      }
      const mirrorText = params.ctx.mirror.text ?? pluginSendAttempt.content;
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
    },
  });
  if (pluginHandled) {
    return pluginHandled;
  }

  throwIfAborted(params.ctx.abortSignal);
  const result: MessageSendResult = await sendMessage({
    cfg: params.ctx.cfg,
    to: params.to,
    content: pluginSendAttempt.content,
    agentId: params.ctx.agentId,
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
  const pluginHandled = await tryHandleWithPluginAction({
    ctx: params.ctx,
    action: "poll",
  });
  if (pluginHandled) {
    return pluginHandled;
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
