import {
  normalizeOptionalString,
  normalizeOptionalStringifiedId,
} from "@openclaw/normalization-core/string-coerce";
import { uniqueValues } from "@openclaw/normalization-core/string-normalization";
import { Type, type TObject } from "typebox";
import { stripPlainTextToolCallBlocks } from "../../../packages/tool-call-repair/src/index.js";
import type { SourceReplyDeliveryMode } from "../../auto-reply/get-reply-options.types.js";
import { parseReplyDirectives } from "../../auto-reply/reply/reply-directives.js";
import { resolveReactionMessageId } from "../../channels/plugins/actions/reaction-message-id.js";
import type { ChannelMessageActionName } from "../../channels/plugins/types.public.js";
import type { AgentRuntimeMessageActionContext } from "../../gateway/message-action-turn-capability.js";
import { MessageActionDeniedError } from "../../infra/outbound/message-action-denial.js";
import { sourceDeliveryTargetsMatch } from "../../infra/outbound/source-delivery-plan.js";
import { normalizeOptionalAccountId } from "../../routing/account-id.js";
import { stripUnsupportedCitationControlMarkers } from "../../shared/text/citation-control-markers.js";
import { INTERNAL_MESSAGE_CHANNEL, normalizeMessageChannel } from "../../utils/message-channel.js";
import { extractMessagingToolSend } from "../embedded-agent-messaging-extraction.js";
import { setInternalToolSteeringAllowance } from "../runtime/internal-hooks.js";
import { readToolStringParam } from "./common.js";
import { normalizeEscapedLineBreaksForVisibleText } from "./message-tool-visible-content.js";

export function resolveSourceReplySinkDeliveryMode(
  provider: string | undefined,
  configuredMode: SourceReplyDeliveryMode | undefined,
): SourceReplyDeliveryMode | undefined {
  // Internal tool sends use the private sink; the run's final answer stays automatic.
  return normalizeMessageChannel(provider) === INTERNAL_MESSAGE_CHANNEL
    ? "message_tool_only"
    : configuredMode;
}

type MessageToolSteeringSource = {
  currentChannelProvider?: string;
  currentChannelId?: string;
  currentMessagingTarget?: string;
  currentThreadTs?: string;
  currentMessageId?: string | number;
  currentAccountId?: string;
};

function accountSelectionMatchesSource(
  requestedAccountId: string | undefined,
  sourceAccountId: string | undefined,
): boolean {
  const requested = normalizeOptionalAccountId(requestedAccountId);
  if (!requested) {
    return true;
  }
  const source = normalizeOptionalAccountId(sourceAccountId);
  return Boolean(source && requested === source);
}

function explicitChannelMatchesSource(
  args: Record<string, unknown>,
  sourceChannel: string | undefined,
): boolean {
  const requestedChannels = uniqueValues(
    [readToolStringParam(args, "provider"), readToolStringParam(args, "channel")]
      .map((channel) => normalizeMessageChannel(channel))
      .filter((channel): channel is string => Boolean(channel)),
  );
  return requestedChannels.every((channel) => channel === sourceChannel);
}

function messageTargetMatchesSource(
  target: Parameters<typeof sourceDeliveryTargetsMatch>[0],
  source: {
    channel: string;
    accountId?: string;
    targets: string[];
    threadId?: string;
  },
): boolean {
  return source.targets.some((to) =>
    sourceDeliveryTargetsMatch(target, {
      channel: source.channel,
      accountId: source.accountId,
      to,
      threadId: source.threadId,
    }),
  );
}

