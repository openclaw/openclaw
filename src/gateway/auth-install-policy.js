import { collectDurableServiceEnvVars } from "../config/state-dir-dotenv.js";
import { hasConfiguredSecretInput } from "../config/types.secrets.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
function hasExplicitGatewayInstallAuthMode(mode) {
    if (mode === "token") {
        return true;
    }
    if (mode === "password" || mode === "none" || mode === "trusted-proxy") {
        return false;
    }
    return undefined;
}
function hasConfiguredGatewayPasswordForInstall(cfg) {
    return hasConfiguredSecretInput(cfg.gateway?.auth?.password, cfg.secrets?.defaults);
}
function hasDurableGatewayPasswordEnvForInstall(cfg, env) {
    const durableServiceEnv = collectDurableServiceEnvVars({ env, config: cfg });
    return Boolean(normalizeOptionalString(durableServiceEnv.OPENCLAW_GATEWAY_PASSWORD) ||
        normalizeOptionalString(durableServiceEnv.CLAWDBOT_GATEWAY_PASSWORD));
}
export function shouldRequireGatewayTokenForInstall(cfg, env) {
    const explicitModeDecision = hasExplicitGatewayInstallAuthMode(cfg.gateway?.auth?.mode);
    if (explicitModeDecision !== undefined) {
        return explicitModeDecision;
    }
    if (hasConfiguredGatewayPasswordForInstall(cfg)) {
        return false;
    }
    // Service install should only infer password mode from durable sources that
    // survive outside the invoking shell.
    if (hasDurableGatewayPasswordEnvForInstall(cfg, env)) {
        return false;
    }
    return true;
}
