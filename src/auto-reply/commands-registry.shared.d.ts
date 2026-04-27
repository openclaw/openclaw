import type { ChatCommandDefinition, CommandCategory, CommandScope, CommandTier } from "./commands-registry.types.js";
type DefineChatCommandInput = {
    key: string;
    nativeName?: string;
    description: string;
    args?: ChatCommandDefinition["args"];
    argsParsing?: ChatCommandDefinition["argsParsing"];
    formatArgs?: ChatCommandDefinition["formatArgs"];
    argsMenu?: ChatCommandDefinition["argsMenu"];
    acceptsArgs?: boolean;
    textAlias?: string;
    textAliases?: string[];
    scope?: CommandScope;
    category?: CommandCategory;
    /** Progressive disclosure tier. Defaults to "standard". */
    tier?: CommandTier;
};
export declare function defineChatCommand(command: DefineChatCommandInput): ChatCommandDefinition;
export declare function registerAlias(commands: ChatCommandDefinition[], key: string, ...aliases: string[]): void;
export declare function assertCommandRegistry(commands: ChatCommandDefinition[]): void;
export declare function buildBuiltinChatCommands(): ChatCommandDefinition[];
export {};
