export async function resolveCurrentDirectiveLevels(params) {
    const resolvedDefaultThinkLevel = params.sessionEntry?.thinkingLevel ??
        (await params.resolveDefaultThinkingLevel()) ??
        params.agentCfg?.thinkingDefault;
    const currentThinkLevel = resolvedDefaultThinkLevel;
    const currentVerboseLevel = params.sessionEntry?.verboseLevel ??
        params.agentCfg?.verboseDefault;
    const currentReasoningLevel = params.sessionEntry?.reasoningLevel ?? "off";
    const currentElevatedLevel = params.sessionEntry?.elevatedLevel ??
        params.agentCfg?.elevatedDefault;
    return {
        currentThinkLevel,
        currentVerboseLevel,
        currentReasoningLevel,
        currentElevatedLevel,
    };
}
