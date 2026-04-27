export function buildAgentTraceBase(params) {
    return {
        runId: params.runId,
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        provider: params.provider,
        modelId: params.modelId,
        modelApi: params.modelApi,
        workspaceDir: params.workspaceDir,
    };
}
