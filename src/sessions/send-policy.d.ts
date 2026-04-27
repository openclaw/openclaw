import type { SessionChatType, SessionEntry } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
export type SessionSendPolicyDecision = "allow" | "deny";
export declare function normalizeSendPolicy(raw?: string | null): SessionSendPolicyDecision | undefined;
export declare function resolveSendPolicy(params: {
    cfg: OpenClawConfig;
    entry?: SessionEntry;
    sessionKey?: string;
    channel?: string;
    chatType?: SessionChatType;
}): SessionSendPolicyDecision;
