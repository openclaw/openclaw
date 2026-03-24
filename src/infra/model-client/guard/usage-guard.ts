import { ApiUsageMonitor } from "../../telemetry/api-monitor.js";

/**
 * Proactive Usage Guard for Model APIs.
 * Prevents triggering 429s by checking telemetry before execution.
 * Addresses the 'API usage limit' failures.
 */
export class UsageGuard {
    constructor(private monitor: ApiUsageMonitor) {}

    async checkAndThrottle(providerId: string) {
        const stats = this.monitor.getReport()[providerId];
        
        // If we've hit rate limits recently, enforce a strict pause
        if (stats && stats.rateLimits > 0) {
            const cooldownMs = Math.min(stats.rateLimits * 5000, 60000); // Up to 1 min cooldown
            console.warn(`[guard] Provider ${providerId} has recent rate limit history. Enforcing ${cooldownMs}ms proactive cooldown...`);
            await new Promise(resolve => setTimeout(resolve, cooldownMs));
        }
    }
}
