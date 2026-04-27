import { normalizeOptionalString } from "../shared/string-coerce.js";
import { resolveGatewayCredentialsWithSecretInputs } from "./credentials-secret-inputs.js";
import { isGatewaySecretRefUnavailableError, resolveGatewayProbeCredentialsFromConfig, } from "./credentials.js";
export { resolveGatewayProbeTarget } from "./probe-target.js";
function buildGatewayProbeCredentialPolicy(params) {
    return {
        config: params.cfg,
        cfg: params.cfg,
        env: params.env,
        explicitAuth: params.explicitAuth,
        modeOverride: params.mode,
        mode: params.mode,
        remoteTokenFallback: "remote-only",
    };
}
function resolveExplicitProbeAuth(explicitAuth) {
    const token = normalizeOptionalString(explicitAuth?.token);
    const password = normalizeOptionalString(explicitAuth?.password);
    return { token, password };
}
function hasExplicitProbeAuth(auth) {
    return Boolean(auth.token || auth.password);
}
function buildUnresolvedProbeAuthWarning(path) {
    return `${path} SecretRef is unresolved in this command path; probing without configured auth credentials.`;
}
function resolveGatewayProbeWarning(error) {
    if (!isGatewaySecretRefUnavailableError(error)) {
        throw error;
    }
    return buildUnresolvedProbeAuthWarning(error.path);
}
export function resolveGatewayProbeAuth(params) {
    const policy = buildGatewayProbeCredentialPolicy(params);
    return resolveGatewayProbeCredentialsFromConfig(policy);
}
export async function resolveGatewayProbeAuthWithSecretInputs(params) {
    const policy = buildGatewayProbeCredentialPolicy(params);
    return await resolveGatewayCredentialsWithSecretInputs({
        config: policy.config,
        env: policy.env,
        explicitAuth: policy.explicitAuth,
        modeOverride: policy.modeOverride,
        remoteTokenFallback: policy.remoteTokenFallback,
    });
}
export async function resolveGatewayProbeAuthSafeWithSecretInputs(params) {
    const explicitAuth = resolveExplicitProbeAuth(params.explicitAuth);
    if (hasExplicitProbeAuth(explicitAuth)) {
        return {
            auth: explicitAuth,
        };
    }
    try {
        const auth = await resolveGatewayProbeAuthWithSecretInputs(params);
        return { auth };
    }
    catch (error) {
        return {
            auth: {},
            warning: resolveGatewayProbeWarning(error),
        };
    }
}
export function resolveGatewayProbeAuthSafe(params) {
    const explicitAuth = resolveExplicitProbeAuth(params.explicitAuth);
    if (hasExplicitProbeAuth(explicitAuth)) {
        return {
            auth: explicitAuth,
        };
    }
    try {
        return { auth: resolveGatewayProbeAuth(params) };
    }
    catch (error) {
        return {
            auth: {},
            warning: resolveGatewayProbeWarning(error),
        };
    }
}
