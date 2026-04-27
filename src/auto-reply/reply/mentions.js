import { resolveAgentConfig } from "../../agents/agent-scope.js";
import { getLoadedChannelPluginById } from "../../channels/plugins/registry-loaded.js";
import { normalizeAnyChannelId } from "../../channels/registry.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { compileConfigRegexes } from "../../security/config-regex.js";
import { normalizeLowercaseStringOrEmpty, normalizeOptionalLowercaseString, normalizeOptionalString, } from "../../shared/string-coerce.js";
import { escapeRegExp } from "../../utils.js";
function deriveMentionPatterns(identity) {
    const patterns = [];
    const name = normalizeOptionalString(identity?.name);
    if (name) {
        const parts = name.split(/\s+/).filter(Boolean).map(escapeRegExp);
        const re = parts.length ? parts.join(String.raw `\s+`) : escapeRegExp(name);
        patterns.push(String.raw `\b@?${re}\b`);
    }
    const emoji = normalizeOptionalString(identity?.emoji);
    if (emoji) {
        patterns.push(escapeRegExp(emoji));
    }
    return patterns;
}
const BACKSPACE_CHAR = "\u0008";
const mentionMatchRegexCompileCache = new Map();
const mentionStripRegexCompileCache = new Map();
const MAX_MENTION_REGEX_COMPILE_CACHE_KEYS = 512;
const mentionPatternWarningCache = new Set();
const MAX_MENTION_PATTERN_WARNING_KEYS = 512;
const log = createSubsystemLogger("mentions");
export const CURRENT_MESSAGE_MARKER = "[Current message - respond to this]";
function normalizeMentionPattern(pattern) {
    if (!pattern.includes(BACKSPACE_CHAR)) {
        return pattern;
    }
    return pattern.split(BACKSPACE_CHAR).join("\\b");
}
function normalizeMentionPatterns(patterns) {
    return patterns.map(normalizeMentionPattern);
}
function warnRejectedMentionPattern(pattern, flags, reason) {
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
function cacheMentionRegexes(cache, cacheKey, regexes) {
    cache.set(cacheKey, regexes);
    if (cache.size > MAX_MENTION_REGEX_COMPILE_CACHE_KEYS) {
        cache.clear();
        cache.set(cacheKey, regexes);
    }
    return [...regexes];
}
function compileMentionPatternsCached(params) {
    if (params.patterns.length === 0) {
        return [];
    }
    const cacheKey = `${params.flags}\u001e${params.patterns.join("\u001f")}`;
    const cached = params.cache.get(cacheKey);
    if (cached) {
        return [...cached];
    }
    const compiled = compileConfigRegexes(params.patterns, params.flags);
    if (params.warnRejected) {
        for (const rejected of compiled.rejected) {
            warnRejectedMentionPattern(rejected.pattern, rejected.flags, rejected.reason);
        }
    }
    return cacheMentionRegexes(params.cache, cacheKey, compiled.regexes);
}
function resolveMentionPatterns(cfg, agentId) {
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
export function buildMentionRegexes(cfg, agentId) {
    const patterns = normalizeMentionPatterns(resolveMentionPatterns(cfg, agentId));
    return compileMentionPatternsCached({
        patterns,
        flags: "i",
        cache: mentionMatchRegexCompileCache,
        warnRejected: true,
    });
}
export function normalizeMentionText(text) {
    return normalizeLowercaseStringOrEmpty((text ?? "").replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u206f]/g, ""));
}
export function matchesMentionPatterns(text, mentionRegexes) {
    if (mentionRegexes.length === 0) {
        return false;
    }
    const cleaned = normalizeMentionText(text ?? "");
    if (!cleaned) {
        return false;
    }
    return mentionRegexes.some((re) => re.test(cleaned));
}
export function matchesMentionWithExplicit(params) {
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
export function stripStructuralPrefixes(text) {
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
export function stripMentions(text, ctx, cfg, agentId) {
    let result = text;
    const providerId = (ctx.Provider ? normalizeAnyChannelId(ctx.Provider) : null) ??
        normalizeOptionalLowercaseString(ctx.Provider) ??
        null;
    const providerMentions = providerId
        ? getLoadedChannelPluginById(providerId)?.mentions
        : undefined;
    const configRegexes = compileMentionPatternsCached({
        patterns: normalizeMentionPatterns(resolveMentionPatterns(cfg, agentId)),
        flags: "gi",
        cache: mentionStripRegexCompileCache,
        warnRejected: true,
    });
    const providerRegexes = providerMentions?.stripRegexes?.({ ctx, cfg, agentId }) ??
        compileMentionPatternsCached({
            patterns: normalizeMentionPatterns(providerMentions?.stripPatterns?.({ ctx, cfg, agentId }) ?? []),
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
