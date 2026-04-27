import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ReplyPayload } from "../types.js";
export declare function createReplyMediaPathNormalizer(params: {
    cfg: OpenClawConfig;
    sessionKey?: string;
    agentId?: string;
    workspaceDir: string;
    messageProvider?: string;
    accountId?: string;
    groupId?: string;
    groupChannel?: string;
    groupSpace?: string;
    requesterSenderId?: string;
    requesterSenderName?: string;
    requesterSenderUsername?: string;
    requesterSenderE164?: string;
}): (payload: ReplyPayload) => Promise<ReplyPayload>;
export type ReplyMediaContext = {
    normalizePayload: (payload: ReplyPayload) => Promise<ReplyPayload>;
};
export declare function createReplyMediaContext(params: Parameters<typeof createReplyMediaPathNormalizer>[0]): ReplyMediaContext;
