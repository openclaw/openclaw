import fs from "node:fs";
import path from "node:path";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import {
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
  resolveSessionAgentId,
} from "../../agents/agent-scope.js";
import {
  readNumberParam,
  readStringArrayParam,
  readStringParam,
} from "../../agents/tools/common.js";
import { parseReplyDirectives } from "../../auto-reply/reply/reply-directives.js";
import { getChannelPlugin } from "../../channels/plugins/index.js";
import { dispatchChannelMessageAction } from "../../channels/plugins/message-action-dispatch.js";
import type {
  ChannelId,
  ChannelMessageActionName,
  ChannelThreadingToolContext,
} from "../../channels/plugins/types.js";
import type { OpenClawConfig } from "../../config/config.js";
import { hasInteractiveReplyBlocks, hasReplyPayloadContent } from "../../interactive/payload.js";
import { getAgentScopedMediaLocalRoots } from "../../media/local-roots.js";
import { hasPollCreationParams, resolveTelegramPollVisibility } from "../../poll-params.js";
import { resolvePollMaxSelections } from "../../polls.js";
import { buildChannelAccountBindings } from "../../routing/bindings.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import {
  isDeliverableMessageChannel,
  normalizeMessageChannel,
  type GatewayClientMode,
  type GatewayClientName,
} from "../../utils/message-channel.js";
import { throwIfAborted } from "./abort.js";
import { resolveOutboundChannelPlugin } from "./channel-resolution.js";
import {
  listConfiguredMessageChannels,
  resolveMessageChannelSelection,
} from "./channel-selection.js";
import type { OutboundSendDeps } from "./deliver.js";
import { normalizeMessageActionInput } from "./message-action-normalization.js";
import {
  hydrateAttachmentParamsForAction,
  normalizeSandboxMediaList,
  normalizeSandboxMediaParams,
  parseButtonsParam,
  parseCardParam,
  parseComponentsParam,
  parseInteractiveParam,
  readBooleanParam,
  resolveAttachmentMediaPolicy,
} from "./message-action-params.js";
import { actionRequiresTarget } from "./message-action-spec.js";
import type { MessagePollResult, MessageSendResult } from "./message.js";
import {
  applyCrossContextDecoration,
  buildCrossContextDecoration,
  type CrossContextDecoration,
  enforceCrossContextPolicy,
  shouldApplyCrossContextMarker,
} from "./outbound-policy.js";
import { executePollAction, executeSendAction } from "./outbound-send-service.js";
import { ensureOutboundSessionEntry, resolveOutboundSessionRoute } from "./outbound-session.js";
import { resolveChannelTarget, type ResolvedMessagingTarget } from "./target-resolver.js";
import { extractToolPayload } from "./tool-payload.js";

export type MessageActionRunnerGateway = {
  url?: string;
  token?: string;
  timeoutMs?: number;
  clientName: GatewayClientName;
  clientDisplayName?: string;
  mode: GatewayClientMode;
};

function resolveAndApplyOutboundThreadId(
  params: Record<string, unknown>,
  ctx: {
    cfg: OpenClawConfig;
    channel: ChannelId;
    to: string;
    accountId?: string | null;
    toolContext?: ChannelThreadingToolContext;
  },
): string | undefined {
  const threadId = readStringParam(params, "threadId");
  const resolved =
    threadId ??
    getChannelPlugin(ctx.channel)?.threading?.resolveAutoThreadId?.({
      cfg: ctx.cfg,
      accountId: ctx.accountId,
      to: ctx.to,
      toolContext: ctx.toolContext,
      replyToId: readStringParam(params, "replyTo"),
    });
  // Write auto-resolved threadId back into params so downstream dispatch
  // (plugin `readStringParam(params, "threadId")`) picks it up.
  if (resolved && !params.threadId) {
    params.threadId = resolved;
  }
  return resolved ?? undefined;
}

