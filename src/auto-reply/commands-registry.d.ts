import type { SkillCommandSpec } from "../agents/skills.js";
import type { OpenClawConfig } from "../config/types.js";
import type { ChatCommandDefinition, CommandArgDefinition, CommandArgs, NativeCommandSpec, ShouldHandleTextCommandsParams } from "./commands-registry.types.js";
export { isCommandEnabled, listChatCommands, listChatCommandsForConfig, } from "./commands-registry-list.js";
export { getCommandDetection, maybeResolveTextAlias, normalizeCommandBody, resolveTextCommand, } from "./commands-registry-normalize.js";
export type { ChatCommandDefinition, CommandArgChoiceContext, CommandArgDefinition, CommandArgMenuSpec, CommandArgValues, CommandArgs, CommandDetection, CommandNormalizeOptions, CommandScope, CommandTier, NativeCommandSpec, ShouldHandleTextCommandsParams, } from "./commands-registry.types.js";
type NativeCommandProviderLookupOptions = {
    includeBundledChannelFallback?: boolean;
};
export declare function listNativeCommandSpecs(params?: {
    skillCommands?: SkillCommandSpec[];
    provider?: string;
}): NativeCommandSpec[];
export declare function listNativeCommandSpecsForConfig(cfg: OpenClawConfig, params?: {
    skillCommands?: SkillCommandSpec[];
    provider?: string;
}): NativeCommandSpec[];
export declare function findCommandByNativeName(name: string, provider?: string, options?: NativeCommandProviderLookupOptions): ChatCommandDefinition | undefined;
export declare function buildCommandText(commandName: string, args?: string): string;
export declare function parseCommandArgs(command: ChatCommandDefinition, raw?: string): CommandArgs | undefined;
export declare function serializeCommandArgs(command: ChatCommandDefinition, args?: CommandArgs): string | undefined;
export declare function buildCommandTextFromArgs(command: ChatCommandDefinition, args?: CommandArgs): string;
export type ResolvedCommandArgChoice = {
    value: string;
    label: string;
};
export declare function resolveCommandArgChoices(params: {
    command: ChatCommandDefinition;
    arg: CommandArgDefinition;
    cfg?: OpenClawConfig;
    provider?: string;
    model?: string;
}): ResolvedCommandArgChoice[];
export declare function resolveCommandArgMenu(params: {
    command: ChatCommandDefinition;
    args?: CommandArgs;
    cfg?: OpenClawConfig;
    provider?: string;
    model?: string;
}): {
    arg: CommandArgDefinition;
    choices: ResolvedCommandArgChoice[];
    title?: string;
} | null;
export declare function formatCommandArgMenuTitle(params: {
    command: ChatCommandDefinition;
    menu: NonNullable<ReturnType<typeof resolveCommandArgMenu>>;
}): string;
export declare function isCommandMessage(raw: string): boolean;
export declare function isNativeCommandSurface(surface?: string): boolean;
export declare function shouldHandleTextCommands(params: ShouldHandleTextCommandsParams): boolean;
