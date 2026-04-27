import type { EffectiveToolInventoryResult } from "../agents/tools-effective-inventory.types.js";
export { buildCommandsMessage, buildCommandsMessagePaginated, buildHelpMessage, type CommandsMessageOptions, type CommandsMessageResult, } from "./command-status-builders.js";
export { buildStatusMessage, formatContextUsageShort, formatTokenCount, type StatusArgs, } from "../status/status-message.js";
export declare function buildToolsMessage(result: EffectiveToolInventoryResult, options?: {
    verbose?: boolean;
}): string;
