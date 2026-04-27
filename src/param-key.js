import { lowercasePreservingWhitespace } from "./shared/string-coerce.js";
function toSnakeCaseKey(key) {
    const snakeKey = key
        .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
        .replace(/([a-z0-9])([A-Z])/g, "$1_$2");
    return lowercasePreservingWhitespace(snakeKey);
}
export function resolveSnakeCaseParamKey(params, key) {
    if (Object.hasOwn(params, key)) {
        return key;
    }
    const snakeKey = toSnakeCaseKey(key);
    if (snakeKey !== key && Object.hasOwn(params, snakeKey)) {
        return snakeKey;
    }
    return undefined;
}
export function readSnakeCaseParamRaw(params, key) {
    const resolvedKey = resolveSnakeCaseParamKey(params, key);
    if (resolvedKey) {
        return params[resolvedKey];
    }
    return undefined;
}
