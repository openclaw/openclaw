import type { ReplyPayload } from "../types.js";
import type { CommandHandler, HandleCommandsParams } from "./commands-types.js";
export declare function buildTasksText(params: {
    sessionKey: string;
    agentId: string;
}): string;
export declare function buildTasksReply(params: HandleCommandsParams): Promise<ReplyPayload>;
export declare const handleTasksCommand: CommandHandler;
