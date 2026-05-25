// Shared inbound parsing helpers for channel plugins.
import {
  buildChannelInboundEventContext,
  buildChannelTurnContext,
  finalizeChannelInboundContext,
  filterChannelInboundQuoteContext,
  filterChannelInboundSupplementalContext,
  resolveChannelInboundSupplementalContext,
  type BuildChannelInboundEventContextAsyncParams,
  type BuildChannelInboundEventContextParams,
  type BuildChannelTurnContextAsyncParams,
  type BuildChannelTurnContextParams,
  type BuiltChannelInboundEventContext,
  type BuiltChannelTurnContext,
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
  dispatchInboundDirectDmWithRuntime,
  type DirectDmPreCryptoGuardPolicy,
  type DirectDmPreCryptoGuardPolicyOverrides,
} from "./direct-dm.js";
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
export type { NormalizedLocation } from "../channels/location.js";
export { formatLocationText, toLocationContext } from "../channels/location.js";
export { logInboundDrop } from "../channels/logging.js";
export { resolveInboundSessionEnvelopeContext } from "../channels/session-envelope.js";
export {
  classifyChannelInboundEvent,
  resolveUnmentionedGroupInboundPolicy,
} from "../channels/inbound-event/classification.js";
export type { ClassifyChannelInboundEventParams } from "../channels/inbound-event/classification.js";
export {
  buildChannelInboundEventContext,
  buildChannelTurnContext,
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
  BuildChannelTurnContextAsyncParams,
  BuildChannelTurnContextParams,
  BuiltChannelInboundEventContext,
  BuiltChannelTurnContext,
  ChannelInboundSupplementalResolutionOptions,
  FinalizeChannelInboundContextAsyncParams,
  FinalizeChannelInboundContextParams,
  FinalizeChannelInboundContextResult,
};

/**
 * @deprecated Prefer `filterChannelInboundSupplementalContext`, or
 * `filterChannelInboundQuoteContext` for quote-only checks.
 */
export const filterChannelTurnSupplementalContext = filterChannelInboundSupplementalContext;

export {
  toHistoryMediaEntries,
  toInboundMediaFacts,
  buildChannelInboundMediaPayload,
  buildChannelInboundMediaPayload as buildChannelTurnMediaPayload,
} from "../channels/inbound-event/media.js";
export type {
  ChannelInboundMediaInput,
  ChannelInboundMediaInput as ChannelTurnMediaInput,
  ChannelInboundMediaPayload,
  ChannelInboundMediaPayload as ChannelTurnMediaPayload,
} from "../channels/inbound-event/media.js";
export type {
  CommandFacts,
  InboundMediaFacts,
  SupplementalContextFacts,
} from "../channels/turn/types.js";
export type {
  InboundEventKind,
  InboundEventKind as InboundTurnKind,
} from "../channels/inbound-event/kind.js";
export {
  createCommandTurnContext,
  isAuthorizedTextSlashCommandTurn,
  isExplicitCommandTurn,
  isNativeCommandTurn,
  isTextSlashCommandTurn,
} from "../auto-reply/command-turn-context.js";
export type { CommandTurnContext } from "../auto-reply/command-turn-context.js";
export { mergeInboundPathRoots } from "../media/inbound-path-policy.js";
