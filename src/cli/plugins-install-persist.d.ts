import type { OpenClawConfig } from "../config/types.openclaw.js";
import { type HookInstallUpdate } from "../hooks/installs.js";
import type { PluginInstallUpdate } from "../plugins/installs.js";
export declare function persistPluginInstall(params: {
    config: OpenClawConfig;
    baseHash?: string;
    pluginId: string;
    install: Omit<PluginInstallUpdate, "pluginId">;
    successMessage?: string;
    warningMessage?: string;
}): Promise<OpenClawConfig>;
export declare function persistHookPackInstall(params: {
    config: OpenClawConfig;
    baseHash?: string;
    hookPackId: string;
    hooks: string[];
    install: Omit<HookInstallUpdate, "hookId" | "hooks">;
    successMessage?: string;
}): Promise<OpenClawConfig>;
