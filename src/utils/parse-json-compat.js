import JSON5 from "json5";
export function parseJsonWithJson5Fallback(raw) {
    try {
        return JSON.parse(raw);
    }
    catch {
        return JSON5.parse(raw);
    }
}
