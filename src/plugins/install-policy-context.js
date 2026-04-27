export function createBeforeInstallHookPayload(params) {
    const event = {
        targetType: params.targetType,
        targetName: params.targetName,
        sourcePath: params.sourcePath,
        sourcePathKind: params.sourcePathKind,
        ...(params.origin ? { origin: params.origin } : {}),
        request: params.request,
        builtinScan: params.builtinScan,
        ...(params.skill ? { skill: params.skill } : {}),
        ...(params.plugin ? { plugin: params.plugin } : {}),
    };
    const ctx = {
        targetType: params.targetType,
        requestKind: params.request.kind,
        ...(params.origin ? { origin: params.origin } : {}),
    };
    return { event, ctx };
}
