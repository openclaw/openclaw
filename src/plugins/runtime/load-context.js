import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { loadConfig } from "../../config/config.js";
import { applyPluginAutoEnable } from "../../config/plugin-auto-enable.js";
import { createSubsystemLogger } from "../../logging.js";
import { resolvePluginActivationSourceConfig } from "../activation-source-config.js";
const log = createSubsystemLogger("plugins");
export function createPluginRuntimeLoaderLogger() {
    return {
        info: (message) => log.info(message),
        warn: (message) => log.warn(message),
        error: (message) => log.error(message),
        debug: (message) => log.debug(message),
    };
}
export function resolvePluginRuntimeLoadContext(options) {
    const env = options?.env ?? process.env;
    const rawConfig = options?.config ?? loadConfig();
    const activationSourceConfig = resolvePluginActivationSourceConfig({
        config: rawConfig,
        activationSourceConfig: options?.activationSourceConfig,
    });
    const autoEnabled = applyPluginAutoEnable({ config: rawConfig, env });
    const config = autoEnabled.config;
    const workspaceDir = options?.workspaceDir ?? resolveAgentWorkspaceDir(config, resolveDefaultAgentId(config));
    return {
        rawConfig,
        config,
        activationSourceConfig,
        autoEnabledReasons: autoEnabled.autoEnabledReasons,
        workspaceDir,
        env,
        logger: options?.logger ?? createPluginRuntimeLoaderLogger(),
    };
}
export function buildPluginRuntimeLoadOptions(context, overrides) {
    return buildPluginRuntimeLoadOptionsFromValues(context, overrides);
}
export function buildPluginRuntimeLoadOptionsFromValues(values, overrides) {
    return {
        config: values.config,
        activationSourceConfig: values.activationSourceConfig,
        autoEnabledReasons: values.autoEnabledReasons,
        workspaceDir: values.workspaceDir,
        env: values.env,
        logger: values.logger,
        ...overrides,
    };
}
