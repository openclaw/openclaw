import { log } from "../../logging/log.js";

/**
 * API Usage Telemetry Monitor.
 * Tracks rate limit hits and token consumption per provider.
 * Helps agents and users proactively manage usage caps.
 */
export class ApiUsageMonitor {
    private providerStats = new Map<string, { rateLimits: number, totalTokens: number }>();

    recordRateLimit(providerId: string) {
        const stats = this.providerStats.get(providerId) || { rateLimits: 0, totalTokens: 0 };
        stats.rateLimits++;
        this.providerStats.set(providerId, stats);
        log.warn(`[telemetry] Provider ${providerId} hit a rate limit. Total hits: ${stats.rateLimits}`);
    }

    getReport() {
        return Object.fromEntries(this.providerStats);
    }
}