function explicitTargetsMatchSource(
  args: Record<string, unknown>,
  source: {
    channel: string;
    accountId?: string;
    targets: string[];
    threadId?: string;
  },
): boolean {
  const targets = uniqueValues(
    [args.target, args.to, args.channelId]
      .map((target) => normalizeOptionalStringifiedId(target))
      .filter((target): target is string => Boolean(target)),
  );
  if (targets.length === 0) {
    return true;
  }
  const sourceThreadId = normalizeOptionalString(source.threadId);
  const requestedThreadId = normalizeOptionalStringifiedId(args.threadId);
  const threadSuppressed = args.topLevel === true || args.threadId === null;
  if (threadSuppressed && sourceThreadId !== undefined) {
    return false;
  }
  if (requestedThreadId && requestedThreadId !== sourceThreadId) {
    return false;
  }
  return targets.every((to) =>
    messageTargetMatchesSource(
      {
        provider: source.channel,
        accountId:
          normalizeOptionalAccountId(readToolStringParam(args, "accountId")) ?? source.accountId,
        to,
        threadId: requestedThreadId,
        threadSuppressed,
        threadImplicit: !requestedThreadId && !threadSuppressed,
      },
      source,
    ),
  );
}

function sendCompletesInCurrentSource(
  args: Record<string, unknown>,
  source: MessageToolSteeringSource & {
    channel: string;
    targets: string[];
  },
): boolean {
  if (!explicitChannelMatchesSource(args, source.channel)) {
    return false;
  }
  if (
    !accountSelectionMatchesSource(readToolStringParam(args, "accountId"), source.currentAccountId)
  ) {
    return false;
  }
  const send = extractMessagingToolSend("message", args, {
    currentChannelId: source.currentChannelId,
    currentMessagingTarget: source.currentMessagingTarget,
    currentThreadId: source.currentThreadTs,
    currentMessageId: source.currentMessageId,
  });
  if (
    !explicitTargetsMatchSource(args, source) ||
    !send ||
    !accountSelectionMatchesSource(send.accountId, source.currentAccountId)
  ) {
    return false;
  }
  return messageTargetMatchesSource(
    {
      provider: send.provider,
      accountId: send.accountId,
      to: send.to,
      threadId: send.threadId,
      threadImplicit: send.threadImplicit,
      threadSuppressed: send.threadSuppressed,
    },
    source,
  );
}

function reactionCompletesInCurrentSource(
  args: Record<string, unknown>,
  source: MessageToolSteeringSource & {
    channel: string;
    targets: string[];
  },
): boolean {
  if (!explicitChannelMatchesSource(args, source.channel)) {
    return false;
  }
  if (
    !accountSelectionMatchesSource(readToolStringParam(args, "accountId"), source.currentAccountId)
  ) {
    return false;
  }
  const sourceMessageId = normalizeOptionalStringifiedId(source.currentMessageId);
  const reactionMessageId = normalizeOptionalStringifiedId(
    resolveReactionMessageId({ args, toolContext: source }),
  );
  if (!sourceMessageId || reactionMessageId !== sourceMessageId) {
    return false;
  }
  const sourceThreadId = normalizeOptionalString(source.currentThreadTs);
  const requestedThreadId = normalizeOptionalStringifiedId(args.threadId);
  if (args.topLevel === true || args.threadId === null) {
    return sourceThreadId === undefined && explicitTargetsMatchSource(args, source);
  }
  if (requestedThreadId && requestedThreadId !== sourceThreadId) {
    return false;
  }
  return explicitTargetsMatchSource(args, source);
}

/** Whether this invocation carries the visible reply that steering must not skip. */
export function messageToolCallCompletesBeforeSteering(params: {
  args: unknown;
  sourceReplyDeliveryMode?: SourceReplyDeliveryMode;
  currentChannelProvider?: string;
  currentChannelId?: string;
  currentMessagingTarget?: string;
  currentThreadTs?: string;
  currentMessageId?: string | number;
  currentAccountId?: string;
}): boolean {
  if (
    params.sourceReplyDeliveryMode !== "message_tool_only" ||
    !params.args ||
    typeof params.args !== "object" ||
    Array.isArray(params.args)
  ) {
    return false;
  }
  if (!("action" in params.args)) {
    return false;
  }
  const action = params.args.action;
  const final = "final" in params.args ? params.args.final : undefined;
  const emoji = "emoji" in params.args ? params.args.emoji : undefined;
  const remove = "remove" in params.args ? params.args.remove : undefined;
  if (action !== "send" && action !== "react") {
    return false;
  }
  const sourceChannel = normalizeMessageChannel(params.currentChannelProvider);
  const sourceTargets = uniqueValues(
    [params.currentMessagingTarget, params.currentChannelId]
      .map((target) => normalizeOptionalString(target))
      .filter((target): target is string => Boolean(target)),
  );
  if (!sourceChannel || sourceTargets.length === 0) {
    return false;
  }
  const source = {
    ...params,
    channel: sourceChannel,
    threadId: normalizeOptionalString(params.currentThreadTs),
    targets: sourceTargets,
  };
  if (action === "send") {
    return final !== false && sendCompletesInCurrentSource(params.args, source);
  }
  return (
    final === true &&
    remove !== true &&
    Boolean(normalizeOptionalString(emoji)) &&
    reactionCompletesInCurrentSource(params.args, source)
  );
}