export type RunMessageActionParams = {
  cfg: OpenClawConfig;
  action: ChannelMessageActionName;
  params: Record<string, unknown>;
  defaultAccountId?: string;
  requesterSenderId?: string | null;
  sessionId?: string;
  toolContext?: ChannelThreadingToolContext;
  gateway?: MessageActionRunnerGateway;
  deps?: OutboundSendDeps;
  sessionKey?: string;
  agentId?: string;
  sandboxRoot?: string;
  dryRun?: boolean;
  abortSignal?: AbortSignal;
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

export function getToolResult(
  result: MessageActionRunResult,
): AgentToolResult<unknown> | undefined {
  return "toolResult" in result ? result.toolResult : undefined;
}

function readTrimmedTargetsParam(params: Record<string, unknown>): string[] {
  const raw = params.targets;
  if (!Array.isArray(raw)) {
    return [];
  }
  const targets: string[] = [];
  for (const value of raw) {
    if (typeof value !== "string") {
      continue;
    }
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      targets.push(trimmed);
    }
  }
  return targets;
}

const PHONE_NORMALIZED_MEMBER_CHANNELS = new Set(["imessage", "whatsapp", "signal", "bluebubbles"]);

function parsePrefixedRoutingMemberHandle(value: string): {
  normalizedChannel?: string;
  handle: string;
} {
  const trimmed = value.trim();
  if (!trimmed) {
    return { handle: "" };
  }
  const delimiter = trimmed.indexOf(":");
  if (delimiter <= 0) {
    return { handle: trimmed };
  }
  const prefix = trimmed.slice(0, delimiter).trim();
  const suffix = trimmed.slice(delimiter + 1).trim();
  if (!suffix) {
    return { handle: trimmed };
  }
  const normalizedChannel = normalizeMessageChannel(prefix);
  if (!normalizedChannel || !isDeliverableMessageChannel(normalizedChannel)) {
    return { handle: trimmed };
  }
  return { normalizedChannel, handle: suffix };
}

function normalizeRoutingHandle(value: string): string {
  const { normalizedChannel, handle } = parsePrefixedRoutingMemberHandle(value);
  const trimmed = handle.trim();
  if (!trimmed) {
    return "";
  }
  const lower = trimmed.toLowerCase();
  if (lower.includes("@")) {
    return lower;
  }
  if (normalizedChannel && !PHONE_NORMALIZED_MEMBER_CHANNELS.has(normalizedChannel)) {
    // Preserve opaque IDs for non-phone channels (for example slack:U123 / discord:123).
    return lower;
  }
  // Preserve opaque alphanumeric handles (e.g., Slack/Discord IDs) to avoid
  // collisions like C123... vs U123... when matching group member sets.
  if (/[a-z]/i.test(trimmed)) {
    return lower;
  }
  const digits = lower.replace(/\D/g, "");
  if (!digits) {
    return lower;
  }
  if (digits.length === 11 && digits.startsWith("1")) {
    return `+${digits}`;
  }
  return digits.length >= 10 ? `+${digits}` : digits;
}

