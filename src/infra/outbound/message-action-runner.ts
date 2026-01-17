import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import {
  readNumberParam,
  readStringArrayParam,
  readStringParam,
} from "../../agents/tools/common.js";
import { parseReplyDirectives } from "../../auto-reply/reply/reply-directives.js";
import { dispatchChannelMessageAction } from "../../channels/plugins/message-actions.js";
import type {
  ChannelId,
  ChannelMessageActionName,
  ChannelThreadingToolContext,
} from "../../channels/plugins/types.js";
import type { ClawdbotConfig } from "../../config/config.js";
import type { GatewayClientMode, GatewayClientName } from "../../utils/message-channel.js";
import {
  listConfiguredMessageChannels,
  resolveMessageChannelSelection,
} from "./channel-selection.js";
import type { OutboundSendDeps } from "./deliver.js";
import type { MessagePollResult, MessageSendResult } from "./message.js";
import { sendMessage, sendPoll } from "./message.js";
import {
  applyCrossContextDecoration,
  buildCrossContextDecoration,
  enforceCrossContextPolicy,
  shouldApplyCrossContextMarker,
} from "./outbound-policy.js";
import { resolveMessagingTarget } from "./target-resolver.js";

export type MessageActionRunnerGateway = {
  url?: string;
  token?: string;
  timeoutMs?: number;
  clientName: GatewayClientName;
  clientDisplayName?: string;
  mode: GatewayClientMode;
};

export type RunMessageActionParams = {
  cfg: ClawdbotConfig;
  action: ChannelMessageActionName;
  params: Record<string, unknown>;
  defaultAccountId?: string;
  toolContext?: ChannelThreadingToolContext;
  gateway?: MessageActionRunnerGateway;
  deps?: OutboundSendDeps;
  sessionKey?: string;
  agentId?: string;
  dryRun?: boolean;
};

export type MessageActionRunResult =
  | {
      kind: "send";
      channel: ChannelId;
      action: "send";
      to: string;
      handledBy: "plugin" | "core";
      payload: unknown;
      toolResult?: AgentToolResult<unknown>;
      sendResult?: MessageSendResult;
      dryRun: boolean;
    }
  | {
      kind: "broadcast";
      channel: ChannelId;
      action: "broadcast";
      handledBy: "core" | "dry-run";
      payload: {
        results: Array<{
          channel: ChannelId;
          to: string;
          ok: boolean;
          error?: string;
          result?: MessageSendResult;
        }>;
      };
      dryRun: boolean;
    }
  | {
      kind: "poll";
      channel: ChannelId;
      action: "poll";
      to: string;
      handledBy: "plugin" | "core";
      payload: unknown;
      toolResult?: AgentToolResult<unknown>;
      pollResult?: MessagePollResult;
      dryRun: boolean;
    }
  | {
      kind: "action";
      channel: ChannelId;
      action: Exclude<ChannelMessageActionName, "send" | "poll">;
      handledBy: "plugin" | "dry-run";
      payload: unknown;
      toolResult?: AgentToolResult<unknown>;
      dryRun: boolean;
    };

