export const REDACT_REGEX_CHUNK_THRESHOLD = 32768;
export const REDACT_REGEX_CHUNK_SIZE = 16384;
export function replacePatternBounded(text, pattern, replacer, options) {
    const chunkThreshold = options?.chunkThreshold ?? REDACT_REGEX_CHUNK_THRESHOLD;
    const chunkSize = options?.chunkSize ?? REDACT_REGEX_CHUNK_SIZE;
    if (chunkThreshold <= 0 || chunkSize <= 0 || text.length <= chunkThreshold) {
        return text.replace(pattern, replacer);
    }
    let output = "";
    for (let index = 0; index < text.length; index += chunkSize) {
        output += text.slice(index, index + chunkSize).replace(pattern, replacer);
    }
    return output;
}
