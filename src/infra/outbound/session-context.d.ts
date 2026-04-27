import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { SilentReplyConversationType } from "../../shared/silent-reply-policy.js";
export type OutboundSessionContext = {
    /** Canonical session key used for internal hook dispatch. */
    key?: string;
    /** Session key used for policy resolution when delivery differs from the control session. */
    policyKey?: string;
    /** Explicit conversation type for policy resolution when a session key is generic. */
    conversationType?: SilentReplyConversationType;
    /** Active agent id used for workspace-scoped media roots. */
    agentId?: string;
    /** Originating account id used for requester-scoped group policy resolution. */
    requesterAccountId?: string;
    /** Originating sender id used for sender-scoped outbound media policy. */
    requesterSenderId?: string;
    /** Originating sender display name for name-keyed sender policy matching. */
    requesterSenderName?: string;
    /** Originating sender username for username-keyed sender policy matching. */
    requesterSenderUsername?: string;
    /** Originating sender E.164 phone number for e164-keyed sender policy matching. */
    requesterSenderE164?: string;
};
export declare function buildOutboundSessionContext(params: {
    cfg: OpenClawConfig;
    sessionKey?: string | null;
    policySessionKey?: string | null;
    conversationType?: string | null;
    isGroup?: boolean | null;
    agentId?: string | null;
    requesterAccountId?: string | null;
    requesterSenderId?: string | null;
    requesterSenderName?: string | null;
    requesterSenderUsername?: string | null;
    requesterSenderE164?: string | null;
}): OutboundSessionContext | undefined;
