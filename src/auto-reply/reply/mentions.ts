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
function encodeSeparator(unit: Extract<NameUnit, { kind: "separator" }>): string {
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
function encodeInteriorDecoration(unit: Extract<NameUnit, { kind: "decoration" }>): string {
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

type CommandMentionBounds = {
  commandStart: number;
  commandEnd: number;
  suffixEnd: number;
};

function isStandaloneCommandArgumentMatch(
  sourceText: string,
  offset: number,
  matchLength: number,
): boolean {
  const matchEnd = offset + matchLength;
  return (
    (offset === 0 ||
      /\s/u.test(sourceText[offset - 1] ?? "") ||
      /\s/u.test(sourceText[offset] ?? "")) &&
    (matchEnd === sourceText.length ||
      /\s/u.test(sourceText[matchEnd] ?? "") ||
      /\s/u.test(sourceText[matchEnd - 1] ?? ""))
  );
}

function shouldStripCommandMentionMatch(
  sourceText: string,
  bounds: CommandMentionBounds,
  offset: number,
  matchLength: number,
): boolean {
  const matchEnd = offset + matchLength;
  if (matchEnd <= bounds.commandStart) {
    return true;
  }
  if (offset < bounds.commandEnd && matchEnd > bounds.commandStart) {
    return false;
  }
  if (offset < bounds.suffixEnd && matchEnd > bounds.commandEnd) {
    return (
      offset === bounds.commandEnd &&
      matchEnd >= bounds.suffixEnd &&
      /^\s*$/u.test(sourceText.slice(bounds.suffixEnd, matchEnd))
    );
  }
  return (
    offset >= bounds.suffixEnd && isStandaloneCommandArgumentMatch(sourceText, offset, matchLength)
  );
}

function replaceMentionMatches(
  text: string,
  re: RegExp,
  sourceText: string,
  commandBounds?: CommandMentionBounds,
  removedCommandCharacters?: Uint8Array,
): string {
  if (!commandBounds) {
    return text.replace(re, " ");
  }
  return text.replace(re, (match: string, ...args: unknown[]) => {
    const offsetCandidate = args.at(-2);
    const offsetWithNamedGroupsCandidate = args.at(-3);
    const offset =
      typeof offsetCandidate === "number"
        ? offsetCandidate
        : typeof offsetWithNamedGroupsCandidate === "number"
          ? offsetWithNamedGroupsCandidate
          : undefined;
    if (
      match.length === 0 ||
      offset === undefined ||
      !shouldStripCommandMentionMatch(sourceText, commandBounds, offset, match.length)
    ) {
      return match;
    }
    if (offset >= commandBounds.commandEnd) {
      let removalStart = offset;
      let removalEnd = offset + match.length;
      while (removalStart < removalEnd && /\s/u.test(sourceText[removalStart] ?? "")) {
        removalStart += 1;
      }
      while (removalEnd > removalStart && /\s/u.test(sourceText[removalEnd - 1] ?? "")) {
        removalEnd -= 1;
      }
      removedCommandCharacters?.fill(1, removalStart, removalEnd);
    }
    return " ".repeat(match.length);
  });
}

function removeCommandArgumentMentionCharacters(
  text: string,
  removedCommandCharacters: Uint8Array,
  argumentStart: number,
): string {
  for (let index = argumentStart; index < text.length; index += 1) {
    if (!removedCommandCharacters[index] || removedCommandCharacters[index - 1]) {
      continue;
    }
    const separator = text[index - 1];
    if (separator && /\s/u.test(separator)) {
      removedCommandCharacters[index - 1] = 1;
      if (separator === "\n" && text[index - 2] === "\r") {
        removedCommandCharacters[index - 2] = 1;
      }
    }
  }
  const chunks: string[] = [];
  let retainedStart = argumentStart;
  for (let index = argumentStart; index < text.length; index += 1) {
    if (!removedCommandCharacters[index]) {
      continue;
    }
    if (retainedStart < index) {
      chunks.push(text.slice(retainedStart, index));
    }
    retainedStart = index + 1;
  }
  if (retainedStart < text.length) {
    chunks.push(text.slice(retainedStart));
  }
  return chunks.join("");
}

function isCommandSuffixFullyRemoved(
  removedCommandCharacters: Uint8Array,
  bounds: CommandMentionBounds,
): boolean {
  if (bounds.suffixEnd === bounds.commandEnd) {
    return false;
  }
  for (let index = bounds.commandEnd; index < bounds.suffixEnd; index += 1) {
    if (!removedCommandCharacters[index]) {
      return false;
    }
  }
  return true;
}

function markStandaloneProviderMentions(
  text: string,
  argumentStart: number,
  removedCommandCharacters: Uint8Array,
  stripText: (text: string) => string,
): void {
  const source = text.slice(argumentStart);
  let start = 0;
  while (start < source.length) {
    while (start < source.length && /\s/u.test(source[start] ?? "")) {
      start += 1;
    }
    if (start === source.length) {
      break;
    }
    let end = start;
    const closing = source[start] === "<" ? ">" : source[start] === "[" ? "]" : undefined;
    if (closing) {
      end += 1;
      while (end < source.length && source[end] !== closing && !/[\r\n]/u.test(source[end] ?? "")) {
        end += 1;
      }
      if (source[end] === closing) {
        end += 1;
        while (end < source.length && !/\s/u.test(source[end] ?? "")) {
          end += 1;
        }
      }
    } else {
      while (end < source.length && !/\s/u.test(source[end] ?? "")) {
        end += 1;
      }
    }
    const candidate = source.slice(start, end);
    if (stripText(candidate).trim()) {
      start = end;
      continue;
    }
    removedCommandCharacters.fill(1, argumentStart + start, argumentStart + end);
    start = end;
  }
}

function stripMentionsInternal(
  text: string,
  ctx: MsgContext,
  cfg: OpenClawConfig | undefined,
  agentId?: string,
  commandBounds?: CommandMentionBounds,
): string {
  let result = text;
  const removedCommandCharacters = new Uint8Array(commandBounds ? text.length : 0);
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
    result = replaceMentionMatches(result, re, text, commandBounds, removedCommandCharacters);
  }
  const numericMentionPattern = /@[0-9+]{5,}/g;
  const stripProviderMentions = providerMentions?.stripMentions;
  if (!commandBounds) {
    if (stripProviderMentions) {
      result = stripProviderMentions({ text: result, ctx, cfg, agentId });
    }
    result = result.replace(numericMentionPattern, " ");
    // Slash commands may carry multiline arguments. Preserve their spacing as
    // in direct messages, while keeping ordinary mention stripping normalized.
    const stripped = result.trim();
    return stripped.startsWith("/") ? stripped : stripped.replace(/\s+/g, " ");
  }

  let providerLeading: string | undefined;
  let providerSuffix: string | undefined;
  if (stripProviderMentions) {
    providerLeading = stripProviderMentions({
      text: result.slice(0, commandBounds.commandStart),
      ctx,
      cfg,
      agentId,
    });
    providerSuffix = stripProviderMentions({
      text: result.slice(commandBounds.commandEnd, commandBounds.suffixEnd),
      ctx,
      cfg,
      agentId,
    });
    markStandaloneProviderMentions(
      result,
      commandBounds.suffixEnd,
      removedCommandCharacters,
      (commandArguments) => stripProviderMentions({ text: commandArguments, ctx, cfg, agentId }),
    );
  }
  result = replaceMentionMatches(
    result,
    numericMentionPattern,
    text,
    commandBounds,
    removedCommandCharacters,
  );

  if (providerLeading !== undefined && providerSuffix !== undefined) {
    const leadingClean = providerLeading
      .replace(numericMentionPattern, " ")
      .replace(/\s+/g, " ")
      .trim();
    const commandName = result.slice(commandBounds.commandStart, commandBounds.commandEnd);
    const suffixRemovedByRegex = isCommandSuffixFullyRemoved(
      removedCommandCharacters,
      commandBounds,
    );
    const suffixRemovedByProvider = providerSuffix.trim().length === 0;
    const commandSuffix =
      suffixRemovedByRegex || suffixRemovedByProvider
        ? ""
        : text.slice(commandBounds.commandEnd, commandBounds.suffixEnd);
    const argumentsText = removeCommandArgumentMentionCharacters(
      text,
      removedCommandCharacters,
      commandBounds.suffixEnd,
    );
    const normalizedCommand = `${commandName}${commandSuffix}${argumentsText}`;
    return leadingClean ? `${leadingClean} ${normalizedCommand}` : normalizedCommand;
  }
  const leading = result.slice(0, commandBounds.commandStart).replace(/\s+/g, " ").trim();
  const commandName = result.slice(commandBounds.commandStart, commandBounds.commandEnd);
  const suffixRemoved = isCommandSuffixFullyRemoved(removedCommandCharacters, commandBounds);
  const commandSuffix = suffixRemoved
    ? ""
    : text.slice(commandBounds.commandEnd, commandBounds.suffixEnd);
  const argumentsText = removeCommandArgumentMentionCharacters(
    text,
    removedCommandCharacters,
    commandBounds.suffixEnd,
  );
  const normalizedCommand = `${commandName}${commandSuffix}${argumentsText}`;
  return leading ? `${leading} ${normalizedCommand}` : normalizedCommand;
}

export function stripMentions(
  text: string,
  ctx: MsgContext,
  cfg: OpenClawConfig | undefined,
  agentId?: string,
): string {
  return stripMentionsInternal(text, ctx, cfg, agentId);
}

export function stripCommandAddressingMentions(
  text: string,
  ctx: MsgContext,
  cfg: OpenClawConfig | undefined,
  agentId?: string,
): string {
  const commandName = /\/[^\s@:]+/u.exec(text);
  if (!commandName) {
    return stripMentions(text, ctx, cfg, agentId);
  }

  const commandEnd = commandName.index + commandName[0].length;
  const suffix = /^@[^\s:]+/u.exec(text.slice(commandEnd));
  const strippedHead = stripMentionsInternal(text, ctx, cfg, agentId, {
    commandStart: commandName.index,
    commandEnd,
    suffixEnd: commandEnd + (suffix?.[0].length ?? 0),
  });
  if (!strippedHead.startsWith("/")) {
    return stripMentions(text, ctx, cfg, agentId);
  }
  return strippedHead;
}
