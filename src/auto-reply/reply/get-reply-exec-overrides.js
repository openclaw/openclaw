export function resolveReplyExecOverrides(params) {
    const host = params.directives.execHost ??
        params.sessionEntry?.execHost ??
        params.agentExecDefaults?.host;
    const security = params.directives.execSecurity ??
        params.sessionEntry?.execSecurity ??
        params.agentExecDefaults?.security;
    const ask = params.directives.execAsk ??
        params.sessionEntry?.execAsk ??
        params.agentExecDefaults?.ask;
    const node = params.directives.execNode ?? params.sessionEntry?.execNode ?? params.agentExecDefaults?.node;
    if (!host && !security && !ask && !node) {
        return undefined;
    }
    return { host, security, ask, node };
}
