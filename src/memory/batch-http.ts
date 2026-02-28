import type { SsrFPolicy } from "../infra/net/ssrf.js";
import { retryAsync } from "../infra/retry.js";
import { postJson } from "./post-json.js";

export async function postJsonWithRetry<T>(params: {
  url: string;
  headers: Record<string, string>;
  ssrfPolicy?: SsrFPolicy;
  body: unknown;
  errorPrefix: string;
}): Promise<T> {
  return await retryAsync(
    async () => {
      return await postJson<T>({
        url: params.url,
        headers: params.headers,
        ssrfPolicy: params.ssrfPolicy,
        body: params.body,
        errorPrefix: params.errorPrefix,
        attachStatus: true,
        parse: async (payload) => payload as T,
      });
    },
    {
      attempts: 3,
      minDelayMs: 300,
      maxDelayMs: 2000,
      jitter: 0.2,
      shouldRetry: (err) => {
        const status = (err as { status?: number }).status;
        return status === 429 || (typeof status === "number" && status >= 500);
      },
    },
  );
}
