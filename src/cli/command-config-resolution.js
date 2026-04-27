import { applyPluginAutoEnable } from "../config/plugin-auto-enable.js";
import { resolveCommandSecretRefsViaGateway, } from "./command-secret-gateway.js";
export async function resolveCommandConfigWithSecrets(params) {
    const { resolvedConfig, diagnostics } = await resolveCommandSecretRefsViaGateway({
        config: params.config,
        commandName: params.commandName,
        targetIds: params.targetIds,
        ...(params.mode ? { mode: params.mode } : {}),
        ...(params.allowedPaths ? { allowedPaths: params.allowedPaths } : {}),
    });
    if (params.runtime) {
        for (const entry of diagnostics) {
            params.runtime.log(`[secrets] ${entry}`);
        }
    }
    const effectiveConfig = params.autoEnable
        ? applyPluginAutoEnable({
            config: resolvedConfig,
            env: params.env ?? process.env,
        }).config
        : resolvedConfig;
    return {
        resolvedConfig: resolvedConfig,
        effectiveConfig: effectiveConfig,
        diagnostics,
    };
}
