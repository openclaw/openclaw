import { normalizeToolName } from "./tool-policy.js";
export function collectExplicitToolAllowlistSources(sources) {
    return sources.flatMap((source) => {
        const entries = (source.allow ?? []).map((entry) => entry.trim()).filter(Boolean);
        return entries.length ? [{ label: source.label, entries }] : [];
    });
}
export function buildEmptyExplicitToolAllowlistError(params) {
    const callableToolNames = params.callableToolNames.map(normalizeToolName).filter(Boolean);
    if (params.sources.length === 0 || callableToolNames.length > 0) {
        return null;
    }
    const requested = params.sources
        .map((source) => `${source.label}: ${source.entries.map(normalizeToolName).join(", ")}`)
        .join("; ");
    const reason = params.disableTools === true
        ? "tools are disabled for this run"
        : params.toolsEnabled
            ? "no registered tools matched"
            : "the selected model does not support tools";
    return new Error(`No callable tools remain after resolving explicit tool allowlist (${requested}); ${reason}. Fix the allowlist or enable the plugin that registers the requested tool.`);
}