function resolveKnownGroupTargetFromRoutingMap(params: {
  workspace?: string;
  channelHint?: string;
  targets: string[];
}): { channel: string; target: string } | undefined {
  const workspace = params.workspace?.trim();
  if (!workspace) {
    return undefined;
  }
  const routingTargetsPath = path.join(workspace, "memory", "routing-targets.json");
  if (!fs.existsSync(routingTargetsPath)) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(routingTargetsPath, "utf8"));
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") {
    return undefined;
  }
  const groups = (parsed as { groups?: unknown }).groups;
  if (!groups || typeof groups !== "object") {
    return undefined;
  }
  const requested = new Set(
    params.targets.map(normalizeRoutingHandle).filter((value) => value.length > 0),
  );
  if (requested.size < 2) {
    return undefined;
  }
  for (const group of Object.values(groups as Record<string, unknown>)) {
    if (!group || typeof group !== "object") {
      continue;
    }
    const record = group as {
      member_handles?: unknown;
      channels?: unknown;
      chat_guid?: unknown;
    };
    const memberHandlesRaw = Array.isArray(record.member_handles)
      ? record.member_handles
      : Array.isArray((group as { members?: unknown }).members)
        ? ((group as { members?: unknown }).members as unknown[])
        : [];
    const memberHandles = new Set(
      memberHandlesRaw
        .filter((value): value is string => typeof value === "string")
        .map(normalizeRoutingHandle)
        .filter((value) => value.length > 0),
    );
    if (memberHandles.size === 0) {
      continue;
    }
    if (memberHandles.size !== requested.size) {
      continue;
    }
    const matchesExactTargets = Array.from(requested).every((handle) => memberHandles.has(handle));
    if (!matchesExactTargets) {
      continue;
    }
    const channels =
      record.channels && typeof record.channels === "object"
        ? (record.channels as Record<string, unknown>)
        : {};
    const channelHint = params.channelHint?.trim().toLowerCase();
    const hintedTarget =
      channelHint && typeof channels[channelHint] === "string" ? channels[channelHint].trim() : "";
    if (hintedTarget) {
      return { channel: channelHint!, target: hintedTarget };
    }
    if (channelHint && channelHint !== "bluebubbles") {
      // Preserve explicit non-BlueBubbles channel intent. If the mapped group lacks this channel,
      // keep searching for another exact group match instead of silently rerouting.
      // BlueBubbles still supports chat_guid legacy entries without channels.bluebubbles.
      continue;
    }
    const bluebubblesTarget =
      typeof channels.bluebubbles === "string" ? channels.bluebubbles.trim() : "";
    if (bluebubblesTarget) {
      return { channel: "bluebubbles", target: bluebubblesTarget };
    }
    const chatGuid = typeof record.chat_guid === "string" ? record.chat_guid.trim() : "";
    if (chatGuid) {
      const target = chatGuid.startsWith("chat_guid:") ? chatGuid : `chat_guid:${chatGuid}`;
      return { channel: "bluebubbles", target };
    }
  }
  return undefined;
}

async function normalizeTargetsParamForAction(params: {
  cfg: OpenClawConfig;
  action: ChannelMessageActionName;
  args: Record<string, unknown>;
  toolContext?: ChannelThreadingToolContext;
  routingWorkspace?: string;
}) {
  const targets = readTrimmedTargetsParam(params.args);
  if (targets.length === 0) {
    return;
  }
  if (params.action === "broadcast") {
    // Keep broadcast targets canonical and trimmed.
    params.args.targets = targets;
    return;
  }
  if (!actionRequiresTarget(params.action)) {
    throw new Error(`Action ${params.action} does not accept targets.`);
  }
  const explicitTarget = typeof params.args.target === "string" ? params.args.target.trim() : "";
  const legacyTo = typeof params.args.to === "string" ? params.args.to.trim() : "";
  const legacyChannelId =
    typeof params.args.channelId === "string" ? params.args.channelId.trim() : "";
  const primaryTarget = explicitTarget || legacyTo || legacyChannelId;
  if (targets.length > 1) {
    if (primaryTarget) {
      throw new Error(
        `Conflicting destinations provided for ${params.action}. Use either targets or a single target destination.`,
      );
    }
    const explicitChannelRaw =
      typeof params.args.channel === "string" ? params.args.channel.trim() : "";
    const normalizedChannelHint = explicitChannelRaw
      ? normalizeMessageChannel(explicitChannelRaw)
      : undefined;
    const explicitChannelHint =
      normalizedChannelHint && isDeliverableMessageChannel(normalizedChannelHint)
        ? normalizedChannelHint
        : undefined;
    if (explicitChannelRaw && !explicitChannelHint) {
      throw new Error(
        `Unknown channel "${explicitChannelRaw}" for multi-target ${params.action}. Provide a configured channel or use target for one destination.`,
      );
    }
    const normalizedToolContextChannel = normalizeMessageChannel(
      params.toolContext?.currentChannelProvider,
    );
    const toolContextChannelHint =
      normalizedToolContextChannel && isDeliverableMessageChannel(normalizedToolContextChannel)
        ? normalizedToolContextChannel
        : undefined;
    let channelHint = explicitChannelHint ?? toolContextChannelHint;
    if (!channelHint) {
      const inferred = await resolveMessageChannelSelection({
        cfg: params.cfg,
        fallbackChannel: toolContextChannelHint,
      });
      channelHint = inferred.channel;
      if (inferred.source === "tool-context-fallback") {
        params.args.channel = inferred.channel;
      }
    }
    const mappedGroup = resolveKnownGroupTargetFromRoutingMap({
      workspace: params.routingWorkspace,
      channelHint,
      targets,
    });
    if (mappedGroup) {
      params.args.channel = mappedGroup.channel;
      params.args.target = mappedGroup.target;
      delete params.args.to;
      delete params.args.channelId;
      delete params.args.targets;
      return;
    }
    throw new Error(
      `Action ${params.action} accepts a single destination. Use target for one recipient or broadcast for multiple targets.`,
    );
  }
  const onlyTarget = targets[0];
  if (primaryTarget && primaryTarget !== onlyTarget) {
    throw new Error(
      `Conflicting destinations provided for ${params.action}. Use a single target destination.`,
    );
  }
  if (!primaryTarget) {
    params.args.target = onlyTarget;
  }
  delete params.args.targets;
}

