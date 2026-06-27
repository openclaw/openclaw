import type { GetReplyOptions } from "../get-reply-options.types.js";

/**
 * Conservative admission lane for obviously low-risk conversational replies.
 *
 * Eligible turns run with lightweight bootstrap context and no tools, trimming
 * per-turn setup cost for plain chat. The contract is asymmetric on purpose:
 * over-escalating to the full agent is harmless, but lightweighting a turn that
 * actually needs context, tools, or current state degrades the answer. When any
 * signal is uncertain we keep the full agent path.
 */

/** Upper bound on cleaned text length still treated as "obvious" light chat. */
export const LIGHTWEIGHT_LANE_MAX_TEXT_LENGTH = 600;

export type LightweightLaneIneligibleReason =
  | "empty_or_long"
  | "media"
  | "link"
  | "native_command"
  | "slash_command"
  | "reply_target_dependency"
  | "not_obvious_small_talk"
  | "action_intent"
  | "code_or_repo"
  | "system_or_config"
  | "high_stakes";

export type LightweightLaneDecision =
  | { eligible: true }
  | { eligible: false; reason: LightweightLaneIneligibleReason };

export type LightweightLaneSignals = {
  /** Cleaned user text for the turn (no history/sender envelope). */
  text: string | undefined;
  /** Inbound attachments/stickers/media present on the turn. */
  hasMedia: boolean;
  /** A URL is present in the inbound text. */
  hasLink: boolean;
  /** Turn arrived via a native (gateway) slash command. */
  isNativeCommand: boolean;
  /** Turn replies to a target whose content could not be resolved. */
  hasUnresolvedReplyTarget: boolean;
};

// Explicit tool/action verbs plus close siblings that imply work needing tools,
// state, or side effects. Word-boundary matched, so inflected casual phrasing
// ("sending good vibes") does not trip the listed bare verbs.
const ACTION_VERB_TERMS = [
  "check",
  "read",
  "run",
  "fix",
  "build",
  "search",
  "browse",
  "investigate",
  "verify",
  "deploy",
  "send",
  "schedule",
  "create",
  "edit",
  "delete",
  "restart",
  "install",
  "update",
  "upgrade",
  "execute",
  "download",
  "upload",
  "fetch",
  "approve",
  "reject",
];

const CODE_REPO_TERMS = [
  "code",
  "codebase",
  "repo",
  "repository",
  "source code",
  "function",
  "stack trace",
  "compile",
  "commit",
  "pull request",
  "git",
  "branch",
  "merge",
  "diff",
  "script",
];

const SYSTEM_CONFIG_TERMS = [
  "config",
  "configuration",
  "secret",
  "secrets",
  "credential",
  "credentials",
  "api key",
  "deploy",
  "deployment",
  "runtime",
  "gateway",
  "canonical",
  "plist",
  "launchd",
  "environment variable",
  "migration",
  "infrastructure",
];

const HIGH_STAKES_TERMS = [
  "medical",
  "medication",
  "diagnosis",
  "symptom",
  "symptoms",
  "prescription",
  "visa",
  "immigration",
  "passport",
  "financial",
  "investment",
  "mortgage",
  "lawsuit",
  "attorney",
];

const CURRENT_INFO_PATTERNS = [
  /\bwho won\b/i,
  /\blast night\b/i,
  /\b(?:latest|current|news|score|weather)\b/i,
  /\bwhat'?s happening\b/i,
];

