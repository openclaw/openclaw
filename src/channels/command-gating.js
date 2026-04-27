export function resolveCommandAuthorizedFromAuthorizers(params) {
    const { useAccessGroups, authorizers } = params;
    const mode = params.modeWhenAccessGroupsOff ?? "allow";
    if (!useAccessGroups) {
        if (mode === "allow") {
            return true;
        }
        if (mode === "deny") {
            return false;
        }
        const anyConfigured = authorizers.some((entry) => entry.configured);
        if (!anyConfigured) {
            return true;
        }
        return authorizers.some((entry) => entry.configured && entry.allowed);
    }
    return authorizers.some((entry) => entry.configured && entry.allowed);
}
export function resolveControlCommandGate(params) {
    const commandAuthorized = resolveCommandAuthorizedFromAuthorizers({
        useAccessGroups: params.useAccessGroups,
        authorizers: params.authorizers,
        modeWhenAccessGroupsOff: params.modeWhenAccessGroupsOff,
    });
    const shouldBlock = params.allowTextCommands && params.hasControlCommand && !commandAuthorized;
    return { commandAuthorized, shouldBlock };
}
export function resolveDualTextControlCommandGate(params) {
    return resolveControlCommandGate({
        useAccessGroups: params.useAccessGroups,
        authorizers: [
            { configured: params.primaryConfigured, allowed: params.primaryAllowed },
            { configured: params.secondaryConfigured, allowed: params.secondaryAllowed },
        ],
        allowTextCommands: true,
        hasControlCommand: params.hasControlCommand,
        modeWhenAccessGroupsOff: params.modeWhenAccessGroupsOff,
    });
}
