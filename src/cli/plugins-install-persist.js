import { replaceConfigFile } from "../config/config.js";
import { recordHookInstall } from "../hooks/installs.js";
import { enablePluginInConfig } from "../plugins/enable.js";
import { loadPluginInstallRecords, PLUGIN_INSTALLS_CONFIG_PATH, recordPluginInstallInRecords, withoutPluginInstallRecords, writePersistedPluginInstallLedger, } from "../plugins/install-ledger-store.js";
import { defaultRuntime } from "../runtime.js";
import { theme } from "../terminal/theme.js";
import { applySlotSelectionForPlugin, enableInternalHookEntries, logHookPackRestartHint, logSlotWarnings, } from "./plugins-command-helpers.js";
import { refreshPluginRegistryAfterConfigMutation } from "./plugins-registry-refresh.js";
function addInstalledPluginToAllowlist(cfg, pluginId) {
    const allow = cfg.plugins?.allow;
    if (!Array.isArray(allow) || allow.length === 0 || allow.includes(pluginId)) {
        return cfg;
    }
    return {
        ...cfg,
        plugins: {
            ...cfg.plugins,
            allow: [...allow, pluginId].toSorted(),
        },
    };
}
export async function persistPluginInstall(params) {
    let next = enablePluginInConfig(addInstalledPluginToAllowlist(params.config, params.pluginId), params.pluginId).config;
    const installRecords = await loadPluginInstallRecords({ config: params.config });
    const nextInstallRecords = recordPluginInstallInRecords(installRecords, {
        pluginId: params.pluginId,
        ...params.install,
    });
    const slotResult = applySlotSelectionForPlugin(next, params.pluginId);
    next = withoutPluginInstallRecords(slotResult.config);
    await writePersistedPluginInstallLedger(nextInstallRecords);
    await replaceConfigFile({
        nextConfig: next,
        ...(params.baseHash !== undefined ? { baseHash: params.baseHash } : {}),
        writeOptions: { unsetPaths: [Array.from(PLUGIN_INSTALLS_CONFIG_PATH)] },
    });
    await refreshPluginRegistryAfterConfigMutation({
        config: next,
        reason: "source-changed",
        logger: {
            warn: (message) => defaultRuntime.log(theme.warn(message)),
        },
    });
    logSlotWarnings(slotResult.warnings);
    if (params.warningMessage) {
        defaultRuntime.log(theme.warn(params.warningMessage));
    }
    defaultRuntime.log(params.successMessage ?? `Installed plugin: ${params.pluginId}`);
    defaultRuntime.log("Restart the gateway to load plugins.");
    return next;
}
export async function persistHookPackInstall(params) {
    let next = enableInternalHookEntries(params.config, params.hooks);
    next = recordHookInstall(next, {
        hookId: params.hookPackId,
        hooks: params.hooks,
        ...params.install,
    });
    await replaceConfigFile({
        nextConfig: next,
        ...(params.baseHash !== undefined ? { baseHash: params.baseHash } : {}),
    });
    defaultRuntime.log(params.successMessage ?? `Installed hook pack: ${params.hookPackId}`);
    logHookPackRestartHint();
    return next;
}
