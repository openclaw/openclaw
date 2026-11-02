import {
  normalizeOptionalString,
  normalizeOptionalStringifiedId,
} from "@openclaw/normalization-core/string-coerce";
import { uniqueValues } from "@openclaw/normalization-core/string-normalization";
import { stripPlainTextToolCallBlocks } from "../../../packages/tool-call-repair/src/index.js";
import type { SourceReplyDeliveryMode } from "../../auto-reply/get-reply-options.types.js";
import type { AgentRuntimeMessageActionContext } from "../../gateway/message-action-turn-capability.js";
import { MessageActionDeniedError } from "../../infra/outbound/message-action-denial.js";
import { sourceDeliveryTargetsMatch } from "../../infra/outbound/source-delivery-plan.js";
import { normalizeOptionalAccountId } from "../../routing/account-id.js";
import { stripUnsupportedCitationControlMarkers } from "../../shared/text/citation-control-markers.js";
import { parseInlineDirectives } from "../../utils/directive-tags.js";
import { INTERNAL_MESSAGE_CHANNEL, normalizeMessageChannel } from "../../utils/message-channel.js";
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

function sourceReplyPolicyError(message: string): MessageActionDeniedError {
  return new MessageActionDeniedError(
    message,
    "message_source_reply_policy_denied",
    "message-source-reply:current-conversation",
  );
}
// Content uses normal outbound validation; routing stays bound to the source.
const SOURCE_REPLY_ONLY_ARG_NAMES = new Set([
  "action",
  "channel",
  "target",
  "accountId",
  "message",
  "caption",
  "media",
  "attachments",
  "filename",
  "contentType",
  "mimeType",
  "replyTo",
  "threadId",
  "to",
  "channelId",
  "final",
]);

export function enforceSourceReplyOnlyTextDirectives(args: Record<string, unknown>): void {
  // Preserve Markdown indentation when checking sanitizer-assembled reply/audio directives.
  const text = readToolStringParam(args, "message", { trim: false });
  const caption = readToolStringParam(args, "caption", { trim: false }) ?? "";
  const message = normalizeEscapedLineBreaksForVisibleText(text?.trim() ? text : caption);
  const withoutCitationMarkers = stripUnsupportedCitationControlMarkers(message);
  for (const normalized of new Set([
    message,
    withoutCitationMarkers,
    stripPlainTextToolCallBlocks(withoutCitationMarkers),
  ])) {
    // Match outbound preparation before media extraction can hide reply/audio tags in URLs.
    const directives = parseInlineDirectives(normalized);
    if (directives.hasReplyTag || directives.audioAsVoice) {
      throw sourceReplyPolicyError("Completion source replies cannot use reply/audio directives.");
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
  action: string;
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
