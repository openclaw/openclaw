function formatTemplateValue(value) {
    if (value == null) {
        return "";
    }
    if (typeof value === "string") {
        return value;
    }
    if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
        return String(value);
    }
    if (typeof value === "symbol" || typeof value === "function") {
        return value.toString();
    }
    if (Array.isArray(value)) {
        return value
            .flatMap((entry) => {
            if (entry == null) {
                return [];
            }
            if (typeof entry === "string") {
                return [entry];
            }
            if (typeof entry === "number" || typeof entry === "boolean" || typeof entry === "bigint") {
                return [String(entry)];
            }
            return [];
        })
            .join(",");
    }
    if (typeof value === "object") {
        return "";
    }
    return "";
}
// Simple {{Placeholder}} interpolation using inbound message context.
export function applyTemplate(str, ctx) {
    if (!str) {
        return "";
    }
    return str.replace(/{{\s*(\w+)\s*}}/g, (_, key) => {
        const value = ctx[key];
        return formatTemplateValue(value);
    });
}
