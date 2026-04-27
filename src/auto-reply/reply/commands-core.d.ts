import type { CommandHandlerResult, HandleCommandsParams } from "./commands-types.js";
export { emitResetCommandHooks } from "./commands-reset-hooks.js";
export declare function handleCommands(params: HandleCommandsParams): Promise<CommandHandlerResult>;
