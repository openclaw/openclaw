export async function resolveCurrentDirectiveLevels(params) {
    const resolvedDefaultThinkLevel = params.sessionEntry?.thinkingLevel ??
        (await params.resolveDefaultThinkingLevel()) ??
        params.agentCfg?.thinkingDefault;
    const currentThinkLevel = resolvedDefaultThinkLevel;
    const currentFastMode = typeof params.sessionEntry?.fastMode === "boolean"
        ? params.sessionEntry.fastMode
        : typeof params.agentEntry?.fastModeDefault === "boolean"
            ? params.agentEntry.fastModeDefault
            : undefined;
    const currentVerboseLevel = params.sessionEntry?.verboseLevel ??
        params.agentCfg?.verboseDefault;
    const currentReasoningLevel = params.sessionEntry?.reasoningLevel ??
        params.agentEntry?.reasoningDefault ??
        "off";
    const currentElevatedLevel = params.sessionEntry?.elevatedLevel ??
        params.agentCfg?.elevatedDefault;
    return {
        currentThinkLevel,
        currentFastMode,
        currentVerboseLevel,
        currentReasoningLevel,
        currentElevatedLevel,
    };
}
