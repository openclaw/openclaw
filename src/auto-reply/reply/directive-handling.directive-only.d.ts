import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { MsgContext } from "../templating.js";
import type { InlineDirectives } from "./directive-handling.parse.js";
export declare function isDirectiveOnly(params: {
    directives: InlineDirectives;
    cleanedBody: string;
    ctx: MsgContext;
    cfg: OpenClawConfig;
    agentId?: string;
    isGroup: boolean;
}): boolean;
