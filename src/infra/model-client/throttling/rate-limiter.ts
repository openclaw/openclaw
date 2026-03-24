/**
 * Client-Side API Rate Limiter.
 * Prevents overwhelming providers by enforcing local request spacing.
 */
export class ClientSideRateLimiter {
    private lastRequestTime = 0;
    private minSpacingMs = 1000; // Default: 1 request per second

    async waitIfNecessary() {
        const now = Date.now();
        const elapsed = now - this.lastRequestTime;
        if (elapsed < this.minSpacingMs) {
            const delay = this.minSpacingMs - elapsed;
            console.info(`[throttling] Spacing request. Waiting ${delay}ms...`);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
        this.lastRequestTime = Date.now();
    }

    setSpacing(ms: number) {
        this.minSpacingMs = ms;
    }
}
