import { parseExecArgvToken } from "./exec-approvals-analysis.js";
import { buildLongFlagPrefixMap, collectKnownLongFlags, } from "./exec-safe-bin-policy-profiles.js";
function isPathLikeToken(value) {
    const trimmed = value.trim();
    if (!trimmed) {
        return false;
    }
    if (trimmed === "-") {
        return false;
    }
    if (trimmed.startsWith("./") || trimmed.startsWith("../") || trimmed.startsWith("~")) {
        return true;
    }
    if (trimmed.startsWith("/")) {
        return true;
    }
    return /^[A-Za-z]:[\\/]/.test(trimmed);
}
function hasGlobToken(value) {
    // Safe bins are stdin-only; globbing is both surprising and a historical bypass vector.
    // Note: we still harden execution-time expansion separately.
    return /[*?[\]]/.test(value);
}
const NO_FLAGS = new Set();
function isSafeLiteralToken(value) {
    if (!value || value === "-") {
        return true;
    }
    return !hasGlobToken(value) && !isPathLikeToken(value);
}
function isInvalidValueToken(value) {
    return !value || !isSafeLiteralToken(value);
}
function resolveCanonicalLongFlag(params) {
    if (!params.flag.startsWith("--") || params.flag.length <= 2) {
        return null;
    }
    if (params.knownLongFlagsSet.has(params.flag)) {
        return params.flag;
    }
    return params.longFlagPrefixMap.get(params.flag) ?? null;
}
function consumeLongOptionToken(params) {
    const canonicalFlag = resolveCanonicalLongFlag({
        flag: params.flag,
        knownLongFlagsSet: params.knownLongFlagsSet,
        longFlagPrefixMap: params.longFlagPrefixMap,
    });
    if (!canonicalFlag) {
        return -1;
    }
    if (params.deniedFlags.has(canonicalFlag)) {
        return -1;
    }
    const expectsValue = params.allowedValueFlags.has(canonicalFlag);
    if (params.inlineValue !== undefined) {
        if (!expectsValue) {
            return -1;
        }
        return isSafeLiteralToken(params.inlineValue) ? params.index + 1 : -1;
    }
    if (!expectsValue) {
        return params.index + 1;
    }
    return isInvalidValueToken(params.args[params.index + 1]) ? -1 : params.index + 2;
}
function consumeShortOptionClusterToken(params) {
    for (let j = 0; j < params.flags.length; j += 1) {
        const flag = params.flags[j];
        if (params.deniedFlags.has(flag)) {
            return -1;
        }
        if (!params.allowedValueFlags.has(flag)) {
            continue;
        }
        const inlineValue = params.cluster.slice(j + 1);
        if (inlineValue) {
            return isSafeLiteralToken(inlineValue) ? params.index + 1 : -1;
        }
        return isInvalidValueToken(params.args[params.index + 1]) ? -1 : params.index + 2;
    }
    return -1;
}
function consumePositionalToken(token, positional) {
    if (!isSafeLiteralToken(token)) {
        return false;
    }
    positional.push(token);
    return true;
}
function validatePositionalCount(positional, profile) {
    const minPositional = profile.minPositional ?? 0;
    if (positional.length < minPositional) {
        return false;
    }
    return typeof profile.maxPositional !== "number" || positional.length <= profile.maxPositional;
}
export function validateSafeBinArgv(args, profile) {
    const allowedValueFlags = profile.allowedValueFlags ?? NO_FLAGS;
    const deniedFlags = profile.deniedFlags ?? NO_FLAGS;
    const knownLongFlags = profile.knownLongFlags ?? collectKnownLongFlags(allowedValueFlags, deniedFlags);
    const knownLongFlagsSet = profile.knownLongFlagsSet ?? new Set(knownLongFlags);
    const longFlagPrefixMap = profile.longFlagPrefixMap ?? buildLongFlagPrefixMap(knownLongFlags);
    const positional = [];
    let i = 0;
    while (i < args.length) {
        const rawToken = args[i] ?? "";
        const token = parseExecArgvToken(rawToken);
        if (token.kind === "empty" || token.kind === "stdin") {
            i += 1;
            continue;
        }
        if (token.kind === "terminator") {
            for (let j = i + 1; j < args.length; j += 1) {
                const rest = args[j];
                if (!rest || rest === "-") {
                    continue;
                }
                if (!consumePositionalToken(rest, positional)) {
                    return false;
                }
            }
            break;
        }
        if (token.kind === "positional") {
            if (!consumePositionalToken(token.raw, positional)) {
                return false;
            }
            i += 1;
            continue;
        }
        if (token.style === "long") {
            const nextIndex = consumeLongOptionToken({
                args,
                index: i,
                flag: token.flag,
                inlineValue: token.inlineValue,
                allowedValueFlags,
                deniedFlags,
                knownLongFlagsSet,
                longFlagPrefixMap,
            });
            if (nextIndex < 0) {
                return false;
            }
            i = nextIndex;
            continue;
        }
        const nextIndex = consumeShortOptionClusterToken({
            args,
            index: i,
            cluster: token.cluster,
            flags: token.flags,
            allowedValueFlags,
            deniedFlags,
        });
        if (nextIndex < 0) {
            return false;
        }
        i = nextIndex;
    }
    return validatePositionalCount(positional, profile);
}
