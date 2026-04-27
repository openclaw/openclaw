import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { MsgContext } from "../templating.js";
export declare function isResetAuthorizedForContext(params: {
    ctx: MsgContext;
    cfg: OpenClawConfig;
    commandAuthorized: boolean;
}): boolean;
