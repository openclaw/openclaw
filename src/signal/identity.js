import { normalizeE164 } from "../utils.js";
const UUID_HYPHENATED_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_COMPACT_RE = /^[0-9a-f]{32}$/i;
export function looksLikeUuid(value) {
    if (UUID_HYPHENATED_RE.test(value) || UUID_COMPACT_RE.test(value)) {
        return true;
    }
    const compact = value.replace(/-/g, "");
    if (!/^[0-9a-f]+$/i.test(compact)) {
        return false;
    }
    return /[a-f]/i.test(compact);
}
function stripSignalPrefix(value) {
    return value.replace(/^signal:/i, "").trim();
}
export function resolveSignalSender(params) {
    const sourceNumber = params.sourceNumber?.trim();
    if (sourceNumber) {
        return {
            kind: "phone",
            raw: sourceNumber,
            e164: normalizeE164(sourceNumber),
        };
    }
    const sourceUuid = params.sourceUuid?.trim();
    if (sourceUuid) {
        return { kind: "uuid", raw: sourceUuid };
    }
    return null;
}
export function formatSignalSenderId(sender) {
    return sender.kind === "phone" ? sender.e164 : `uuid:${sender.raw}`;
}
export function formatSignalSenderDisplay(sender) {
    return sender.kind === "phone" ? sender.e164 : `uuid:${sender.raw}`;
}
export function formatSignalPairingIdLine(sender) {
    if (sender.kind === "phone") {
        return `Your Signal number: ${sender.e164}`;
    }
    return `Your Signal sender id: ${formatSignalSenderId(sender)}`;
}
export function resolveSignalRecipient(sender) {
    return sender.kind === "phone" ? sender.e164 : sender.raw;
}
export function resolveSignalPeerId(sender) {
    return sender.kind === "phone" ? sender.e164 : `uuid:${sender.raw}`;
}
function parseSignalAllowEntry(entry) {
    const trimmed = entry.trim();
    if (!trimmed) {
        return null;
    }
    if (trimmed === "*") {
        return { kind: "any" };
    }
    const stripped = stripSignalPrefix(trimmed);
    const lower = stripped.toLowerCase();
    if (lower.startsWith("uuid:")) {
        const raw = stripped.slice("uuid:".length).trim();
        if (!raw) {
            return null;
        }
        return { kind: "uuid", raw };
    }
    if (looksLikeUuid(stripped)) {
        return { kind: "uuid", raw: stripped };
    }
    return { kind: "phone", e164: normalizeE164(stripped) };
}
export function isSignalSenderAllowed(sender, allowFrom) {
    if (allowFrom.length === 0) {
        return false;
    }
    const parsed = allowFrom
        .map(parseSignalAllowEntry)
        .filter((entry) => entry !== null);
    if (parsed.some((entry) => entry.kind === "any")) {
        return true;
    }
    return parsed.some((entry) => {
        if (entry.kind === "phone" && sender.kind === "phone") {
            return entry.e164 === sender.e164;
        }
        if (entry.kind === "uuid" && sender.kind === "uuid") {
            return entry.raw === sender.raw;
        }
        return false;
    });
}
export function isSignalGroupAllowed(params) {
    const { groupPolicy, allowFrom, sender } = params;
    if (groupPolicy === "disabled") {
        return false;
    }
    if (groupPolicy === "open") {
        return true;
    }
    if (allowFrom.length === 0) {
        return false;
    }
    return isSignalSenderAllowed(sender, allowFrom);
}
