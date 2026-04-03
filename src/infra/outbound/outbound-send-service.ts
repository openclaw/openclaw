import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { dispatchChannelMessageAction } from "../../channels/plugins/message-action-dispatch.js";
import type { ChannelId, ChannelThreadingToolContext } from "../../channels/plugins/types.js";
import type { OpenClawConfig } from "../../config/config.js";
import { appendAssistantMessageToSessionTranscript } from "../../config/sessions.js";
import type { OutboundMediaAccess, OutboundMediaReadFile } from "../../media/load-options.js";
import { resolveAgentScopedOutboundMediaAccess } from "../../media/read-capability.js";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import type { GatewayClientMode, GatewayClientName } from "../../utils/message-channel.js";
import { throwIfAborted } from "./abort.js";
import type { OutboundSendDeps } from "./deliver.js";
import type { MessagePollResult, MessageSendResult } from "./message.js";
import { sendMessage, sendPoll } from "./message.js";
import type { OutboundMirror } from "./mirror.js";
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
  mediaAccess?: OutboundMediaAccess;
  mediaReadFile?: OutboundMediaReadFile;
  accountId?: string | null;
  gateway?: OutboundGatewayContext;
  toolContext?: ChannelThreadingToolContext;
  deps?: OutboundSendDeps;
  dryRun: boolean;
  mirror?: OutboundMirror;
  abortSignal?: AbortSignal;
  silent?: boolean;
};

type PluginHandledResult = {
  handledBy: "plugin";
  payload: unknown;
  toolResult: AgentToolResult<unknown>;
};

function collectActionMediaSources(params: Record<string, unknown>): string[] {
  const sources: string[] = [];
  for (const key of ["media", "mediaUrl", "path", "filePath", "fileUrl"] as const) {
    const value = params[key];
    if (typeof value === "string" && value.trim()) {
      sources.push(value);
    }
  }
  return sources;
}

async function tryHandleWithPluginAction(params: {
  ctx: OutboundSendContext;
  action: "send" | "poll";
  onHandled?: () => Promise<void> | void;
}): Promise<PluginHandledResult | null> {
  if (params.ctx.dryRun) {
    return null;
  }
  const mediaAccess = resolveAgentScopedOutboundMediaAccess({
    cfg: params.ctx.cfg,
    agentId: params.ctx.agentId ?? params.ctx.mirror?.agentId,
    mediaSources: collectActionMediaSources(params.ctx.params),
    mediaAccess: params.ctx.mediaAccess,
    mediaReadFile: params.ctx.mediaReadFile,
  });
  const handled = await dispatchChannelMessageAction({
    channel: params.ctx.channel,
    action: params.action,
    cfg: params.ctx.cfg,
    params: params.ctx.params,
    mediaAccess,
    mediaLocalRoots: mediaAccess.localRoots,
    mediaReadFile: mediaAccess.readFile,
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
  forceDocument?: boolean;
  bestEffort?: boolean;
  replyToId?: string;
  threadId?: string | number;
}): Promise<{
  handledBy: "plugin" | "core";
  payload: unknown;
  toolResult?: AgentToolResult<unknown>;
  sendResult?: MessageSendResult;
  cancelled?: true;
}> {
  throwIfAborted(params.ctx.abortSignal);

  // Run message_sending hook before plugin or core dispatch so it fires for
  // both Branch A (plugin-handled) and Branch B2 (gateway) sends — the hook
  // already fires on Branch B1 (direct delivery) inside deliverOutboundPayloads.
  const hookRunner = getGlobalHookRunner();
  const hasMessageSendingHooks = hookRunner?.hasHooks("message_sending") ?? false;
  let message = params.message;

  if (!params.ctx.dryRun && hasMessageSendingHooks) {
    try {
      const sendingResult = await hookRunner!.runMessageSending(
        {
          to: params.to,
          content: message,
          metadata: {
            channel: params.ctx.channel,
            accountId: params.ctx.accountId,
          },
        },
        {
          channelId: params.ctx.channel,
          accountId: params.ctx.accountId ?? undefined,
        },
      );
      if (sendingResult?.cancel) {
        return {
          handledBy: "core",
          payload: { cancelled: true },
          cancelled: true,
          sendResult: {
            channel: params.ctx.channel,
            to: params.to,
            via: "direct",
            mediaUrl: null,
            cancelled: true,
          },
        };
      }
      if (sendingResult?.content != null) {
        message = sendingResult.content;
        params.ctx.params.message = sendingResult.content;
        if (params.ctx.mirror) {
          params.ctx.mirror = { ...params.ctx.mirror, text: sendingResult.content };
        }
      }
    } catch {
      // Don't block delivery on hook failure.
    }
  }

  const pluginHandled = await tryHandleWithPluginAction({
    ctx: params.ctx,
    action: "send",
    onHandled: async () => {
      if (!params.ctx.mirror) {
        return;
      }
      const mirrorText = params.ctx.mirror.text ?? message;
      const mirrorMediaUrls =
        params.ctx.mirror.mediaUrls ??
        params.mediaUrls ??
        (params.mediaUrl ? [params.mediaUrl] : undefined);
      await appendAssistantMessageToSessionTranscript({
        agentId: params.ctx.mirror.agentId,
        sessionKey: params.ctx.mirror.sessionKey,
        text: mirrorText,
        mediaUrls: mirrorMediaUrls,
        idempotencyKey: params.ctx.mirror.idempotencyKey,
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
    content: message,
    agentId: params.ctx.agentId,
    mediaUrl: params.mediaUrl || undefined,
    mediaUrls: params.mediaUrls,
    channel: params.ctx.channel || undefined,
    accountId: params.ctx.accountId ?? undefined,
    replyToId: params.replyToId,
    threadId: params.threadId,
    gifPlayback: params.gifPlayback,
    forceDocument: params.forceDocument,
    dryRun: params.ctx.dryRun,
    bestEffort: params.bestEffort ?? undefined,
    deps: params.ctx.deps,
    gateway: params.ctx.gateway,
    mirror: params.ctx.mirror,
    abortSignal: params.ctx.abortSignal,
    silent: params.ctx.silent,
    // Hook already ran above; skip it inside deliverOutboundPayloads (B1) to
    // prevent double-fire.
    skipMessageSendingHook: hasMessageSendingHooks,
  });

  return {
    handledBy: "core",
    payload: result,
    sendResult: result,
  };
}

export async function executePollAction(params: {
  ctx: OutboundSendContext;
  resolveCorePoll: () => {
    to: string;
    question: string;
    options: string[];
    maxSelections: number;
    durationSeconds?: number;
    durationHours?: number;
    threadId?: string;
    isAnonymous?: boolean;
  };
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

  const corePoll = params.resolveCorePoll();
  const result: MessagePollResult = await sendPoll({
    cfg: params.ctx.cfg,
    to: corePoll.to,
    question: corePoll.question,
    options: corePoll.options,
    maxSelections: corePoll.maxSelections,
    durationSeconds: corePoll.durationSeconds ?? undefined,
    durationHours: corePoll.durationHours ?? undefined,
    channel: params.ctx.channel,
    accountId: params.ctx.accountId ?? undefined,
    threadId: corePoll.threadId ?? undefined,
    silent: params.ctx.silent ?? undefined,
    isAnonymous: corePoll.isAnonymous ?? undefined,
    dryRun: params.ctx.dryRun,
    gateway: params.ctx.gateway,
  });

  return {
    handledBy: "core",
    payload: result,
    pollResult: result,
  };
}
