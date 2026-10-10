import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { resolveAgentConfig } from "../../agents/agent-scope.js";
import { resolveMentionPatternPolicy } from "../../channels/mention-pattern-policy.js";
import type { ChannelId } from "../../channels/plugins/channel-id.types.js";
import { getLoadedChannelPluginById } from "../../channels/plugins/registry-loaded.js";
import { normalizeAnyChannelId } from "../../channels/registry.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { compileConfigRegexes, type ConfigRegexRejectReason } from "../../security/config-regex.js";
import { escapeRegExp } from "../../utils.js";
import type { MsgContext } from "../templating.js";
import { HISTORY_CONTEXT_MARKER, RECENT_HISTORY_CONTEXT_MARKER } from "./history.js";
import type { BuildMentionRegexesOptions, ExplicitMentionSignal } from "./mentions.types.js";
export type { BuildMentionRegexesOptions } from "./mentions.types.js";
export { CURRENT_MESSAGE_MARKER } from "./history.js";

const NAME_IDENTITY_CHARS = String.raw`\p{L}\p{N}\p{Pc}`;
const NAME_TOKEN_CHARS = String.raw`${NAME_IDENTITY_CHARS}\p{M}`;
const JOINER_CHARS = String.raw`\u200C\u200D`;
const DECORATION_SPACING = String.raw`[${JOINER_CHARS}\s]*`;
const OPTIONAL_JOINER_GAP = String.raw`[${JOINER_CHARS}]*`;
const UNICODE_WORD_CHAR = String.raw`[${NAME_TOKEN_CHARS}${JOINER_CHARS}]`;
const JOINER_RUN = new RegExp(`[${JOINER_CHARS}]+`, "u");
const JOINER_ONLY = new RegExp(`^[${JOINER_CHARS}]+$`, "u");
const OMISSIBLE_DECORATION_CHAR = new RegExp(
  String.raw`[\p{So}\p{M}\u{1F3FB}-\u{1F3FF}\u200B-\u200F\u202A-\u202E\u2060-\u206F\u{E0020}-\u{E007F}]`,
  "u",
);
const EMOJI_PRESENTATION_MARKS = new Set(["\uFE0F", "\u20E3"]);
const EMOJI_PRESENTATION_BASE = /\p{Emoji}/u;
const NAME_IDENTITY_GRAPHEME = new RegExp(`[${NAME_IDENTITY_CHARS}]`, "u");
const NAME_GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function wrapDerivedMentionPattern(parts: ReturnType<typeof deriveNameParts>): string {
  // Boundaries reach across optional edge decoration. Each branch owns its
  // spacing seam because overlapping repetitions make raw stripping quadratic.
  const leading = parts.leading ? `(?:${parts.leading}${DECORATION_SPACING}|)` : "";
  const trailing = parts.trailing
    ? `(?:${DECORATION_SPACING}${parts.trailing}(?!${UNICODE_WORD_CHAR})|(?!${UNICODE_WORD_CHAR})(?!${DECORATION_SPACING}${parts.trailing}${UNICODE_WORD_CHAR}))`
    : `(?!${UNICODE_WORD_CHAR})`;
  return `(?:@|(?<!${UNICODE_WORD_CHAR}${leading}))${leading}${parts.core}${trailing}`;
}

function encodeOptionalJoiners(literal: string): string {
  return literal
    .split(/([\u200C\u200D]+)/u)
    .filter(Boolean)
    .map((part) => (JOINER_ONLY.test(part) ? `(?:${escapeRegExp(part)}|)` : escapeRegExp(part)))
    .join("");
}

function escapeJoinerTolerantLiteral(literal: string): string {
  // Matching runs on normalized text, which has joiners stripped, while
  // stripping runs on the raw text that still carries them. A literal has to
  // accept both forms or an identity built only from a ZWJ sequence can be
  // stripped but never matched.
  if (!literal || JOINER_ONLY.test(literal)) {
    // Nothing survives normalization. Emitting the optional joiner class alone
    // would match the empty string, i.e. every message.
    return "";
  }
  return encodeOptionalJoiners(literal);
}

// Decoration is optional and consumed once in spelling order; separators remain
// required. Encode positions independently so stripping cannot eat adjacent decoration.
type NameUnit =
  | { kind: "token"; literal: string }
  | { kind: "separator"; literal: string }
  | { kind: "decoration"; literal: string; spellings: string[]; spaced: boolean };