const OBVIOUS_SMALL_TALK_PATTERNS = [
  /^(?:hi|hey|hello|good (?:morning|afternoon|evening))[!.:),\s]*$/i,
  /^(?:thanks?|thank you|cheers|appreciate it|much appreciated)(?:,?\s+that (?:really )?helped)?[!.:),\s]*$/i,
  /^(?:haha|lol|lmao|hehe)(?:\s+(?:that(?:'s| is)?|this is)?\s*(?:funny|hilarious|great))?[!.:),\s]*$/i,
  /^(?:no worries(?:,?\s+talk later)?|never mind|nevermind|all good|sounds good|talk later)[!.:),\s]*$/i,
  /^how (?:are|r) (?:you|u)(?: doing)?(?: today)?[?.!,\s]*$/i,
  /^how'?s (?:your|ur) (?:day|morning|afternoon|evening)(?: going)?[?.!,\s]*$/i,
  /^what do you think about (?:jazz|music|movies|films|books|coffee|tea|football)[?.!,\s]*$/i,
];

function buildTermMatcher(terms: readonly string[]): RegExp {
  const escaped = terms.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`\\b(?:${escaped.join("|")})\\b`, "i");
}

const ACTION_VERB_MATCHER = buildTermMatcher(ACTION_VERB_TERMS);
const CODE_REPO_MATCHER = buildTermMatcher(CODE_REPO_TERMS);
const SYSTEM_CONFIG_MATCHER = buildTermMatcher(SYSTEM_CONFIG_TERMS);
const HIGH_STAKES_MATCHER = buildTermMatcher(HIGH_STAKES_TERMS);

export function classifyLightweightLane(signals: LightweightLaneSignals): LightweightLaneDecision {
  const text = signals.text?.trim() ?? "";
  if (text.length === 0 || text.length > LIGHTWEIGHT_LANE_MAX_TEXT_LENGTH) {
    return { eligible: false, reason: "empty_or_long" };
  }
  if (signals.hasMedia) {
    return { eligible: false, reason: "media" };
  }
  if (signals.hasLink) {
    return { eligible: false, reason: "link" };
  }
  if (signals.isNativeCommand) {
    return { eligible: false, reason: "native_command" };
  }
  if (text.startsWith("/")) {
    return { eligible: false, reason: "slash_command" };
  }
  if (signals.hasUnresolvedReplyTarget) {
    return { eligible: false, reason: "reply_target_dependency" };
  }
  if (ACTION_VERB_MATCHER.test(text)) {
    return { eligible: false, reason: "action_intent" };
  }
  if (CODE_REPO_MATCHER.test(text)) {
    return { eligible: false, reason: "code_or_repo" };
  }
  if (SYSTEM_CONFIG_MATCHER.test(text)) {
    return { eligible: false, reason: "system_or_config" };
  }
  if (HIGH_STAKES_MATCHER.test(text)) {
    return { eligible: false, reason: "high_stakes" };
  }
  if (CURRENT_INFO_PATTERNS.some((pattern) => pattern.test(text))) {
    return { eligible: false, reason: "not_obvious_small_talk" };
  }
  if (!OBVIOUS_SMALL_TALK_PATTERNS.some((pattern) => pattern.test(text))) {
    return { eligible: false, reason: "not_obvious_small_talk" };
  }
  return { eligible: true };
}

/**
 * Caller intent always wins. When the caller already pinned context mode, tool
 * availability, delivery mode, a skill filter, inbound images, or a heartbeat
 * run, the lane stays out of the way so it never relaxes a deliberate choice.
 */
function callerOptsPreventLightweight(opts: GetReplyOptions | undefined): boolean {
  if (!opts) {
    return false;
  }
  return (
    opts.isHeartbeat === true ||
    opts.bootstrapContextMode !== undefined ||
    opts.disableTools !== undefined ||
    opts.sourceReplyDeliveryMode !== undefined ||
    opts.skillFilter !== undefined ||
    (Array.isArray(opts.images) && opts.images.length > 0)
  );
}

/**
 * Returns options upgraded for the lightweight lane, or undefined to leave the
 * caller's options untouched (full agent path).
 */
export function applyLightweightReplyLane(
  opts: GetReplyOptions | undefined,
  signals: LightweightLaneSignals,
): GetReplyOptions | undefined {
  if (callerOptsPreventLightweight(opts)) {
    return undefined;
  }
  if (!classifyLightweightLane(signals).eligible) {
    return undefined;
  }
  return { ...opts, bootstrapContextMode: "lightweight" };
}