export function installMessageToolSteeringAllowance<T extends object>(
  tool: T,
  params: MessageToolSteeringSource & {
    accountId?: string;
    sourceReplyDeliveryMode?: SourceReplyDeliveryMode;
  },
): T {
  const { accountId, ...source } = params;
  setInternalToolSteeringAllowance(tool, (args) =>
    messageToolCallCompletesBeforeSteering({
      ...source,
      args,
      currentAccountId: source.currentAccountId ?? accountId,
    }),
  );
  return tool;
}

function sourceReplyPolicyError(message: string): MessageActionDeniedError {
  return new MessageActionDeniedError(
    message,
    "message_source_reply_policy_denied",
    "message-source-reply:current-conversation",
  );
}
// Arguments a source-bound completion reply may carry; anything else could retarget it.
const SOURCE_REPLY_ONLY_ARG_NAMES = new Set([
  "action",
  "channel",
  "target",
  "accountId",
  "message",
  "replyTo",
  "threadId",
  "to",
  "channelId",
  "final",
]);
const SOURCE_REPLY_FINAL_PROPERTY = Type.Optional(
  Type.Boolean({
    description:
      "For source replies, set false for progress; set true, or omit, for a completed send. For react, set true when adding a reaction to the current source message is your complete response; omit or set false when more work follows. A confirmed final source reply ends the turn.",
  }),
);

export function addSourceReplyFinalControl(schema: TObject): TObject {
  return Type.Object({ ...schema.properties, final: SOURCE_REPLY_FINAL_PROPERTY });
}

export function enforceSourceReplyOnlyTextDirectives(args: Record<string, unknown>): void {
  if (typeof args.message !== "string" || !args.message.trim()) {
    throw sourceReplyPolicyError("Completion source replies require non-empty visible text.");
  }
  // Use the outbound owner's parser: sanitization can assemble directives that
  // change routes, attach local files, or deliver audio.
  const message = normalizeEscapedLineBreaksForVisibleText(args.message);
  const withoutCitationMarkers = stripUnsupportedCitationControlMarkers(message);
  for (const normalized of new Set([
    message,
    withoutCitationMarkers,
    stripPlainTextToolCallBlocks(withoutCitationMarkers),
  ])) {
    const directives = parseReplyDirectives(normalized, { extractMarkdownImages: true });
    if (directives.replyToTag || directives.audioAsVoice || directives.mediaUrls?.length) {
      throw sourceReplyPolicyError("Completion source replies cannot contain non-text directives.");
    }
  }
}

// A live channel turn grants delegated use of that provider account, not a
// model-selected sibling account. Keep cross-provider and source-less routing intact.
export function enforceTrustedTurnExplicitAccount(params: {
  explicitAccountId?: string;
  selectedChannels: Array<string | undefined>;
  trustedCurrentChannel?: string;
  trustedRequesterAccountId?: string;
  hasTrustedTurnContext: boolean;
}): void {
  if (!params.explicitAccountId || !params.hasTrustedTurnContext) {
    return;
  }
  const trustedCurrentChannel = normalizeMessageChannel(params.trustedCurrentChannel);
  if (!trustedCurrentChannel) {
    throw new MessageActionDeniedError(
      "Trusted current account is missing its channel identity.",
      "message_trusted_account_context_missing",
      "message-account:trusted-turn",
    );
  }
  const includesTrustedCurrentChannel = params.selectedChannels.some(
    (channel) => normalizeMessageChannel(channel) === trustedCurrentChannel,
  );
  if (!includesTrustedCurrentChannel) {
    return;
  }
  if (normalizeOptionalAccountId(params.trustedRequesterAccountId) !== params.explicitAccountId) {
    throw new MessageActionDeniedError(
      "Explicit account does not match the trusted current account.",
      "message_account_mismatch",
      "message-account:trusted-turn",
    );
  }
}

