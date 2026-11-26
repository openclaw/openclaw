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

/** Message-tool booleans whose unset default is false; a false value is a no-op. */
const SOURCE_REPLY_INERT_FALSE_ARG_NAMES = new Set([
  "dryRun",
  "silent",
  "asVoice",
  "audioAsVoice",
  "asVideoNote",
  "forceDocument",
  "asDocument",
  "gifPlayback",
  "disabled",
  "reusable",
  "remove",
  "trackToolCalls",
  "track_tool_calls",
  "fromMe",
  "includeArchived",
  "includeMembers",
  "members",
]);

/** Message-tool booleans whose unset default is true; a true value is a no-op. */
const SOURCE_REPLY_INERT_TRUE_ARG_NAMES = new Set(["bestEffort"]);

/** Bound model-supplied nesting so a deep value cannot exhaust the call stack. */
const SOURCE_REPLY_INERT_MAX_DEPTH = 16;

/**
 * True when an argument value carries no content or behavior a source reply
 * could act on: `undefined`, `null`, `""`, `false`, an empty array, or a plain
 * object whose own enumerable values are all inert (recursively). Numbers stay
 * non-inert because a zero can be a meaningful control (for example a timeout).
 *
 * A completion send is already pinned to `action: "send"` and the authoritative
 * current conversation, so these values do not select a destination or change
 * delivery intent. Strict-schema models emit the full optional parameter set
 * (`targets: []`, `channelIds: []`, `dryRun: false`,
 * `presentation: { title: "", blocks: [] }`); rejecting those provably inert
 * values made the model retry the identical call until the turn died as
 * `repeated_tool_error`. The enforcement below removes accepted inert keys from
 * the dispatch copy because some consumers treat presence as intent. Content-
 * bearing values remain non-inert and fail closed.
 */
export function isInertSourceReplyArgumentValue(value: unknown, depth = 0): boolean {
  if (depth > SOURCE_REPLY_INERT_MAX_DEPTH) {
    // Fail closed: an unexpectedly deep value is not proven inert.
    return false;
  }
  if (value === undefined || value === null || value === false || value === "") {
    return true;
  }
  if (Array.isArray(value)) {
    return value.length === 0;
  }
  if (typeof value !== "object") {
    // `true`, non-empty strings, functions, symbols, and bigints.
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    // Class instances (Date, Map, Error, ...) may carry behavior or hidden state.
    return false;
  }
  return Object.values(value).every((entry) => isInertSourceReplyArgumentValue(entry, depth + 1));
}

/**
 * Name-aware inertness. A bare `false` is only a no-op for flags that default to
 * false; `bestEffort: false` is a meaningful durable-delivery request, while
 * `bestEffort: true` is the default. Unknown flags with a non-default value stay
 * meaningful and fail closed.
 */
export function isInertSourceReplyArgument(name: string, value: unknown): boolean {
  if (value === true) {
    return SOURCE_REPLY_INERT_TRUE_ARG_NAMES.has(name);
  }
  if (value === false) {
    return SOURCE_REPLY_INERT_FALSE_ARG_NAMES.has(name);
  }
  return isInertSourceReplyArgumentValue(value);
}

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

/**
 * Enforces the source-reply contract and normalizes the dispatch arguments.
 *
 * `params.args` must be the tool's shallow dispatch copy: accepted inert
 * non-allowlisted keys are deleted from it so presence alone cannot change
 * downstream behavior. Never pass the model event arguments by reference.
 */
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
    if (SOURCE_REPLY_ONLY_ARG_NAMES.has(name)) {
      continue;
    }
    if (!isInertSourceReplyArgument(name, params.args[name])) {
      throw sourceReplyPolicyError(`Completion source replies cannot use the "${name}" argument.`);
    }
    // `params.args` is the tool's shallow dispatch copy, not the model event.
    // Drop the inert key instead of only tolerating it: downstream consumers
    // treat presence as intent (an own `targets: []` suppresses implicit
    // current-conversation routing and fails the send).
    delete params.args[name];
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
