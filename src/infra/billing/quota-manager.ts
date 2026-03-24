import { loadJsonFile, saveJsonFile } from "../json-file.js";
import path from "node:path";

/**
 * Usage Quota Manager for OpenClaw.
 * Enables usage-based billing and token caps for hosted agent instances.
 */
export class QuotaManager {
    private quotaPath: string;

    constructor(workspaceDir: string) {
        this.quotaPath = path.join(workspaceDir, "billing", "quotas.json");
    }

    checkQuota(userId: string, requestedTokens: number): boolean {
        const quotas: any = loadJsonFile(this.quotaPath) || {};
        const userQuota = quotas[userId] || { limit: 100000, used: 0 };
        
        if (userQuota.used + requestedTokens > userQuota.limit) {
            console.warn(`[billing] User ${userId} exceeded token quota.`);
            return false;
        }
        return true;
    }

    recordUsage(userId: string, tokens: number) {
        const quotas: any = loadJsonFile(this.quotaPath) || {};
        if (!quotas[userId]) quotas[userId] = { limit: 100000, used: 0 };
        quotas[userId].used += tokens;
        saveJsonFile(this.quotaPath, quotas);
    }
}
