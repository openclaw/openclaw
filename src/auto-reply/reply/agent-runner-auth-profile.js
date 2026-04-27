import { resolveProviderIdForAuth, } from "../../agents/provider-auth-aliases.js";
export function resolveProviderScopedAuthProfile(params) {
    const aliasParams = { config: params.config, workspaceDir: params.workspaceDir };
    const authProfileId = resolveProviderIdForAuth(params.provider, aliasParams) ===
        resolveProviderIdForAuth(params.primaryProvider, aliasParams)
        ? params.authProfileId
        : undefined;
    return {
        authProfileId,
        authProfileIdSource: authProfileId ? params.authProfileIdSource : undefined,
    };
}
export function resolveRunAuthProfile(run, provider, params) {
    return resolveProviderScopedAuthProfile({
        provider,
        primaryProvider: run.provider,
        authProfileId: run.authProfileId,
        authProfileIdSource: run.authProfileIdSource,
        config: params?.config ?? run.config,
        workspaceDir: run.workspaceDir,
    });
}
