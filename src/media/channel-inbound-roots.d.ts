import type { MsgContext } from "../auto-reply/templating.js";
import type { OpenClawConfig } from "../config/types.js";
export declare function resolveChannelInboundAttachmentRoots(params: {
    cfg: OpenClawConfig;
    ctx: MsgContext;
}): readonly string[] | undefined;
export declare function resolveChannelRemoteInboundAttachmentRoots(params: {
    cfg: OpenClawConfig;
    ctx: MsgContext;
}): readonly string[] | undefined;
