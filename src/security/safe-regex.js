const SAFE_REGEX_CACHE_MAX = 256;
const SAFE_REGEX_TEST_WINDOW = 2048;
const safeRegexCache = new Map();
function createParseFrame() {
    return {
        lastToken: null,
        containsRepetition: false,
        hasAlternation: false,
        branchMinLength: 0,
        branchMaxLength: 0,
        altMinLength: null,
        altMaxLength: null,
    };
}
function addLength(left, right) {
    if (!Number.isFinite(left) || !Number.isFinite(right)) {
        return Number.POSITIVE_INFINITY;
    }
    return left + right;
}
function multiplyLength(length, factor) {
    if (!Number.isFinite(length)) {
        return factor === 0 ? 0 : Number.POSITIVE_INFINITY;
    }
    return length * factor;
}
function recordAlternative(frame) {
    if (frame.altMinLength === null || frame.altMaxLength === null) {
        frame.altMinLength = frame.branchMinLength;
        frame.altMaxLength = frame.branchMaxLength;
        return;
    }
    frame.altMinLength = Math.min(frame.altMinLength, frame.branchMinLength);
    frame.altMaxLength = Math.max(frame.altMaxLength, frame.branchMaxLength);
}
function readQuantifier(source, index) {
    const ch = source[index];
    const consumed = source[index + 1] === "?" ? 2 : 1;
    if (ch === "*") {
        return { consumed, minRepeat: 0, maxRepeat: null };
    }
    if (ch === "+") {
        return { consumed, minRepeat: 1, maxRepeat: null };
    }
    if (ch === "?") {
        return { consumed, minRepeat: 0, maxRepeat: 1 };
    }
    if (ch !== "{") {
        return null;
    }
    let i = index + 1;
    while (i < source.length && /\d/.test(source[i])) {
        i += 1;
    }
    if (i === index + 1) {
        return null;
    }
    const minRepeat = Number.parseInt(source.slice(index + 1, i), 10);
    let maxRepeat = minRepeat;
    if (source[i] === ",") {
        i += 1;
        const maxStart = i;
        while (i < source.length && /\d/.test(source[i])) {
            i += 1;
        }
        maxRepeat = i === maxStart ? null : Number.parseInt(source.slice(maxStart, i), 10);
    }
    if (source[i] !== "}") {
        return null;
    }
    i += 1;
    if (source[i] === "?") {
        i += 1;
    }
    if (maxRepeat !== null && maxRepeat < minRepeat) {
        return null;
    }
    return { consumed: i - index, minRepeat, maxRepeat };
}
function tokenizePattern(source) {
    const tokens = [];
    let inCharClass = false;
    for (let i = 0; i < source.length; i += 1) {
        const ch = source[i];
        if (ch === "\\") {
            i += 1;
            tokens.push({ kind: "simple-token" });
            continue;
        }
        if (inCharClass) {
            if (ch === "]") {
                inCharClass = false;
            }
            continue;
        }
        if (ch === "[") {
            inCharClass = true;
            tokens.push({ kind: "simple-token" });
            continue;
        }
        if (ch === "(") {
            tokens.push({ kind: "group-open" });
            continue;
        }
        if (ch === ")") {
            tokens.push({ kind: "group-close" });
            continue;
        }
        if (ch === "|") {
            tokens.push({ kind: "alternation" });
            continue;
        }
        const quantifier = readQuantifier(source, i);
        if (quantifier) {
            tokens.push({ kind: "quantifier", quantifier });
            i += quantifier.consumed - 1;
            continue;
        }
        tokens.push({ kind: "simple-token" });
    }
    return tokens;
}
function analyzeTokensForNestedRepetition(tokens) {
    const frames = [createParseFrame()];
    const emitToken = (token) => {
        const frame = frames[frames.length - 1];
        frame.lastToken = token;
        if (token.containsRepetition) {
            frame.containsRepetition = true;
        }
        frame.branchMinLength = addLength(frame.branchMinLength, token.minLength);
        frame.branchMaxLength = addLength(frame.branchMaxLength, token.maxLength);
    };
    const emitSimpleToken = () => {
        emitToken({
            containsRepetition: false,
            hasAmbiguousAlternation: false,
            minLength: 1,
            maxLength: 1,
        });
    };
    for (const token of tokens) {
        if (token.kind === "simple-token") {
            emitSimpleToken();
            continue;
        }
        if (token.kind === "group-open") {
            frames.push(createParseFrame());
            continue;
        }
        if (token.kind === "group-close") {
            if (frames.length > 1) {
                const frame = frames.pop();
                if (frame.hasAlternation) {
                    recordAlternative(frame);
                }
                const groupMinLength = frame.hasAlternation
                    ? (frame.altMinLength ?? 0)
                    : frame.branchMinLength;
                const groupMaxLength = frame.hasAlternation
                    ? (frame.altMaxLength ?? 0)
                    : frame.branchMaxLength;
                emitToken({
                    containsRepetition: frame.containsRepetition,
                    hasAmbiguousAlternation: frame.hasAlternation &&
                        frame.altMinLength !== null &&
                        frame.altMaxLength !== null &&
                        frame.altMinLength !== frame.altMaxLength,
                    minLength: groupMinLength,
                    maxLength: groupMaxLength,
                });
            }
            continue;
        }
        if (token.kind === "alternation") {
            const frame = frames[frames.length - 1];
            frame.hasAlternation = true;
            recordAlternative(frame);
            frame.branchMinLength = 0;
            frame.branchMaxLength = 0;
            frame.lastToken = null;
            continue;
        }
        const frame = frames[frames.length - 1];
        const previousToken = frame.lastToken;
        if (!previousToken) {
            continue;
        }
        if (previousToken.containsRepetition) {
            return true;
        }
        if (previousToken.hasAmbiguousAlternation && token.quantifier.maxRepeat === null) {
            return true;
        }
        const previousMinLength = previousToken.minLength;
        const previousMaxLength = previousToken.maxLength;
        previousToken.minLength = multiplyLength(previousToken.minLength, token.quantifier.minRepeat);
        previousToken.maxLength =
            token.quantifier.maxRepeat === null
                ? Number.POSITIVE_INFINITY
                : multiplyLength(previousToken.maxLength, token.quantifier.maxRepeat);
        previousToken.containsRepetition = true;
        frame.containsRepetition = true;
        frame.branchMinLength = frame.branchMinLength - previousMinLength + previousToken.minLength;
        const branchMaxBase = Number.isFinite(frame.branchMaxLength) && Number.isFinite(previousMaxLength)
            ? frame.branchMaxLength - previousMaxLength
            : Number.POSITIVE_INFINITY;
        frame.branchMaxLength = addLength(branchMaxBase, previousToken.maxLength);
    }
    return false;
}
function testRegexFromStart(regex, value) {
    regex.lastIndex = 0;
    return regex.test(value);
}
export function testRegexWithBoundedInput(regex, input, maxWindow = SAFE_REGEX_TEST_WINDOW) {
    if (maxWindow <= 0) {
        return false;
    }
    if (input.length <= maxWindow) {
        return testRegexFromStart(regex, input);
    }
    const head = input.slice(0, maxWindow);
    if (testRegexFromStart(regex, head)) {
        return true;
    }
    return testRegexFromStart(regex, input.slice(-maxWindow));
}
export function hasNestedRepetition(source) {
    // Conservative parser: tokenize first, then check if repeated tokens/groups are repeated again.
    // Non-goal: complete regex AST support; keep strict enough for config safety checks.
    return analyzeTokensForNestedRepetition(tokenizePattern(source));
}
export function compileSafeRegex(source, flags = "") {
    const trimmed = source.trim();
    if (!trimmed) {
        return null;
    }
    const cacheKey = `${flags}::${trimmed}`;
    if (safeRegexCache.has(cacheKey)) {
        return safeRegexCache.get(cacheKey) ?? null;
    }
    let compiled = null;
    if (!hasNestedRepetition(trimmed)) {
        try {
            compiled = new RegExp(trimmed, flags);
        }
        catch {
            compiled = null;
        }
    }
    safeRegexCache.set(cacheKey, compiled);
    if (safeRegexCache.size > SAFE_REGEX_CACHE_MAX) {
        const oldestKey = safeRegexCache.keys().next().value;
        if (oldestKey) {
            safeRegexCache.delete(oldestKey);
        }
    }
    return compiled;
}
