import { loadJsonFile, saveJsonFile } from "../json-file.js";
import path from "node:path";

/**
 * Affiliate and Referral Manager for OpenClaw.
 * Tracks referral attributions for new user onboarding and skill purchases.
 */
export class ReferralManager {
    private referralPath: string;

    constructor(workspaceDir: string) {
        this.referralPath = path.join(workspaceDir, "billing", "referrals.json");
    }

    trackReferral(referringAgentId: string, newUserId: string) {
        const referrals: any = loadJsonFile(this.referralPath) || {};
        referrals[newUserId] = {
            referrer: referringAgentId,
            timestamp: Date.now(),
            status: "pending"
        };
        saveJsonFile(this.referralPath, referrals);
        console.info(`[affiliate] Tracked referral from ${referringAgentId} for user ${newUserId}`);
    }

    getReferrer(userId: string): string | null {
        const referrals: any = loadJsonFile(this.referralPath) || {};
        return referrals[userId]?.referrer || null;
    }
}
