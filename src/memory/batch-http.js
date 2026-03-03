import { retryAsync } from "../infra/retry.js";
import { postJson } from "./post-json.js";
export async function postJsonWithRetry(params) {
    return await retryAsync(async () => {
        return await postJson({
            url: params.url,
            headers: params.headers,
            ssrfPolicy: params.ssrfPolicy,
            body: params.body,
            errorPrefix: params.errorPrefix,
            attachStatus: true,
            parse: async (payload) => payload,
        });
    }, {
        attempts: 3,
        minDelayMs: 300,
        maxDelayMs: 2000,
        jitter: 0.2,
        shouldRetry: (err) => {
            const status = err.status;
            return status === 429 || (typeof status === "number" && status >= 500);
        },
    });
}
