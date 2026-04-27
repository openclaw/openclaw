import { resolveGatewayCredentialsWithSecretInputs } from "./credentials-secret-inputs.js";
import { resolveGatewayCredentialsFromConfig } from "./credentials.js";
function toGatewayCredentialOptions(params) {
    return {
        cfg: params.cfg,
        env: params.env,
        explicitAuth: params.explicitAuth,
        urlOverride: params.urlOverride,
        urlOverrideSource: params.urlOverrideSource,
        modeOverride: params.modeOverride,
        localTokenPrecedence: params.localTokenPrecedence,
        localPasswordPrecedence: params.localPasswordPrecedence,
        remoteTokenPrecedence: params.remoteTokenPrecedence,
        remotePasswordPrecedence: params.remotePasswordPrecedence,
        remoteTokenFallback: params.remoteTokenFallback,
        remotePasswordFallback: params.remotePasswordFallback,
    };
}
export async function resolveGatewayConnectionAuth(params) {
    return await resolveGatewayCredentialsWithSecretInputs({
        config: params.config,
        ...toGatewayCredentialOptions({ ...params, cfg: params.config }),
    });
}
export function resolveGatewayConnectionAuthFromConfig(params) {
    return resolveGatewayCredentialsFromConfig(toGatewayCredentialOptions(params));
}
