export const INPUT_PROVENANCE_KIND_VALUES = [
    "external_user",
    "inter_session",
    "internal_system",
];
function normalizeOptionalString(value) {
    if (typeof value !== "string") {
        return undefined;
    }
    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
}
function isInputProvenanceKind(value) {
    return (typeof value === "string" && INPUT_PROVENANCE_KIND_VALUES.includes(value));
}
export function normalizeInputProvenance(value) {
    if (!value || typeof value !== "object") {
        return undefined;
    }
    const record = value;
    if (!isInputProvenanceKind(record.kind)) {
        return undefined;
    }
    return {
        kind: record.kind,
        sourceSessionKey: normalizeOptionalString(record.sourceSessionKey),
        sourceChannel: normalizeOptionalString(record.sourceChannel),
        sourceTool: normalizeOptionalString(record.sourceTool),
    };
}
export function applyInputProvenanceToUserMessage(message, inputProvenance) {
    if (!inputProvenance) {
        return message;
    }
    if (message.role !== "user") {
        return message;
    }
    const existing = normalizeInputProvenance(message.provenance);
    if (existing) {
        return message;
    }
    return {
        ...message,
        provenance: inputProvenance,
    };
}
export function isInterSessionInputProvenance(value) {
    return normalizeInputProvenance(value)?.kind === "inter_session";
}
export function hasInterSessionUserProvenance(message) {
    if (!message || message.role !== "user") {
        return false;
    }
    return isInterSessionInputProvenance(message.provenance);
}
