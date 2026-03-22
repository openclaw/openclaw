// Shared inbound parsing helpers for channel plugins.
export {
  createInboundDebouncer,
  resolveInboundDebounceMs,
} from "../auto-reply/inbound-debounce.js";
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
  MentionGateParams,
  MentionGateResult,
  MentionGateWithBypassParams,
  MentionGateWithBypassResult,
} from "../channels/mention-gating.js";
export {
  resolveMentionGating,
  resolveMentionGatingWithBypass,
} from "../channels/mention-gating.js";
export type { NormalizedLocation } from "../channels/location.js";
export { formatLocationText, toLocationContext } from "../channels/location.js";
export { logInboundDrop } from "../channels/logging.js";
export { resolveInboundSessionEnvelopeContext } from "../channels/session-envelope.js";