export function enforceSourceReplyOnlyMessageAction(params: {
  action: ChannelMessageActionName;
  args: Record<string, unknown>;
  currentChannelProvider?: string;
  currentChannelId?: string;
  currentMessagingTarget?: string;
  currentThreadTs?: string;
  currentMessageId?: string | number;
  currentAccountId?: string;
  trustedTurnContext?: AgentRuntimeMessageActionContext;
}): void {
  if (params.action !== "send") {
    throw sourceReplyPolicyError(
      `Completion source replies permit only action "send", not "${params.action}".`,
    );
  }
  for (const name of Object.keys(params.args)) {
    if (!SOURCE_REPLY_ONLY_ARG_NAMES.has(name)) {
      throw sourceReplyPolicyError(`Completion source replies cannot use the "${name}" argument.`);
    }
  }
  enforceSourceReplyOnlyTextDirectives(params.args);

  const sourceContext = params.trustedTurnContext?.toolContext ?? params;
  const sourceChannel = normalizeMessageChannel(sourceContext.currentChannelProvider);
  const sourceTargets = uniqueValues(
    [sourceContext.currentMessagingTarget, sourceContext.currentChannelId]
      .map((target) => normalizeOptionalString(target))
      .filter((target): target is string => Boolean(target)),
  );
  if (!sourceChannel || sourceTargets.length === 0) {
    throw sourceReplyPolicyError(
      "Completion source replies require an authoritative current conversation.",
    );
  }

  const requestedChannel = readToolStringParam(params.args, "channel");
  if (requestedChannel && normalizeMessageChannel(requestedChannel) !== sourceChannel) {
    throw sourceReplyPolicyError("Completion source replies cannot target another channel.");
  }

  const requestedAccountId = readToolStringParam(params.args, "accountId");
  const sourceAccountId = params.trustedTurnContext
    ? params.trustedTurnContext.requesterAccountId
    : params.currentAccountId;
  if (
    requestedAccountId &&
    normalizeOptionalAccountId(requestedAccountId) !== normalizeOptionalAccountId(sourceAccountId)
  ) {
    throw sourceReplyPolicyError("Completion source replies cannot use another channel account.");
  }

  const sourceThreadId = normalizeOptionalString(sourceContext.currentThreadTs);
  const requestedThreadId = normalizeOptionalStringifiedId(params.args.threadId);
  if (requestedThreadId && requestedThreadId !== sourceThreadId) {
    throw sourceReplyPolicyError("Completion source replies cannot target another thread.");
  }

  const requestedReplyTo = readToolStringParam(params.args, "replyTo");
  const sourceMessageId = normalizeOptionalStringifiedId(sourceContext.currentMessageId);
  if (
    requestedReplyTo &&
    requestedReplyTo !== sourceMessageId &&
    requestedReplyTo !== sourceThreadId
  ) {
    throw sourceReplyPolicyError(
      "Completion source replies cannot reply outside the current thread.",
    );
  }

  const explicitTargets = uniqueValues(
    [params.args.target, params.args.to, params.args.channelId]
      .map((target) => normalizeOptionalStringifiedId(target))
      .filter((target): target is string => Boolean(target)),
  );
  for (const requestedTarget of explicitTargets) {
    if (
      !sourceTargets.some((sourceTarget) =>
        sourceDeliveryTargetsMatch(
          {
            provider: sourceChannel,
            accountId: sourceAccountId,
            to: requestedTarget,
            threadImplicit: true,
          },
          {
            channel: sourceChannel,
            accountId: sourceAccountId,
            to: sourceTarget,
            threadId: sourceThreadId,
          },
        ),
      )
    ) {
      throw sourceReplyPolicyError(
        "Completion source replies cannot target another conversation or thread.",
      );
    }
  }
}
