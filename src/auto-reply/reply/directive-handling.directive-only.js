import { stripMentions, stripStructuralPrefixes } from "./mentions.js";
export function isDirectiveOnly(params) {
    const { directives, cleanedBody, ctx, cfg, agentId, isGroup } = params;
    if (!directives.hasThinkDirective &&
        !directives.hasVerboseDirective &&
        !directives.hasTraceDirective &&
        !directives.hasFastDirective &&
        !directives.hasReasoningDirective &&
        !directives.hasElevatedDirective &&
        !directives.hasExecDirective &&
        !directives.hasModelDirective &&
        !directives.hasQueueDirective) {
        return false;
    }
    const stripped = stripStructuralPrefixes(cleanedBody ?? "");
    const noMentions = isGroup ? stripMentions(stripped, ctx, cfg, agentId) : stripped;
    return noMentions.length === 0;
}