type DecorationUnit = Extract<NameUnit, { kind: "decoration" }>;
type SeparatorUnit = Extract<NameUnit, { kind: "separator" }>;

function isEmojiPresentationGrapheme(grapheme: string): boolean {
  const characters = Array.from(grapheme);
  const first = characters[0];
  return Boolean(
    first &&
    EMOJI_PRESENTATION_BASE.test(first) &&
    characters.some((character) => EMOJI_PRESENTATION_MARKS.has(character)),
  );
}

function isIdentityGrapheme(grapheme: string): boolean {
  return NAME_IDENTITY_GRAPHEME.test(grapheme) && !isEmojiPresentationGrapheme(grapheme);
}

function isDecorationGrapheme(grapheme: string): boolean {
  if (isEmojiPresentationGrapheme(grapheme)) {
    return true;
  }
  return Array.from(grapheme).every(
    (character) =>
      /\s/u.test(character) ||
      JOINER_RUN.test(character) ||
      OMISSIBLE_DECORATION_CHAR.test(character),
  );
}

function parseNameUnits(name: string): NameUnit[] {
  const graphemes = Array.from(NAME_GRAPHEME_SEGMENTER.segment(name), (part) => part.segment);
  const runs: Array<{ identity: boolean; literal: string }> = [];
  for (const grapheme of graphemes) {
    const identity = isIdentityGrapheme(grapheme);
    const previous = runs.at(-1);
    if (previous?.identity === identity) {
      previous.literal += grapheme;
    } else {
      runs.push({ identity, literal: grapheme });
    }
  }
  return runs.map((run) => {
    if (run.identity) {
      return { kind: "token", literal: run.literal };
    }
    const gapGraphemes = Array.from(
      NAME_GRAPHEME_SEGMENTER.segment(run.literal),
      (part) => part.segment,
    );
    if (!gapGraphemes.every(isDecorationGrapheme)) {
      return { kind: "separator", literal: run.literal };
    }
    return {
      kind: "decoration",
      literal: run.literal,
      spellings: gapGraphemes
        .filter((grapheme) => !/^\s+$/u.test(grapheme) && !JOINER_ONLY.test(grapheme))
        .map(escapeJoinerTolerantLiteral),
      spaced: /\s/u.test(run.literal),
    };
  });
}

// Preserve literal separators with flexible whitespace and optional raw-text joiners.
function encodeSeparator(unit: SeparatorUnit): string {
  return unit.literal
    .split(/(\s+|[\u200C\u200D]+)/u)
    .filter(Boolean)
    .map((piece) =>
      /^\s+$/u.test(piece)
        ? String.raw`\s+`
        : JOINER_ONLY.test(piece)
          ? encodeOptionalJoiners(piece)
          : escapeRegExp(piece),
    )
    .join("");
}

function encodeEdgeDecorationLiteral(unit: NameUnit | undefined): string {
  if (unit?.kind !== "decoration") {
    return "";
  }
  const spelled = unit.spellings.join(OPTIONAL_JOINER_GAP);
  if (!spelled) {
    // A markless edge is spelled with joiners and spacing alone. The joiners
    // are taken at the core's seam, and the whitespace is the member's own.
    return encodeOptionalJoiners(unit.literal.replace(/[^\u200C\u200D]/gu, ""));
  }
  return spelled;
}

// Accept only the name's decoration, once, so stripping preserves unrelated punctuation.
function encodeInteriorDecoration(unit: DecorationUnit): string {
  const spelled = unit.spellings.join(DECORATION_SPACING);
  if (!spelled) {
    // Joiners vanish during matching; whitespace survives and remains required
    // only when the original gap carried it.
    const joiners = encodeOptionalJoiners(unit.literal.replace(/[^\u200C\u200D]/gu, ""));
    return unit.spaced ? String.raw`${joiners}\s${DECORATION_SPACING}` : joiners;
  }
  // A gap carrying whitespace keeps a one-separator floor so the bare
  // concatenation of the surrounding words never matches.
  return `(?:${DECORATION_SPACING}${spelled}${DECORATION_SPACING}|\\s${unit.spaced ? "+" : "*"})`;
}

