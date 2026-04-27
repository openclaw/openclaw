import { type AuthCredentialReasonCode, ensureAuthProfileStore } from "../agents/auth-profiles.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { DoctorPrompter } from "./doctor-prompter.js";
export { maybeRepairLegacyOAuthProfileIds } from "./doctor-auth-legacy-oauth.js";
export declare function noteLegacyCodexProviderOverride(cfg: OpenClawConfig): void;
type AuthIssue = {
    profileId: string;
    provider: string;
    status: string;
    reasonCode?: AuthCredentialReasonCode;
    remainingMs?: number;
};
export declare function resolveUnusableProfileHint(params: {
    kind: "cooldown" | "disabled";
    reason?: string;
}): string;
export declare function formatOAuthRefreshFailureDoctorLine(params: {
    profileId: string;
    provider: string;
    message: string;
}): string | null;
export declare function resolveAuthIssueHint(issue: AuthIssue, cfg: OpenClawConfig, store: ReturnType<typeof ensureAuthProfileStore>): Promise<string | null>;
export declare function noteAuthProfileHealth(params: {
    cfg: OpenClawConfig;
    prompter: DoctorPrompter;
    allowKeychainPrompt: boolean;
}): Promise<void>;
