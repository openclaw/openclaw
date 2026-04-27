import { normalizeLowercaseStringOrEmpty } from "../../shared/string-coerce.js";
export function parseSlashCommandActionArgs(raw, slash) {
    const trimmed = raw.trim();
    const slashLower = normalizeLowercaseStringOrEmpty(slash);
    if (!normalizeLowercaseStringOrEmpty(trimmed).startsWith(slashLower)) {
        return { kind: "no-match" };
    }
    const rest = trimmed.slice(slash.length).trim();
    if (!rest) {
        return { kind: "empty" };
    }
    const match = rest.match(/^(\S+)(?:\s+([\s\S]+))?$/);
    if (!match) {
        return { kind: "invalid" };
    }
    const action = normalizeLowercaseStringOrEmpty(match[1]);
    const args = (match[2] ?? "").trim();
    return { kind: "parsed", action, args };
}
export function parseSlashCommandOrNull(raw, slash, opts) {
    const parsed = parseSlashCommandActionArgs(raw, slash);
    if (parsed.kind === "no-match") {
        return null;
    }
    if (parsed.kind === "invalid") {
        return { ok: false, message: opts.invalidMessage };
    }
    if (parsed.kind === "empty") {
        return { ok: true, action: opts.defaultAction ?? "show", args: "" };
    }
    return { ok: true, action: parsed.action, args: parsed.args };
}
