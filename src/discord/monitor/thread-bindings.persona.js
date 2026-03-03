import { SYSTEM_MARK } from "../../infra/system-message.js";
const THREAD_BINDING_PERSONA_MAX_CHARS = 80;
function normalizePersonaLabel(value) {
    if (!value) {
        return undefined;
    }
    const normalized = value.replace(/\s+/g, " ").trim();
    return normalized || undefined;
}
export function resolveThreadBindingPersona(params) {
    const base = normalizePersonaLabel(params.label) || normalizePersonaLabel(params.agentId) || "agent";
    return `${SYSTEM_MARK} ${base}`.slice(0, THREAD_BINDING_PERSONA_MAX_CHARS);
}
export function resolveThreadBindingPersonaFromRecord(record) {
    return resolveThreadBindingPersona({
        label: record.label,
        agentId: record.agentId,
    });
}