function applyCrossContextMessageDecoration({
  params,
  message,
  decoration,
  preferComponents,
}: {
  params: Record<string, unknown>;
  message: string;
  decoration: CrossContextDecoration;
  preferComponents: boolean;
}): string {
  const applied = applyCrossContextDecoration({
    message,
    decoration,
    preferComponents,
  });
  params.message = applied.message;
  if (applied.componentsBuilder) {
    params.components = applied.componentsBuilder;
  }
  return applied.message;
}

async function maybeApplyCrossContextMarker(params: {
  cfg: OpenClawConfig;
  channel: ChannelId;
  action: ChannelMessageActionName;
  target: string;
  toolContext?: ChannelThreadingToolContext;
  accountId?: string | null;
  args: Record<string, unknown>;
  message: string;
  preferComponents: boolean;
}): Promise<string> {
  if (!shouldApplyCrossContextMarker(params.action) || !params.toolContext) {
    return params.message;
  }
  const decoration = await buildCrossContextDecoration({
    cfg: params.cfg,
    channel: params.channel,
    target: params.target,
    toolContext: params.toolContext,
    accountId: params.accountId ?? undefined,
  });
  if (!decoration) {
    return params.message;
  }
  return applyCrossContextMessageDecoration({
    params: params.args,
    message: params.message,
    decoration,
    preferComponents: params.preferComponents,
  });
}

async function resolveChannel(
  cfg: OpenClawConfig,
  params: Record<string, unknown>,
  toolContext?: { currentChannelProvider?: string },
) {
  const selection = await resolveMessageChannelSelection({
    cfg,
    channel: readStringParam(params, "channel"),
    fallbackChannel: toolContext?.currentChannelProvider,
  });
  if (selection.source === "tool-context-fallback") {
    params.channel = selection.channel;
  }
  return selection.channel;
}

