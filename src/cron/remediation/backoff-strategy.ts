/**
 * Implements exponential backoff for cron-triggered model API calls.
 * Addresses #54004 (MiniMax/Isolated session hangs).
 */
export async function executeWithCronBackoff<T>(
    task: () => Promise<T>,
    maxRetries: number = 3,
    initialDelayMs: number = 2000
): Promise<T> {
    let attempt = 0;
    while (attempt < maxRetries) {
        try {
            return await task();
        } catch (e) {
            attempt++;
            if (attempt >= maxRetries) throw e;
            const delay = initialDelayMs * Math.pow(2, attempt);
            console.warn(`[cron] API call failed. Retrying in ${delay}ms (attempt ${attempt}/${maxRetries})...`);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
    throw new Error("Cron backoff failed after max retries.");
}