function deriveNameParts(name: string) {
  const units = parseNameUnits(name);
  if (!units.some((unit) => unit.kind === "token")) {
    // No word run at all (e.g. a bare emoji or a punctuation string): match
    // the name literally.
    return { leading: "", core: escapeJoinerTolerantLiteral(name), trailing: "" };
  }
  // Edge separators stay in the core; only optional decoration moves outside it.
  const start = units[0]?.kind === "decoration" ? 1 : 0;
  const end = units.at(-1)?.kind === "decoration" ? units.length - 1 : units.length;
  let core = "";
  for (const unit of units.slice(start, end)) {
    core +=
      unit.kind === "token"
        ? escapeJoinerTolerantLiteral(unit.literal)
        : unit.kind === "separator"
          ? encodeSeparator(unit)
          : encodeInteriorDecoration(unit);
  }
  return {
    leading: encodeEdgeDecorationLiteral(units[0]),
    core,
    trailing: encodeEdgeDecorationLiteral(units.at(-1)),
  };
}

function deriveMentionPatterns(identity?: { name?: string; emoji?: string }) {
  const patterns: string[] = [];
  const name = normalizeOptionalString(identity?.name);
  const parts = name ? deriveNameParts(name) : undefined;
  if (parts?.core) {
    patterns.push(wrapDerivedMentionPattern(parts));
  }
  const emoji = normalizeOptionalString(identity?.emoji);
  const emojiPattern = emoji ? escapeJoinerTolerantLiteral(emoji) : "";
  if (emojiPattern) {
    patterns.push(emojiPattern);
  }
  return patterns;
}

const BACKSPACE_CHAR = "\u0008";
const mentionMatchRegexCompileCache = new Map<string, RegExp[]>();
const mentionStripRegexCompileCache = new Map<string, RegExp[]>();
const MAX_MENTION_REGEX_COMPILE_CACHE_KEYS = 512;
const mentionPatternWarningCache = new Set<string>();
const MAX_MENTION_PATTERN_WARNING_KEYS = 512;
const log = createSubsystemLogger("mentions");

function warnRejectedMentionPattern(
  pattern: string,
  flags: string,
  reason: ConfigRegexRejectReason,
) {
  const key = `${flags}::${reason}::${pattern}`;
  if (mentionPatternWarningCache.has(key)) {
    return;
  }
  if (mentionPatternWarningCache.size >= MAX_MENTION_PATTERN_WARNING_KEYS) {
    mentionPatternWarningCache.clear();
  }
  mentionPatternWarningCache.add(key);
  log.warn("Ignoring unsupported group mention pattern", {
    pattern,
    flags,
    reason,
  });
}

function compileMentionPatternsCached(params: {
  patterns: string[];
  flags: string;
  cache: Map<string, RegExp[]>;
  warnRejected: boolean;
}): RegExp[] {
  if (params.patterns.length === 0) {
    return [];
  }
  const patterns = params.patterns.map((pattern) => pattern.replaceAll(BACKSPACE_CHAR, "\\b"));
  const cacheKey = `${params.flags}\u001e${patterns.join("\u001f")}`;
  const cached = params.cache.get(cacheKey);
  if (cached) {
    return [...cached];
  }

  const compiled = compileConfigRegexes(patterns, params.flags);
  if (params.warnRejected) {
    for (const rejected of compiled.rejected) {
      warnRejectedMentionPattern(rejected.pattern, rejected.flags, rejected.reason);
    }
  }
  params.cache.set(cacheKey, compiled.regexes);
  if (params.cache.size > MAX_MENTION_REGEX_COMPILE_CACHE_KEYS) {
    params.cache.clear();
    params.cache.set(cacheKey, compiled.regexes);
  }
  return [...compiled.regexes];
}

function resolveMentionPatterns(cfg: OpenClawConfig | undefined, agentId?: string) {
  if (!cfg) {
    return { patterns: [], unicode: false };
  }
  const agentConfig = agentId ? resolveAgentConfig(cfg, agentId) : undefined;
  for (const groupChat of [agentConfig?.groupChat, cfg.messages?.groupChat]) {
    if (groupChat && Object.hasOwn(groupChat, "mentionPatterns")) {
      return { patterns: groupChat.mentionPatterns ?? [], unicode: false };
    }
  }
  const derived = deriveMentionPatterns(agentConfig?.identity);
  return { patterns: derived, unicode: derived.length > 0 };
}