async function resolveActionTarget(params: {
  cfg: OpenClawConfig;
  channel: ChannelId;
  action: ChannelMessageActionName;
  args: Record<string, unknown>;
  accountId?: string | null;
}): Promise<ResolvedMessagingTarget | undefined> {
  let resolvedTarget: ResolvedMessagingTarget | undefined;
  const toRaw = typeof params.args.to === "string" ? params.args.to.trim() : "";
  if (toRaw) {
    const resolved = await resolveChannelTarget({
      cfg: params.cfg,
      channel: params.channel,
      input: toRaw,
      accountId: params.accountId ?? undefined,
    });
    if (resolved.ok) {
      params.args.to = resolved.target.to;
      resolvedTarget = resolved.target;
    } else {
      throw resolved.error;
    }
  }
  const channelIdRaw =
    typeof params.args.channelId === "string" ? params.args.channelId.trim() : "";
  if (channelIdRaw) {
    const resolved = await resolveChannelTarget({
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
  return resolvedTarget;
}

type ResolvedActionContext = {
  cfg: OpenClawConfig;
  params: Record<string, unknown>;
  channel: ChannelId;
  accountId?: string | null;
  dryRun: boolean;
  gateway?: MessageActionRunnerGateway;
  input: RunMessageActionParams;
  agentId?: string;
  resolvedTarget?: ResolvedMessagingTarget;
  abortSignal?: AbortSignal;
};
function resolveGateway(input: RunMessageActionParams): MessageActionRunnerGateway | undefined {
  if (!input.gateway) {
    return undefined;
  }
  return {
    url: input.gateway.url,
    token: input.gateway.token,
    timeoutMs: input.gateway.timeoutMs,
    clientName: input.gateway.clientName,
    clientDisplayName: input.gateway.clientDisplayName,
    mode: input.gateway.mode,
  };
}

async function handleBroadcastAction(
  input: RunMessageActionParams,
  params: Record<string, unknown>,
): Promise<MessageActionRunResult> {
  throwIfAborted(input.abortSignal);
  const broadcastEnabled = input.cfg.tools?.message?.broadcast?.enabled !== false;
  if (!broadcastEnabled) {
    throw new Error("Broadcast is disabled. Set tools.message.broadcast.enabled to true.");
  }
  const rawTargets = readStringArrayParam(params, "targets", { required: true });
  if (rawTargets.length === 0) {
    throw new Error("Broadcast requires at least one target in --targets.");
  }
  const channelHint = readStringParam(params, "channel");
  const configured = await listConfiguredMessageChannels(input.cfg);
  if (configured.length === 0) {
    throw new Error("Broadcast requires at least one configured channel.");
  }
  const targetChannels =
    channelHint && channelHint.trim().toLowerCase() !== "all"
      ? [await resolveChannel(input.cfg, { channel: channelHint }, input.toolContext)]
      : configured;
  const results: Array<{
    channel: ChannelId;
    to: string;
    ok: boolean;
    error?: string;
    result?: MessageSendResult;
  }> = [];
  const isAbortError = (err: unknown): boolean => err instanceof Error && err.name === "AbortError";
  for (const targetChannel of targetChannels) {
    throwIfAborted(input.abortSignal);
    for (const target of rawTargets) {
      throwIfAborted(input.abortSignal);
      try {
        const resolved = await resolveChannelTarget({
          cfg: input.cfg,
          channel: targetChannel,
          input: target,
        });
        if (!resolved.ok) {
          throw resolved.error;
        }
        const {
          targets: _targets,
          to: _to,
          channelId: _channelId,
          ...remainingSendParams
        } = params;
        const sendParams = {
          ...remainingSendParams,
          channel: targetChannel,
          target: resolved.target.to,
        };
        const sendResult = await runMessageAction({
          ...input,
          action: "send",
          params: sendParams,
        });
        results.push({
          channel: targetChannel,
          to: resolved.target.to,
          ok: true,
          result: sendResult.kind === "send" ? sendResult.sendResult : undefined,
        });
      } catch (err) {
        if (isAbortError(err)) {
          throw err;
        }
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
    channel: targetChannels[0] ?? "discord",
    action: "broadcast",
    handledBy: input.dryRun ? "dry-run" : "core",
    payload: { results },
    dryRun: Boolean(input.dryRun),
  };
}

async function handleSendAction(ctx: ResolvedActionContext): Promise<MessageActionRunResult> {
  const {
    cfg,
    params,
    channel,
    accountId,
    dryRun,
    gateway,
    input,
    agentId,
    resolvedTarget,
    abortSignal,
  } = ctx;
  throwIfAborted(abortSignal);
  const action: ChannelMessageActionName = "send";
  const to = readStringParam(params, "to", { required: true });
  // Support media, path, and filePath parameters for attachments
  const mediaHint =
    readStringParam(params, "media", { trim: false }) ??
    readStringParam(params, "path", { trim: false }) ??
    readStringParam(params, "filePath", { trim: false });
  const hasButtons = Array.isArray(params.buttons) && params.buttons.length > 0;
  const hasCard = params.card != null && typeof params.card === "object";
  const hasComponents = params.components != null && typeof params.components === "object";
  const hasInteractive = hasInteractiveReplyBlocks(params.interactive);
  const hasBlocks =
    (Array.isArray(params.blocks) && params.blocks.length > 0) ||
    (typeof params.blocks === "string" && params.blocks.trim().length > 0);
  const caption = readStringParam(params, "caption", { allowEmpty: true }) ?? "";
  let message =
    readStringParam(params, "message", {
      required:
        !mediaHint && !hasButtons && !hasCard && !hasComponents && !hasInteractive && !hasBlocks,
      allowEmpty: true,
    }) ?? "";
  if (message.includes("\\n")) {
    message = message.replaceAll("\\n", "\n");
  }
  if (!message.trim() && caption.trim()) {
    message = caption;
  }

  const parsed = parseReplyDirectives(message);
  const mergedMediaUrls: string[] = [];
  const seenMedia = new Set<string>();
  const pushMedia = (value?: string | null) => {
    const trimmed = value?.trim();
    if (!trimmed) {
      return;
    }
    if (seenMedia.has(trimmed)) {
      return;
    }
    seenMedia.add(trimmed);
    mergedMediaUrls.push(trimmed);
  };
  pushMedia(mediaHint);
  for (const url of parsed.mediaUrls ?? []) {
    pushMedia(url);
  }
  pushMedia(parsed.mediaUrl);

  const normalizedMediaUrls = await normalizeSandboxMediaList({
    values: mergedMediaUrls,
    sandboxRoot: input.sandboxRoot,
  });
  mergedMediaUrls.length = 0;
  mergedMediaUrls.push(...normalizedMediaUrls);

  message = parsed.text;
  params.message = message;
  if (!params.replyTo && parsed.replyToId) {
    params.replyTo = parsed.replyToId;
  }
  if (!params.media) {
    // Use path/filePath if media not set, then fall back to parsed directives
    params.media = mergedMediaUrls[0] || undefined;
  }

  message = await maybeApplyCrossContextMarker({
    cfg,
    channel,
    action,
    target: to,
    toolContext: input.toolContext,
    accountId,
    args: params,
    message,
    preferComponents: true,
  });

  const mediaUrl = readStringParam(params, "media", { trim: false });
  if (channel === "whatsapp") {
    message = message.replace(/^(?:[ \t]*\r?\n)+/, "");
    if (!message.trim()) {
      message = "";
    }
  }
  if (
    !hasReplyPayloadContent(
      {
        text: message,
        mediaUrl,
        mediaUrls: mergedMediaUrls,
        interactive: params.interactive,
      },
      {
        extraContent: hasButtons || hasCard || hasComponents || hasBlocks,
      },
    )
  ) {
    throw new Error("send requires text or media");
  }
  params.message = message;
  const gifPlayback = readBooleanParam(params, "gifPlayback") ?? false;
  const forceDocument = readBooleanParam(params, "forceDocument") ?? false;
  const bestEffort = readBooleanParam(params, "bestEffort");
  const silent = readBooleanParam(params, "silent");

  const replyToId = readStringParam(params, "replyTo");
  const resolvedThreadId = resolveAndApplyOutboundThreadId(params, {
    cfg,
    channel,
    to,
    accountId,
    toolContext: input.toolContext,
  });
  const outboundRoute =
    agentId && !dryRun
      ? await resolveOutboundSessionRoute({
          cfg,
          channel,
          agentId,
          accountId,
          target: to,
          resolvedTarget,
          replyToId,
          threadId: resolvedThreadId,
        })
      : null;
  if (outboundRoute && agentId && !dryRun) {
    await ensureOutboundSessionEntry({
      cfg,
      agentId,
      channel,
      accountId,
      route: outboundRoute,
    });
  }
  if (outboundRoute && !dryRun) {
    params.__sessionKey = outboundRoute.sessionKey;
  }
  if (agentId) {
    params.__agentId = agentId;
  }
  const mirrorMediaUrls =
    mergedMediaUrls.length > 0 ? mergedMediaUrls : mediaUrl ? [mediaUrl] : undefined;
  throwIfAborted(abortSignal);
  const send = await executeSendAction({
    ctx: {
      cfg,
      channel,
      params,
      agentId,
      accountId: accountId ?? undefined,
      gateway,
      toolContext: input.toolContext,
      deps: input.deps,
      dryRun,
      mirror:
        outboundRoute && !dryRun
          ? {
              sessionKey: outboundRoute.sessionKey,
              agentId,
              text: message,
              mediaUrls: mirrorMediaUrls,
            }
          : undefined,
      abortSignal,
      silent: silent ?? undefined,
    },
    to,
    message,
    mediaUrl: mediaUrl || undefined,
    mediaUrls: mergedMediaUrls.length ? mergedMediaUrls : undefined,
    gifPlayback,
    forceDocument,
    bestEffort: bestEffort ?? undefined,
    replyToId: replyToId ?? undefined,
    threadId: resolvedThreadId ?? undefined,
  });

  return {
    kind: "send",
    channel,
    action,
    to,
    handledBy: send.handledBy,
    payload: send.payload,
    toolResult: send.toolResult,
    sendResult: send.sendResult,
    dryRun,
  };
}

async function handlePollAction(ctx: ResolvedActionContext): Promise<MessageActionRunResult> {
  const { cfg, params, channel, accountId, dryRun, gateway, input, abortSignal } = ctx;
  throwIfAborted(abortSignal);
  const action: ChannelMessageActionName = "poll";
  const to = readStringParam(params, "to", { required: true });
  const silent = readBooleanParam(params, "silent");

  const resolvedThreadId = resolveAndApplyOutboundThreadId(params, {
    cfg,
    channel,
    to,
    accountId,
    toolContext: input.toolContext,
  });

  const base = typeof params.message === "string" ? params.message : "";
  await maybeApplyCrossContextMarker({
    cfg,
    channel,
    action,
    target: to,
    toolContext: input.toolContext,
    accountId,
    args: params,
    message: base,
    preferComponents: false,
  });

  const poll = await executePollAction({
    ctx: {
      cfg,
      channel,
      params,
      accountId: accountId ?? undefined,
      gateway,
      toolContext: input.toolContext,
      dryRun,
      silent: silent ?? undefined,
    },
    resolveCorePoll: () => {
      const question = readStringParam(params, "pollQuestion", {
        required: true,
      });
      const options = readStringArrayParam(params, "pollOption", { required: true });
      if (options.length < 2) {
        throw new Error("pollOption requires at least two values");
      }
      const allowMultiselect = readBooleanParam(params, "pollMulti") ?? false;
      const pollAnonymous = readBooleanParam(params, "pollAnonymous");
      const pollPublic = readBooleanParam(params, "pollPublic");
      const isAnonymous = resolveTelegramPollVisibility({ pollAnonymous, pollPublic });
      const durationHours = readNumberParam(params, "pollDurationHours", {
        integer: true,
        strict: true,
      });
      const durationSeconds = readNumberParam(params, "pollDurationSeconds", {
        integer: true,
        strict: true,
      });

      if (durationSeconds !== undefined && channel !== "telegram") {
        throw new Error("pollDurationSeconds is only supported for Telegram polls");
      }
      if (isAnonymous !== undefined && channel !== "telegram") {
        throw new Error("pollAnonymous/pollPublic are only supported for Telegram polls");
      }

      return {
        to,
        question,
        options,
        maxSelections: resolvePollMaxSelections(options.length, allowMultiselect),
        durationSeconds: durationSeconds ?? undefined,
        durationHours: durationHours ?? undefined,
        threadId: resolvedThreadId ?? undefined,
        isAnonymous,
      };
    },
  });

  return {
    kind: "poll",
    channel,
    action,
    to,
    handledBy: poll.handledBy,
    payload: poll.payload,
    toolResult: poll.toolResult,
    pollResult: poll.pollResult,
    dryRun,
  };
}

async function handlePluginAction(ctx: ResolvedActionContext): Promise<MessageActionRunResult> {
  const { cfg, params, channel, accountId, dryRun, gateway, input, abortSignal, agentId } = ctx;
  throwIfAborted(abortSignal);
  const action = input.action as Exclude<ChannelMessageActionName, "send" | "poll" | "broadcast">;
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

  const plugin = resolveOutboundChannelPlugin({ channel, cfg });
  if (!plugin?.actions?.handleAction) {
    throw new Error(`Channel ${channel} is unavailable for message actions (plugin not loaded).`);
  }

  const handled = await dispatchChannelMessageAction({
    channel,
    action,
    cfg,
    params,
    accountId: accountId ?? undefined,
    requesterSenderId: input.requesterSenderId ?? undefined,
    sessionKey: input.sessionKey,
    sessionId: input.sessionId,
    agentId,
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

export async function runMessageAction(
  input: RunMessageActionParams,
): Promise<MessageActionRunResult> {
  const cfg = input.cfg;
  let params = { ...input.params };
  const resolvedAgentId =
    input.agentId ??
    (input.sessionKey
      ? resolveSessionAgentId({ sessionKey: input.sessionKey, config: cfg })
      : undefined);
  parseButtonsParam(params);
  parseCardParam(params);
  parseComponentsParam(params);
  parseInteractiveParam(params);

  const action = input.action;
  const routingWorkspace = resolveAgentWorkspaceDir(
    cfg,
    resolvedAgentId ?? resolveDefaultAgentId(cfg),
  );
  await normalizeTargetsParamForAction({
    cfg,
    action,
    args: params,
    toolContext: input.toolContext,
    routingWorkspace,
  });
  if (action === "broadcast") {
    return handleBroadcastAction(input, params);
  }
  params = normalizeMessageActionInput({
    action,
    args: params,
    toolContext: input.toolContext,
  });

  const channel = await resolveChannel(cfg, params, input.toolContext);
  let accountId = readStringParam(params, "accountId") ?? input.defaultAccountId;
  if (!accountId && resolvedAgentId) {
    const byAgent = buildChannelAccountBindings(cfg).get(channel);
    const boundAccountIds = byAgent?.get(normalizeAgentId(resolvedAgentId));
    if (boundAccountIds && boundAccountIds.length > 0) {
      accountId = boundAccountIds[0];
    }
  }
  if (accountId) {
    params.accountId = accountId;
  }
  const dryRun = Boolean(input.dryRun ?? readBooleanParam(params, "dryRun"));
  const mediaLocalRoots = getAgentScopedMediaLocalRoots(cfg, resolvedAgentId);
  const mediaPolicy = resolveAttachmentMediaPolicy({
    sandboxRoot: input.sandboxRoot,
    mediaLocalRoots,
  });

  await normalizeSandboxMediaParams({
    args: params,
    mediaPolicy,
  });

  await hydrateAttachmentParamsForAction({
    cfg,
    channel,
    accountId,
    args: params,
    action,
    dryRun,
    mediaPolicy,
  });

  const resolvedTarget = await resolveActionTarget({
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

  if (action === "send" && hasPollCreationParams(params)) {
    throw new Error('Poll fields require action "poll"; use action "poll" instead of "send".');
  }

  const gateway = resolveGateway(input);

  if (action === "send") {
    return handleSendAction({
      cfg,
      params,
      channel,
      accountId,
      dryRun,
      gateway,
      input,
      agentId: resolvedAgentId,
      resolvedTarget,
      abortSignal: input.abortSignal,
    });
  }

  if (action === "poll") {
    return handlePollAction({
      cfg,
      params,
      channel,
      accountId,
      dryRun,
      gateway,
      input,
      abortSignal: input.abortSignal,
    });
  }

  return handlePluginAction({
    cfg,
    params,
    channel,
    accountId,
    dryRun,
    gateway,
    input,
    agentId: resolvedAgentId,
    abortSignal: input.abortSignal,
  });
}
