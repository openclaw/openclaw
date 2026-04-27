import type { ExecToolDefaults } from "../../agents/bash-tools.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { InlineDirectives } from "./directive-handling.parse.js";
export type ReplyExecOverrides = Pick<ExecToolDefaults, "host" | "security" | "ask" | "node">;
export declare function resolveReplyExecOverrides(params: {
    directives: InlineDirectives;
    sessionEntry?: SessionEntry;
    agentExecDefaults?: ReplyExecOverrides;
}): ReplyExecOverrides | undefined;