export function buildMentionRegexes(
  cfg: OpenClawConfig | undefined,
  agentId?: string,
  options?: BuildMentionRegexesOptions,
): RegExp[] {
  if (!resolveMentionPatternPolicy({ ...options, cfg, agentId }).enabled) {
    return [];
  }
  const resolved = resolveMentionPatterns(cfg, agentId);
  return compileMentionPatternsCached({
    patterns: resolved.patterns,
    flags: resolved.unicode ? "iu" : "i",
    cache: mentionMatchRegexCompileCache,
    warnRejected: true,
  });
}

export function normalizeMentionText(text: string): string {
  return normalizeLowercaseStringOrEmpty(
    (text ?? "").replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u206f]/g, ""),
  );
}

export function matchesMentionPatterns(text: string, mentionRegexes: RegExp[]): boolean {
  if (mentionRegexes.length === 0) {
    return false;
  }
  const cleaned = normalizeMentionText(text ?? "");
  return mentionRegexes.some((re) => re.test(cleaned));
}

export function matchesMentionWithExplicit(params: {
  text: string;
  mentionRegexes: RegExp[];
  explicit?: ExplicitMentionSignal;
  transcript?: string;
}): boolean {
  const cleaned = normalizeMentionText(params.text ?? "");
  const explicit = params.explicit?.isExplicitlyMentioned === true;

  const transcriptCleaned = params.transcript ? normalizeMentionText(params.transcript) : "";
  const textToCheck = cleaned || transcriptCleaned;

  return explicit || params.mentionRegexes.some((re) => re.test(textToCheck));
}

export function stripStructuralPrefixes(text: string): string {
  if (!text) {
    return "";
  }
  // Ignore wrapper labels, timestamps, and sender prefixes so directive-only
  // detection still works in group batches that include history/context.
  if (
    text.trimStart().startsWith(HISTORY_CONTEXT_MARKER) ||
    text.trimStart().startsWith(RECENT_HISTORY_CONTEXT_MARKER)
  ) {
    // Flat history has no trustworthy current-message range when users can quote
    // marker text. Leave it non-command-shaped instead of guessing a boundary.
    return text.trim();
  }
  const afterEnvelope = text.replace(/^(?:[ \t]*\[[^\]\n]+\][ \t]*)+/, "");
  const senderPrefixPattern =
    afterEnvelope === text ? /^[ \t]*(?!\/)[^\n:]{1,120}:\s+/gm : /^[ \t]*[^\n:]{1,120}:\s+/gm;

  const stripped = afterEnvelope.replace(senderPrefixPattern, "").replace(/\\n/g, " ").trim();
  return stripped.replace(stripped.startsWith("/") ? /[ \t]+/g : /\s+/g, " ");
}

export function stripMentions(
  text: string,
  ctx: MsgContext,
  cfg: OpenClawConfig | undefined,
  agentId?: string,
): string {
  let result = text;
  const providerId =
    (ctx.Provider ? normalizeAnyChannelId(ctx.Provider) : null) ??
    (normalizeOptionalLowercaseString(ctx.Provider) as ChannelId | undefined) ??
    null;
  const providerMentions = providerId
    ? getLoadedChannelPluginById(providerId)?.mentions
    : undefined;
  const resolvedPatterns = resolveMentionPatterns(cfg, agentId);
  const configRegexes = compileMentionPatternsCached({
    patterns: resolvedPatterns.patterns,
    flags: resolvedPatterns.unicode ? "giu" : "gi",
    cache: mentionStripRegexCompileCache,
    warnRejected: true,
  });
  const providerRegexes =
    providerMentions?.stripRegexes?.({ ctx, cfg, agentId }) ??
    compileMentionPatternsCached({
      patterns: providerMentions?.stripPatterns?.({ ctx, cfg, agentId }) ?? [],
      flags: "gi",
      cache: mentionStripRegexCompileCache,
      warnRejected: false,
    });
  for (const re of [...configRegexes, ...providerRegexes]) {
    result = result.replace(re, " ");
  }
  if (providerMentions?.stripMentions) {
    result = providerMentions.stripMentions({
      text: result,
      ctx,
      cfg,
      agentId,
    });
  }
  result = result.replace(/@[0-9+]{5,}/g, " ");
  return result.replace(/\s+/g, " ").trim();
}