function extractToolPayload(result: AgentToolResult<unknown>): unknown {
  if (result.details !== undefined) return result.details;
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

function readBooleanParam(params: Record<string, unknown>, key: string): boolean | undefined {
  const raw = params[key];
  if (typeof raw === "boolean") return raw;
  if (typeof raw === "string") {
    const trimmed = raw.trim().toLowerCase();
    if (trimmed === "true") return true;
    if (trimmed === "false") return false;
  }
  return undefined;
}

function parseButtonsParam(params: Record<string, unknown>): void {
  const raw = params.buttons;
  if (typeof raw !== "string") return;
  const trimmed = raw.trim();
  if (!trimmed) {
    delete params.buttons;
    return;
  }
  try {
    params.buttons = JSON.parse(trimmed) as unknown;
  } catch {
    throw new Error("--buttons must be valid JSON");
  }
}

async function resolveChannel(cfg: ClawdbotConfig, params: Record<string, unknown>) {
  const channelHint = readStringParam(params, "channel");
  const selection = await resolveMessageChannelSelection({
    cfg,
    channel: channelHint,
  });
  return selection.channel;
}

async function resolveActionTarget(params: {
  cfg: ClawdbotConfig;
  channel: ChannelId;
  action: ChannelMessageActionName;
  args: Record<string, unknown>;
  accountId?: string | null;
}): Promise<void> {
  const toRaw = typeof params.args.to === "string" ? params.args.to.trim() : "";
  if (toRaw) {
    const resolved = await resolveMessagingTarget({
      cfg: params.cfg,
      channel: params.channel,
      input: toRaw,
      accountId: params.accountId ?? undefined,
    });
    if (resolved.ok) {
      params.args.to = resolved.target.to;
    } else {
      throw resolved.error;
    }
  }
  const channelIdRaw =
    typeof params.args.channelId === "string" ? params.args.channelId.trim() : "";
  if (channelIdRaw) {
    const resolved = await resolveMessagingTarget({
      cfg: params.cfg,
      channel: params.channel,
      input: channelIdRaw,
      accountId: params.accountId ?? undefined,
      preferredKind: "group",
    });
    if (resolved.ok) {
      if (resolved.target.kind === "user") {
        throw new Error(`Channel id "${channelIdRaw}" resolved to a user target.`);
      }
      params.args.channelId = resolved.target.to.replace(/^(channel|group):/i, "");
    } else {
      throw resolved.error;
    }
  }
}

export async function runMessageAction(
  input: RunMessageActionParams,
): Promise<MessageActionRunResult> {
  const cfg = input.cfg;
  const params = { ...input.params };
  parseButtonsParam(params);

  const action = input.action;
  if (action === "broadcast") {
    const broadcastEnabled = cfg.tools?.message?.broadcast?.enabled !== false;
    if (!broadcastEnabled) {
      throw new Error("Broadcast is disabled. Set tools.message.broadcast.enabled to true.");
    }
    const rawTargets = readStringArrayParam(params, "targets", { required: true }) ?? [];
    if (rawTargets.length === 0) {
      throw new Error("Broadcast requires at least one target in --targets.");
    }
    const channelHint = readStringParam(params, "channel");
    const configured = await listConfiguredMessageChannels(cfg);
    if (configured.length === 0) {
      throw new Error("Broadcast requires at least one configured channel.");
    }
    const targetChannels =
      channelHint && channelHint.trim().toLowerCase() !== "all"
        ? [await resolveChannel(cfg, { channel: channelHint })]
        : configured;
    const results: Array<{
      channel: ChannelId;
      to: string;
      ok: boolean;
      error?: string;
      result?: MessageSendResult;
    }> = [];
    for (const targetChannel of targetChannels) {
      for (const target of rawTargets) {
        try {
          const resolved = await resolveMessagingTarget({
            cfg,
            channel: targetChannel,
            input: target,
          });
          if (!resolved.ok) throw resolved.error;
          const sendResult = await runMessageAction({
            ...input,
            action: "send",
            params: {
              ...params,
              channel: targetChannel,
              to: resolved.target.to,
            },
          });
          results.push({
            channel: targetChannel,
            to: resolved.target.to,
            ok: true,
            result: sendResult.kind === "send" ? sendResult.sendResult : undefined,
          });
        } catch (err) {
          results.push({
            channel: targetChannel,
            to: target,
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
    return {
      kind: "broadcast",
      channel: (targetChannels[0] ?? "discord") as ChannelId,
      action: "broadcast",
      handledBy: input.dryRun ? "dry-run" : "core",
      payload: { results },
      dryRun: Boolean(input.dryRun),
    };
  }

  const channel = await resolveChannel(cfg, params);
  const accountId = readStringParam(params, "accountId") ?? input.defaultAccountId;
  const dryRun = Boolean(input.dryRun ?? readBooleanParam(params, "dryRun"));

  await resolveActionTarget({
    cfg,
    channel,
    action,
    args: params,
    accountId,
  });

  enforceCrossContextPolicy({
    channel,
    action,
    args: params,
    toolContext: input.toolContext,
    cfg,
  });

  const gateway = input.gateway
    ? {
        url: input.gateway.url,
        token: input.gateway.token,
        timeoutMs: input.gateway.timeoutMs,
        clientName: input.gateway.clientName,
        clientDisplayName: input.gateway.clientDisplayName,
        mode: input.gateway.mode,
      }
    : undefined;

  if (action === "send") {
    const to = readStringParam(params, "to", { required: true });
    // Allow message to be omitted when sending media-only (e.g., voice notes)
    const mediaHint = readStringParam(params, "media", { trim: false });
    let message =
      readStringParam(params, "message", {
        required: !mediaHint, // Only require message if no media hint
        allowEmpty: true,
      }) ?? "";

    const parsed = parseReplyDirectives(message);
    message = parsed.text;
    params.message = message;
    if (!params.replyTo && parsed.replyToId) params.replyTo = parsed.replyToId;
    if (!params.media) {
      params.media = parsed.mediaUrls?.[0] || parsed.mediaUrl || undefined;
    }

    const decoration =
      shouldApplyCrossContextMarker(action) && input.toolContext
        ? await buildCrossContextDecoration({
            cfg,
            channel,
            target: to,
            toolContext: input.toolContext,
            accountId: accountId ?? undefined,
          })
        : null;
    if (decoration) {
      const applied = applyCrossContextDecoration({
        message,
        decoration,
        preferEmbeds: true,
      });
      message = applied.message;
      params.message = applied.message;
      if (applied.embeds?.length) {
        params.embeds = applied.embeds;
      }
    }

    const mediaUrl = readStringParam(params, "media", { trim: false });
    const gifPlayback = readBooleanParam(params, "gifPlayback") ?? false;
    const bestEffort = readBooleanParam(params, "bestEffort");
    if (!dryRun) {
      const handled = await dispatchChannelMessageAction({
        channel,
        action,
        cfg,
        params,
        accountId: accountId ?? undefined,
        gateway,
        toolContext: input.toolContext,
        dryRun,
      });
      if (handled) {
        return {
          kind: "send",
          channel,
          action,
          to,
          handledBy: "plugin",
          payload: extractToolPayload(handled),
          toolResult: handled,
          dryRun,
        };
      }
    }

    const result: MessageSendResult = await sendMessage({
      cfg,
      to,
      content: message,
      mediaUrl: mediaUrl || undefined,
      channel: channel || undefined,
      accountId: accountId ?? undefined,
      gifPlayback,
      dryRun,
      bestEffort: bestEffort ?? undefined,
      deps: input.deps,
      gateway,
      mirror:
        input.sessionKey && !dryRun
          ? {
              sessionKey: input.sessionKey,
              agentId: input.agentId,
            }
          : undefined,
    });

    return {
      kind: "send",
      channel,
      action,
      to,
      handledBy: "core",
      payload: result,
      sendResult: result,
      dryRun,
    };
  }

  if (action === "poll") {
    const to = readStringParam(params, "to", { required: true });
    const question = readStringParam(params, "pollQuestion", {
      required: true,
    });
    const options = readStringArrayParam(params, "pollOption", { required: true }) ?? [];
    if (options.length < 2) {
      throw new Error("pollOption requires at least two values");
    }
    const allowMultiselect = readBooleanParam(params, "pollMulti") ?? false;
    const durationHours = readNumberParam(params, "pollDurationHours", {
      integer: true,
    });
    const maxSelections = allowMultiselect ? Math.max(2, options.length) : 1;
    const decoration =
      shouldApplyCrossContextMarker(action) && input.toolContext
        ? await buildCrossContextDecoration({
            cfg,
            channel,
            target: to,
            toolContext: input.toolContext,
            accountId: accountId ?? undefined,
          })
        : null;
    if (decoration) {
      const base = typeof params.message === "string" ? params.message : "";
      const applied = applyCrossContextDecoration({
        message: base,
        decoration,
        preferEmbeds: true,
      });
      params.message = applied.message;
      if (applied.embeds?.length) {
        params.embeds = applied.embeds;
      }
    }

    if (!dryRun) {
      const handled = await dispatchChannelMessageAction({
        channel,
        action,
        cfg,
        params,
        accountId: accountId ?? undefined,
        gateway,
        toolContext: input.toolContext,
        dryRun,
      });
      if (handled) {
        return {
          kind: "poll",
          channel,
          action,
          to,
          handledBy: "plugin",
          payload: extractToolPayload(handled),
          toolResult: handled,
          dryRun,
        };
      }
    }

    const result: MessagePollResult = await sendPoll({
      cfg,
      to,
      question,
      options,
      maxSelections,
      durationHours: durationHours ?? undefined,
      channel,
      dryRun,
      gateway,
    });

    return {
      kind: "poll",
      channel,
      action,
      to,
      handledBy: "core",
      payload: result,
      pollResult: result,
      dryRun,
    };
  }

  if (dryRun) {
    return {
      kind: "action",
      channel,
      action,
      handledBy: "dry-run",
      payload: { ok: true, dryRun: true, channel, action },
      dryRun: true,
    };
  }

  const handled = await dispatchChannelMessageAction({
    channel,
    action,
    cfg,
    params,
    accountId: accountId ?? undefined,
    gateway,
    toolContext: input.toolContext,
    dryRun,
  });
  if (!handled) {
    throw new Error(`Message action ${action} not supported for channel ${channel}.`);
  }
  return {
    kind: "action",
    channel,
    action,
    handledBy: "plugin",
    payload: extractToolPayload(handled),
    toolResult: handled,
    dryRun,
  };
}
