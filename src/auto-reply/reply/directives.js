import { escapeRegExp } from "../../utils.js";
import { normalizeElevatedLevel, normalizeNoticeLevel, normalizeReasoningLevel, normalizeThinkLevel, normalizeVerboseLevel, } from "../thinking.js";
const matchLevelDirective = (body, names) => {
    const namePattern = names.map(escapeRegExp).join("|");
    const match = body.match(new RegExp(`(?:^|\\s)\\/(?:${namePattern})(?=$|\\s|:)`, "i"));
    if (!match || match.index === undefined) {
        return null;
    }
    const start = match.index;
    let end = match.index + match[0].length;
    let i = end;
    while (i < body.length && /\s/.test(body[i])) {
        i += 1;
    }
    if (body[i] === ":") {
        i += 1;
        while (i < body.length && /\s/.test(body[i])) {
            i += 1;
        }
    }
    const argStart = i;
    while (i < body.length && /[A-Za-z-]/.test(body[i])) {
        i += 1;
    }
    const rawLevel = i > argStart ? body.slice(argStart, i) : undefined;
    end = i;
    return { start, end, rawLevel };
};
const extractLevelDirective = (body, names, normalize) => {
    const match = matchLevelDirective(body, names);
    if (!match) {
        return { cleaned: body.trim(), hasDirective: false };
    }
    const rawLevel = match.rawLevel;
    const level = normalize(rawLevel);
    const cleaned = body
        .slice(0, match.start)
        .concat(" ")
        .concat(body.slice(match.end))
        .replace(/\s+/g, " ")
        .trim();
    return {
        cleaned,
        level,
        rawLevel,
        hasDirective: true,
    };
};
const extractSimpleDirective = (body, names) => {
    const namePattern = names.map(escapeRegExp).join("|");
    const match = body.match(new RegExp(`(?:^|\\s)\\/(?:${namePattern})(?=$|\\s|:)(?:\\s*:\\s*)?`, "i"));
    const cleaned = match ? body.replace(match[0], " ").replace(/\s+/g, " ").trim() : body.trim();
    return {
        cleaned,
        hasDirective: Boolean(match),
    };
};
export function extractThinkDirective(body) {
    if (!body) {
        return { cleaned: "", hasDirective: false };
    }
    const extracted = extractLevelDirective(body, ["thinking", "think", "t"], normalizeThinkLevel);
    return {
        cleaned: extracted.cleaned,
        thinkLevel: extracted.level,
        rawLevel: extracted.rawLevel,
        hasDirective: extracted.hasDirective,
    };
}
export function extractVerboseDirective(body) {
    if (!body) {
        return { cleaned: "", hasDirective: false };
    }
    const extracted = extractLevelDirective(body, ["verbose", "v"], normalizeVerboseLevel);
    return {
        cleaned: extracted.cleaned,
        verboseLevel: extracted.level,
        rawLevel: extracted.rawLevel,
        hasDirective: extracted.hasDirective,
    };
}
export function extractNoticeDirective(body) {
    if (!body) {
        return { cleaned: "", hasDirective: false };
    }
    const extracted = extractLevelDirective(body, ["notice", "notices"], normalizeNoticeLevel);
    return {
        cleaned: extracted.cleaned,
        noticeLevel: extracted.level,
        rawLevel: extracted.rawLevel,
        hasDirective: extracted.hasDirective,
    };
}
export function extractElevatedDirective(body) {
    if (!body) {
        return { cleaned: "", hasDirective: false };
    }
    const extracted = extractLevelDirective(body, ["elevated", "elev"], normalizeElevatedLevel);
    return {
        cleaned: extracted.cleaned,
        elevatedLevel: extracted.level,
        rawLevel: extracted.rawLevel,
        hasDirective: extracted.hasDirective,
    };
}
export function extractReasoningDirective(body) {
    if (!body) {
        return { cleaned: "", hasDirective: false };
    }
    const extracted = extractLevelDirective(body, ["reasoning", "reason"], normalizeReasoningLevel);
    return {
        cleaned: extracted.cleaned,
        reasoningLevel: extracted.level,
        rawLevel: extracted.rawLevel,
        hasDirective: extracted.hasDirective,
    };
}
export function extractStatusDirective(body) {
    if (!body) {
        return { cleaned: "", hasDirective: false };
    }
    return extractSimpleDirective(body, ["status"]);
}
export { extractExecDirective } from "./exec/directive.js";
