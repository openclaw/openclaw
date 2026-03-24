/**
 * Global Retry Handler for Model API calls.
 * Implements exponential backoff for 429 (Rate Limit) and 503 (Service Unavailable).
 * Specifically addresses #54060 class of bugs where fallbacks don't propagate correctly.
 */
export async function executeWithSmartRetry<T>(
    operation: () => Promise<T>,
    maxRetries: number = 3
): Promise<T> {
    let lastError: any;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            return await operation();
        } catch (error: any) {
            lastError = error;
            const status = error.status || error.response?.status;
            
            if (status === 429 || status === 503) {
                const delay = Math.pow(2, attempt) * 1000 + Math.random() * 1000;
                console.warn(`[api] Rate limit or timeout. Retrying in ${Math.round(delay)}ms (attempt ${attempt + 1}/${maxRetries})...`);
                await new Promise(resolve => setTimeout(resolve, delay));
                continue;
            }
            throw error; // Immediate fail for non-retryable errors
        }
    }
    throw lastError;
}
