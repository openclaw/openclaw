import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
export function parseKeyValueOutput(output, separator) {
    const entries = {};
    for (const rawLine of output.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line) {
            continue;
        }
        const idx = line.indexOf(separator);
        if (idx <= 0) {
            continue;
        }
        const key = normalizeLowercaseStringOrEmpty(line.slice(0, idx));
        if (!key) {
            continue;
        }
        const value = line.slice(idx + separator.length).trim();
        entries[key] = value;
    }
    return entries;
}
