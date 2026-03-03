import { DEFAULT_EMOJIS } from "../channels/status-reactions.js";
const TELEGRAM_GENERIC_REACTION_FALLBACKS = ["👍", "👀", "🔥"];
const TELEGRAM_SUPPORTED_REACTION_EMOJIS = new Set([
    "❤",
    "👍",
    "👎",
    "🔥",
    "🥰",
    "👏",
    "😁",
    "🤔",
    "🤯",
    "😱",
    "🤬",
    "😢",
    "🎉",
    "🤩",
    "🤮",
    "💩",
    "🙏",
    "👌",
    "🕊",
    "🤡",
    "🥱",
    "🥴",
    "😍",
    "🐳",
    "❤‍🔥",
    "🌚",
    "🌭",
    "💯",
    "🤣",
    "⚡",
    "🍌",
    "🏆",
    "💔",
    "🤨",
    "😐",
    "🍓",
    "🍾",
    "💋",
    "🖕",
    "😈",
    "😴",
    "😭",
    "🤓",
    "👻",
    "👨‍💻",
    "👀",
    "🎃",
    "🙈",
    "😇",
    "😨",
    "🤝",
    "✍",
    "🤗",
    "🫡",
    "🎅",
    "🎄",
    "☃",
    "💅",
    "🤪",
    "🗿",
    "🆒",
    "💘",
    "🙉",
    "🦄",
    "😘",
    "💊",
    "🙊",
    "😎",
    "👾",
    "🤷‍♂",
    "🤷",
    "🤷‍♀",
    "😡",
]);
export const TELEGRAM_STATUS_REACTION_VARIANTS = {
    queued: ["👀", "👍", "🔥"],
    thinking: ["🤔", "🤓", "👀"],
    tool: ["🔥", "⚡", "👍"],
    coding: ["👨‍💻", "🔥", "⚡"],
    web: ["⚡", "🔥", "👍"],
    done: ["👍", "🎉", "💯"],
    error: ["😱", "😨", "🤯"],
    stallSoft: ["🥱", "😴", "🤔"],
    stallHard: ["😨", "😱", "⚡"],
};
const STATUS_REACTION_EMOJI_KEYS = [
    "queued",
    "thinking",
    "tool",
    "coding",
    "web",
    "done",
    "error",
    "stallSoft",
    "stallHard",
];
function normalizeEmoji(value) {
    const trimmed = value?.trim();
    return trimmed ? trimmed : undefined;
}
function toUniqueNonEmpty(values) {
    return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}
export function resolveTelegramStatusReactionEmojis(params) {
    const { overrides } = params;
    const queuedFallback = normalizeEmoji(params.initialEmoji) ?? DEFAULT_EMOJIS.queued;
    return {
        queued: normalizeEmoji(overrides?.queued) ?? queuedFallback,
        thinking: normalizeEmoji(overrides?.thinking) ?? DEFAULT_EMOJIS.thinking,
        tool: normalizeEmoji(overrides?.tool) ?? DEFAULT_EMOJIS.tool,
        coding: normalizeEmoji(overrides?.coding) ?? DEFAULT_EMOJIS.coding,
        web: normalizeEmoji(overrides?.web) ?? DEFAULT_EMOJIS.web,
        done: normalizeEmoji(overrides?.done) ?? DEFAULT_EMOJIS.done,
        error: normalizeEmoji(overrides?.error) ?? DEFAULT_EMOJIS.error,
        stallSoft: normalizeEmoji(overrides?.stallSoft) ?? DEFAULT_EMOJIS.stallSoft,
        stallHard: normalizeEmoji(overrides?.stallHard) ?? DEFAULT_EMOJIS.stallHard,
    };
}
export function buildTelegramStatusReactionVariants(emojis) {
    const variantsByRequested = new Map();
    for (const key of STATUS_REACTION_EMOJI_KEYS) {
        const requested = normalizeEmoji(emojis[key]);
        if (!requested) {
            continue;
        }
        const fallbackVariants = TELEGRAM_STATUS_REACTION_VARIANTS[key] ?? [];
        const candidates = toUniqueNonEmpty([requested, ...fallbackVariants]);
        variantsByRequested.set(requested, candidates);
    }
    return variantsByRequested;
}
export function isTelegramSupportedReactionEmoji(emoji) {
    return TELEGRAM_SUPPORTED_REACTION_EMOJIS.has(emoji);
}
export function extractTelegramAllowedEmojiReactions(chat) {
    if (!chat || typeof chat !== "object") {
        return undefined;
    }
    if (!Object.prototype.hasOwnProperty.call(chat, "available_reactions")) {
        return undefined;
    }
    const availableReactions = chat.available_reactions;
    if (availableReactions == null) {
        // Explicitly omitted/null => all emoji reactions are allowed in this chat.
        return null;
    }
    if (!Array.isArray(availableReactions)) {
        return new Set();
    }
    const allowed = new Set();
    for (const reaction of availableReactions) {
        if (!reaction || typeof reaction !== "object") {
            continue;
        }
        const typedReaction = reaction;
        if (typedReaction.type !== "emoji" || typeof typedReaction.emoji !== "string") {
            continue;
        }
        const emoji = typedReaction.emoji.trim();
        if (emoji) {
            allowed.add(emoji);
        }
    }
    return allowed;
}
export async function resolveTelegramAllowedEmojiReactions(params) {
    const fromMessage = extractTelegramAllowedEmojiReactions(params.chat);
    if (fromMessage !== undefined) {
        return fromMessage;
    }
    if (params.getChat) {
        try {
            const chatInfo = await params.getChat(params.chatId);
            const fromLookup = extractTelegramAllowedEmojiReactions(chatInfo);
            if (fromLookup !== undefined) {
                return fromLookup;
            }
        }
        catch {
            return null;
        }
    }
    // If unavailable, assume no explicit restriction.
    return null;
}
export function resolveTelegramReactionVariant(params) {
    const requestedEmoji = normalizeEmoji(params.requestedEmoji);
    if (!requestedEmoji) {
        return undefined;
    }
    const configuredVariants = params.variantsByRequestedEmoji.get(requestedEmoji) ?? [
        requestedEmoji,
    ];
    const variants = toUniqueNonEmpty([
        ...configuredVariants,
        ...TELEGRAM_GENERIC_REACTION_FALLBACKS,
    ]);
    for (const candidate of variants) {
        const isAllowedByChat = params.allowedEmojiReactions == null || params.allowedEmojiReactions.has(candidate);
        if (isAllowedByChat && isTelegramSupportedReactionEmoji(candidate)) {
            return candidate;
        }
    }
    return undefined;
}
