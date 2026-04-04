import { resolveAgentConfig } from "../../agents/agent-scope.js";
import { getChannelPlugin, normalizeChannelId } from "../../channels/plugins/index.js";
import type { ChannelId } from "../../channels/plugins/types.js";
import type { OpenClawConfig } from "../../config/config.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { compileConfigRegexes, type ConfigRegexRejectReason } from "../../security/config-regex.js";
import { escapeRegExp } from "../../utils.js";
import type { MsgContext } from "../templating.js";

function deriveMentionPatterns(identity?: { name?: string; emoji?: string }) {
  const patterns: string[] = [];
  const name = identity?.name?.trim();
  if (name) {
    const parts = name.split(/\s+/).filter(Boolean).map(escapeRegExp);
    const re = parts.length ? parts.join(String.raw`\s+`) : escapeRegExp(name);
    // Use Unicode-aware word boundary: \b doesn't work well with non-ASCII chars (Chinese, etc.)
    // For patterns containing non-ASCII characters, use simpler matching
    const hasNonAscii = /[^\x00-\x7F]/.test(name);
    if (hasNonAscii) {
      // For Unicode names: match the name anywhere with optional @ prefix
      // Use lookahead/lookbehind for boundaries instead of \b
      patterns.push(String.raw`@?${re}`);
    } else {
      // For ASCII names: use \b for word boundary
      patterns.push(String.raw`\b@?${re}\b`);
    }
  }
  const emoji = identity?.emoji?.trim();
  if (emoji) {
    patterns.push(escapeRegExp(emoji));
  }
  return patterns;
}

const BACKSPACE_CHAR = "\u0008";
// LRU cache implementation: Map stores the data, array tracks access order
interface LRUCache<T> {
  cache: Map<string, T>;
  keys: string[];
}
const mentionMatchRegexCompileCache: LRUCache<RegExp[]> = { cache: new Map(), keys: [] };
const mentionStripRegexCompileCache: LRUCache<RegExp[]> = { cache: new Map(), keys: [] };
const MAX_MENTION_REGEX_COMPILE_CACHE_KEYS = 512;
const LRU_EVICT_BATCH_SIZE = 128; // Number of entries to evict at once
const mentionPatternWarningCache = new Set<string>();
const MAX_MENTION_PATTERN_WARNING_KEYS = 512;
const log = createSubsystemLogger("mentions");

export const CURRENT_MESSAGE_MARKER = "[Current message - respond to this]";

function normalizeMentionPattern(pattern: string): string {
  if (!pattern.includes(BACKSPACE_CHAR)) {
    return pattern;
  }
  return pattern.split(BACKSPACE_CHAR).join("\\b");
}

function normalizeMentionPatterns(patterns: string[]): string[] {
  return patterns.map(normalizeMentionPattern);
}

function warnRejectedMentionPattern(
  pattern: string,
  flags: string,
  reason: ConfigRegexRejectReason,
) {
  const key = `${flags}::${reason}::${pattern}`;
  if (mentionPatternWarningCache.has(key)) {
    return;
  }
  mentionPatternWarningCache.add(key);
  if (mentionPatternWarningCache.size > MAX_MENTION_PATTERN_WARNING_KEYS) {
    mentionPatternWarningCache.clear();
    mentionPatternWarningCache.add(key);
  }
  log.warn("Ignoring unsupported group mention pattern", {
    pattern,
    flags,
    reason,
  });
}

function cacheMentionRegexes(
  cache: LRUCache<RegExp[]>,
  cacheKey: string,
  regexes: RegExp[],
): RegExp[] {
  // If key already exists, remove it from keys array (it will be re-added to end)
  const existingIndex = cache.keys.indexOf(cacheKey);
  if (existingIndex !== -1) {
    cache.keys.splice(existingIndex, 1);
  } else {
    // New entry - check if we need to evict
    if (cache.cache.size >= MAX_MENTION_REGEX_COMPILE_CACHE_KEYS) {
      // Evict oldest entries (batch evict for efficiency)
      const evictCount = Math.min(LRU_EVICT_BATCH_SIZE, cache.keys.length);
      for (let i = 0; i < evictCount; i++) {
        const evictKey = cache.keys.shift();
        if (evictKey) {
          cache.cache.delete(evictKey);
        }
      }
    }
  }
  // Add to end of keys array (most recently used)
  cache.keys.push(cacheKey);
  cache.cache.set(cacheKey, regexes);
  return [...regexes];
}

// Detect if pattern contains non-ASCII characters (Chinese, Japanese, Korean, etc.)
function hasNonAsciiChars(pattern: string): boolean {
  return /[^\x00-\x7F]/.test(pattern);
}

// Convert \b-based pattern to Unicode-friendly version
// \b doesn't work properly with non-ASCII characters (Chinese, etc.)
function unicodeizePattern(pattern: string): string {
  // Check if pattern has non-ASCII characters
  if (!hasNonAsciiChars(pattern)) {
    return pattern; // ASCII pattern, keep as-is
  }

  // For patterns with non-ASCII chars, replace problematic \b with simpler matching
  // In the pattern string, literal \b is represented as \\b (two chars: backslash + 'b')
  let result = pattern;

  // Remove leading \b@? or \b
  if (result.startsWith('\\b@?')) {
    result = result.slice(4); // remove \b@?
  } else if (result.startsWith('\\b')) {
    result = result.slice(2); // remove \b
  }

  // Remove trailing \b
  if (result.endsWith('\\b')) {
    result = result.slice(0, -2);
  }

  return result;
}

