import type { ChannelId } from "../channels/plugins/types.public.js";
import type { NativeCommandsSetting } from "./types.js";
export { isCommandFlagEnabled, isRestartEnabled, type CommandFlagKey } from "./commands.flags.js";
export declare function resolveNativeSkillsEnabled(params: {
    providerId: ChannelId;
    providerSetting?: NativeCommandsSetting;
    globalSetting?: NativeCommandsSetting;
}): boolean;
export declare function resolveNativeCommandsEnabled(params: {
    providerId: ChannelId;
    providerSetting?: NativeCommandsSetting;
    globalSetting?: NativeCommandsSetting;
}): boolean;
export declare function isNativeCommandsExplicitlyDisabled(params: {
    providerSetting?: NativeCommandsSetting;
    globalSetting?: NativeCommandsSetting;
}): boolean;
