// Shared inbound parsing helpers for channel plugins.
import {
  buildChannelInboundEventContext,
  finalizeChannelInboundContext,
  filterChannelInboundQuoteContext,
  filterChannelInboundSupplementalContext,
  resolveChannelInboundSupplementalContext,
  type BuildChannelInboundEventContextAsyncParams,
  type BuildChannelInboundEventContextParams,
  type BuiltChannelInboundEventContext,
  type ChannelInboundSupplementalResolutionOptions,
  type FinalizeChannelInboundContextAsyncParams,
  type FinalizeChannelInboundContextParams,
  type FinalizeChannelInboundContextResult,
} from "../channels/inbound-event/context.js";

export {
  createInboundDebouncer,
  resolveInboundDebounceMs,
} from "../auto-reply/inbound-debounce.js";
export {
  createDirectDmPreCryptoGuardPolicy,
  createPreCryptoDirectDmAuthorizer,
  dispatchInboundDirectDmWithRuntime,
  resolveInboundDirectDmAccessWithRuntime,
  type AccessGroupMembershipResolver,
  type DirectDmCommandAuthorizationRuntime,
  type DirectDmPreCryptoGuardPolicy,
  type DirectDmPreCryptoGuardPolicyOverrides,
  type ResolvedInboundDirectDmAccess,
} from "../channels/direct-dm.js";
export {
  formatInboundEnvelope,
  formatInboundFromLabel,
  resolveEnvelopeFormatOptions,
} from "../auto-reply/envelope.js";
export type { EnvelopeFormatOptions } from "../auto-reply/envelope.js";
export {
  buildMentionRegexes,
  matchesMentionPatterns,
  matchesMentionWithExplicit,
  normalizeMentionText,
} from "../auto-reply/reply/mentions.js";
export {
  createChannelInboundDebouncer,
  shouldDebounceTextInbound,
} from "../channels/inbound-debounce-policy.js";
export type {
  InboundMentionFacts,
  InboundMentionPolicy,
  InboundImplicitMentionKind,
  InboundMentionDecision,
  MentionGateParams,
  MentionGateResult,
  MentionGateWithBypassParams,
  MentionGateWithBypassResult,
  ResolveInboundMentionDecisionFlatParams,
  ResolveInboundMentionDecisionNestedParams,
  ResolveInboundMentionDecisionParams,
} from "../channels/mention-gating.js";
export {
  implicitMentionKindWhen,
  resolveInboundMentionDecision,
  // @deprecated Prefer `resolveInboundMentionDecision({ facts, policy })`.
  resolveMentionGating,
  // @deprecated Prefer `resolveInboundMentionDecision({ facts, policy })`.
  resolveMentionGatingWithBypass,
} from "../channels/mention-gating.js";
export type { LocationSource, NormalizedLocation } from "../channels/location.js";
export { formatLocationText, toLocationContext } from "../channels/location.js";
export type { LogFn } from "../channels/logging.js";
export { logInboundDrop } from "../channels/logging.js";
export { resolveInboundSessionEnvelopeContext } from "../channels/session-envelope.js";
export {
  classifyChannelInboundEvent,
  resolveUnmentionedGroupInboundPolicy,
} from "../channels/inbound-event/classification.js";
export type { ClassifyChannelInboundEventParams } from "../channels/inbound-event/classification.js";
export {
  buildChannelInboundEventContext,
  // @deprecated Prefer `buildChannelInboundEventContext`.
  finalizeChannelInboundContext,
  filterChannelInboundQuoteContext,
  filterChannelInboundSupplementalContext,
  // @deprecated Prefer `buildChannelInboundEventContext({ resolveSupplementalMedia: true })`.
  resolveChannelInboundSupplementalContext,
};
export type {
  BuildChannelInboundEventContextAsyncParams,
  BuildChannelInboundEventContextParams,
  BuiltChannelInboundEventContext,
  ChannelInboundSupplementalResolutionOptions,
  FinalizeChannelInboundContextAsyncParams,
  FinalizeChannelInboundContextParams,
  FinalizeChannelInboundContextResult,
};
export {
  runChannelInboundEvent,
  runPreparedInboundReply,
  dispatchChannelInboundReply,
  recordDroppedChannelInboundHistory,
  dispatchReplyFromConfigWithSettledDispatcher,
  hasFinalInboundReplyDispatch,
  hasVisibleInboundReplyDispatch,
  recordChannelBotPairLoopAndCheckSuppression,
  resolveInboundReplyDispatchCounts,
} from "./inbound-reply-dispatch.js";
export type {
  AssembledInboundReply,
  ChannelBotLoopProtectionFacts,
  ChannelInboundEventRunnerParams,
  ChannelInboundDroppedHistoryOptions,
  PreparedInboundReply,
  InboundReplyDispatchResult,
  InboundReplyRecordOptions,
} from "./inbound-reply-dispatch.js";

export {
  toHistoryMediaEntries,
  toInboundMediaFacts,
  buildChannelInboundMediaPayload,
} from "../channels/inbound-event/media.js";
export type {
  ChannelInboundMediaInput,
  ChannelInboundMediaPayload,
} from "../channels/inbound-event/media.js";
export type {
  CommandFacts,
  InboundMediaFacts,
  SupplementalContextFacts,
} from "../channels/turn/types.js";
export type { InboundEventKind } from "../channels/inbound-event/kind.js";
export {
  createCommandTurnContext,
  isAuthorizedTextSlashCommandTurn,
  isExplicitCommandTurn,
  isNativeCommandTurn,
  isTextSlashCommandTurn,
} from "../auto-reply/command-turn-context.js";
export type { CommandTurnContext } from "../auto-reply/command-turn-context.js";
export { mergeInboundPathRoots } from "../media/inbound-path-policy.js";