function compileMentionPatternsCached(params: {
  patterns: string[];
  flags: string;
  cache: LRUCache<RegExp[]>;
  warnRejected: boolean;
}): RegExp[] {
  if (params.patterns.length === 0) {
    return [];
  }

  // Preprocess patterns to handle Unicode characters
  const processedPatterns = params.patterns.map(p => unicodeizePattern(p));

  const cacheKey = `${params.flags}\u001e${processedPatterns.join("\u001f")}`;
  const cached = params.cache.cache.get(cacheKey);
  if (cached) {
    // Update access order for LRU: move to end of keys array (most recently used)
    const index = params.cache.keys.indexOf(cacheKey);
    if (index !== -1) {
      params.cache.keys.splice(index, 1);
      params.cache.keys.push(cacheKey);
    }
    return [...cached];
  }

  const compiled = compileConfigRegexes(processedPatterns, params.flags);
  if (params.warnRejected) {
    for (const rejected of compiled.rejected) {
      warnRejectedMentionPattern(rejected.pattern, rejected.flags, rejected.reason);
    }
  }
  return cacheMentionRegexes(params.cache, cacheKey, compiled.regexes);
}

function resolveMentionPatterns(cfg: OpenClawConfig | undefined, agentId?: string): string[] {
  if (!cfg) {
    return [];
  }
  const agentConfig = agentId ? resolveAgentConfig(cfg, agentId) : undefined;
  const agentGroupChat = agentConfig?.groupChat;
  if (agentGroupChat && Object.hasOwn(agentGroupChat, "mentionPatterns")) {
    return agentGroupChat.mentionPatterns ?? [];
  }
  const globalGroupChat = cfg.messages?.groupChat;
  if (globalGroupChat && Object.hasOwn(globalGroupChat, "mentionPatterns")) {
    return globalGroupChat.mentionPatterns ?? [];
  }
  const derived = deriveMentionPatterns(agentConfig?.identity);
  return derived.length > 0 ? derived : [];
}

export function buildMentionRegexes(cfg: OpenClawConfig | undefined, agentId?: string): RegExp[] {
  const patterns = normalizeMentionPatterns(resolveMentionPatterns(cfg, agentId));
  return compileMentionPatternsCached({
    patterns,
    flags: "i",
    cache: mentionMatchRegexCompileCache,
    warnRejected: true,
  });
}

export function normalizeMentionText(text: string): string {
  return (text ?? "").replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u206f]/g, "").toLowerCase();
}

export function matchesMentionPatterns(text: string, mentionRegexes: RegExp[]): boolean {
  if (mentionRegexes.length === 0) {
    return false;
  }
  const cleaned = normalizeMentionText(text ?? "");
  if (!cleaned) {
    return false;
  }
  return mentionRegexes.some((re) => re.test(cleaned));
}

export type ExplicitMentionSignal = {
  hasAnyMention: boolean;
  isExplicitlyMentioned: boolean;
  canResolveExplicit: boolean;
};

export function matchesMentionWithExplicit(params: {
  text: string;
  mentionRegexes: RegExp[];
  explicit?: ExplicitMentionSignal;
  transcript?: string;
}): boolean {
  const cleaned = normalizeMentionText(params.text ?? "");
  const explicit = params.explicit?.isExplicitlyMentioned === true;
  const explicitAvailable = params.explicit?.canResolveExplicit === true;
  const hasAnyMention = params.explicit?.hasAnyMention === true;

  // Check transcript if text is empty and transcript is provided
  const transcriptCleaned = params.transcript ? normalizeMentionText(params.transcript) : "";
  const textToCheck = cleaned || transcriptCleaned;

  if (hasAnyMention && explicitAvailable) {
    return explicit || params.mentionRegexes.some((re) => re.test(textToCheck));
  }
  if (!textToCheck) {
    return explicit;
  }
  return explicit || params.mentionRegexes.some((re) => re.test(textToCheck));
}

export function stripStructuralPrefixes(text: string): string {
  if (!text) {
    return "";
  }
  // Ignore wrapper labels, timestamps, and sender prefixes so directive-only
  // detection still works in group batches that include history/context.
  const afterMarker = text.includes(CURRENT_MESSAGE_MARKER)
    ? text.slice(text.indexOf(CURRENT_MESSAGE_MARKER) + CURRENT_MESSAGE_MARKER.length).trimStart()
    : text;

  return afterMarker
    .replace(/\[[^\]]+\]\s*/g, "")
    .replace(/^[ \t]*[A-Za-z0-9+()\-_. ]+:\s*/gm, "")
    .replace(/\\n/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function stripMentions(
  text: string,
  ctx: MsgContext,
  cfg: OpenClawConfig | undefined,
  agentId?: string,
): string {
  let result = text;
  const providerId =
    (ctx.Provider ? normalizeChannelId(ctx.Provider) : null) ??
    (ctx.Provider?.trim().toLowerCase() as ChannelId | undefined) ??
    null;
  const providerMentions = providerId ? getChannelPlugin(providerId)?.mentions : undefined;
  const configRegexes = compileMentionPatternsCached({
    patterns: normalizeMentionPatterns(resolveMentionPatterns(cfg, agentId)),
    flags: "gi",
    cache: mentionStripRegexCompileCache,
    warnRejected: true,
  });
  const providerRegexes =
    providerMentions?.stripRegexes?.({ ctx, cfg, agentId }) ??
    compileMentionPatternsCached({
      patterns: normalizeMentionPatterns(
        providerMentions?.stripPatterns?.({ ctx, cfg, agentId }) ?? [],
      ),
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
  // Generic mention patterns like @123456789 or plain digits
  result = result.replace(/@[0-9+]{5,}/g, " ");
  return result.replace(/\s+/g, " ").trim();
}
