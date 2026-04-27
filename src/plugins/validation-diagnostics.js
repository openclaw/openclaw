export function pushPluginValidationDiagnostic(params) {
    params.pushDiagnostic({
        level: params.level,
        pluginId: params.pluginId,
        source: params.source,
        message: params.message,
    });
}
