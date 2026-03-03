import { formatCliCommand } from "../../cli/command-format.js";
import { SYSTEM_MARK, prefixSystemMessage } from "../../infra/system-message.js";
export const formatDirectiveAck = (text) => {
    return prefixSystemMessage(text);
};
export const formatOptionsLine = (options) => `Options: ${options}.`;
export const withOptions = (line, options) => `${line}\n${formatOptionsLine(options)}`;
export const formatElevatedRuntimeHint = () => `${SYSTEM_MARK} Runtime is direct; sandboxing does not apply.`;
export const formatElevatedEvent = (level) => {
    if (level === "full") {
        return "Elevated FULL — exec runs on host with auto-approval.";
    }
    if (level === "ask" || level === "on") {
        return "Elevated ASK — exec runs on host; approvals may still apply.";
    }
    return "Elevated OFF — exec stays in sandbox.";
};
export const formatReasoningEvent = (level) => {
    if (level === "stream") {
        return "Reasoning STREAM — emit live <think>.";
    }
    if (level === "on") {
        return "Reasoning ON — include <think>.";
    }
    return "Reasoning OFF — hide <think>.";
};
export function enqueueModeSwitchEvents(params) {
    if (params.elevatedChanged) {
        const nextElevated = (params.sessionEntry.elevatedLevel ?? "off");
        params.enqueueSystemEvent(formatElevatedEvent(nextElevated), {
            sessionKey: params.sessionKey,
            contextKey: "mode:elevated",
        });
    }
    if (params.reasoningChanged) {
        const nextReasoning = (params.sessionEntry.reasoningLevel ?? "off");
        params.enqueueSystemEvent(formatReasoningEvent(nextReasoning), {
            sessionKey: params.sessionKey,
            contextKey: "mode:reasoning",
        });
    }
}
export function formatElevatedUnavailableText(params) {
    const lines = [];
    lines.push(`elevated is not available right now (runtime=${params.runtimeSandboxed ? "sandboxed" : "direct"}).`);
    const failures = params.failures ?? [];
    if (failures.length > 0) {
        lines.push(`Failing gates: ${failures.map((f) => `${f.gate} (${f.key})`).join(", ")}`);
    }
    else {
        lines.push("Fix-it keys: tools.elevated.enabled, tools.elevated.allowFrom.<provider>, agents.list[].tools.elevated.*");
    }
    if (params.sessionKey) {
        lines.push(`See: ${formatCliCommand(`openclaw sandbox explain --session ${params.sessionKey}`)}`);
    }
    return lines.join("\n");
}
