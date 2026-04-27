import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
const MAX_ALLOWED_VALUES_HINT = 12;
const MAX_ALLOWED_VALUE_CHARS = 160;
function truncateHintText(text, limit) {
    if (text.length <= limit) {
        return text;
    }
    return `${text.slice(0, limit)}... (+${text.length - limit} chars)`;
}
function safeStringify(value) {
    try {
        const serialized = JSON.stringify(value);
        if (serialized !== undefined) {
            return serialized;
        }
    }
    catch {
        // Fall back to string coercion when value is not JSON-serializable.
    }
    return String(value);
}
function toAllowedValueLabel(value) {
    if (typeof value === "string") {
        return JSON.stringify(truncateHintText(value, MAX_ALLOWED_VALUE_CHARS));
    }
    return truncateHintText(safeStringify(value), MAX_ALLOWED_VALUE_CHARS);
}
function toAllowedValueValue(value) {
    if (typeof value === "string") {
        return value;
    }
    return safeStringify(value);
}
function toAllowedValueDedupKey(value) {
    if (value === null) {
        return "null:null";
    }
    const kind = typeof value;
    if (kind === "string") {
        return `string:${value}`;
    }
    return `${kind}:${safeStringify(value)}`;
}
export function summarizeAllowedValues(values) {
    if (values.length === 0) {
        return null;
    }
    const deduped = [];
    const seenValues = new Set();
    for (const item of values) {
        const dedupeKey = toAllowedValueDedupKey(item);
        if (seenValues.has(dedupeKey)) {
            continue;
        }
        seenValues.add(dedupeKey);
        deduped.push({
            value: toAllowedValueValue(item),
            label: toAllowedValueLabel(item),
        });
    }
    const shown = deduped.slice(0, MAX_ALLOWED_VALUES_HINT);
    const hiddenCount = deduped.length - shown.length;
    const formattedCore = shown.map((entry) => entry.label).join(", ");
    const formatted = hiddenCount > 0 ? `${formattedCore}, ... (+${hiddenCount} more)` : formattedCore;
    return {
        values: shown.map((entry) => entry.value),
        hiddenCount,
        formatted,
    };
}
function messageAlreadyIncludesAllowedValues(message) {
    const lower = normalizeLowercaseStringOrEmpty(message);
    return lower.includes("(allowed:") || lower.includes("expected one of");
}
export function appendAllowedValuesHint(message, summary) {
    if (messageAlreadyIncludesAllowedValues(message)) {
        return message;
    }
    return `${message} (allowed: ${summary.formatted})`;
}
